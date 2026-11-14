// One WebGL2 renderer: every frame of a bundle lives in an R32F TEXTURE_2D_ARRAY (nearest sampling;
// the data is undersampled, so smoothing would invent detail). NaN pixels are replaced by a sentinel
// on upload and drawn in a flat "no data" colour.
import { buildLut, type ColormapName } from "./colormaps";
import { ASINH_BETA, type StretchKind } from "../lib/stretch";

export const NODATA = -1e30;

const VERT = `#version 300 es
in vec2 aPos;
uniform vec2 uScale;   // data-pixels -> clip
uniform vec2 uOffset;
uniform vec2 uSize;    // texture size in pixels
out vec2 vUv;
void main() {
  vec2 px = (aPos * 0.5 + 0.5) * uSize;      // 0..W, 0..H in data pixels
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(px * uScale + uOffset, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
uniform sampler2DArray uFrames;
uniform sampler2D uLut;
uniform sampler2D uDivLut;
uniform int uMode;        // 0 = single frame, 1 = difference A - B
uniform int uLayerA;
uniform int uLayerB;
uniform float uBlack;
uniform float uWhite;
uniform float uLimit;
uniform int uStretch;     // 0 = asinh, 1 = linear
uniform float uBeta;
uniform float uMix;       // crossfade weight toward uLayerB in single mode (0 = hard cut)
uniform vec3 uNoData;
uniform float uGrid;      // >0 draws the pixel grid at this screen-pixel size
out vec4 outColor;

float stretch01(float x) {
  x = clamp(x, 0.0, 1.0);
  return uStretch == 1 ? x : asinh(x * uBeta) / asinh(uBeta);
}

void main() {
  float a = texture(uFrames, vec3(vUv, float(uLayerA))).r;
  vec3 col;
  if (uMode == 1) {
    float b = texture(uFrames, vec3(vUv, float(uLayerB))).r;
    if (a < -1e29 || b < -1e29) { outColor = vec4(uNoData, 1.0); return; }
    float x = clamp((a - b) / uLimit, -1.0, 1.0);
    float y = uStretch == 1 ? x : sign(x) * asinh(abs(x) * uBeta) / asinh(uBeta);
    col = texture(uDivLut, vec2(y * 0.5 + 0.5, 0.5)).rgb;
  } else {
    if (a < -1e29) { outColor = vec4(uNoData, 1.0); return; }
    float v = a;
    if (uMix > 0.0) {
      float b = texture(uFrames, vec3(vUv, float(uLayerB))).r;
      if (b > -1e29) v = mix(a, b, uMix);
    }
    col = texture(uLut, vec2(stretch01((v - uBlack) / (uWhite - uBlack)), 0.5)).rgb;
  }
  if (uGrid > 0.0) {
    vec2 f = fract(vUv * vec2(textureSize(uFrames, 0).xy));
    vec2 edge = min(f, 1.0 - f) * uGrid;
    if (min(edge.x, edge.y) < 0.5) col = mix(col, vec3(0.22, 0.74, 0.97), 0.25);
  }
  outColor = vec4(col, 1.0);
}`;

export interface DrawParams {
  mode: "single" | "diff";
  layerA: number;
  layerB: number;
  black: number;
  white: number;
  limit: number;
  stretch: StretchKind;
  mix: number;
  colormap: ColormapName;
  /** screen pixels per data pixel */
  zoom: number;
  /** data-pixel coordinate at the canvas centre */
  centerX: number;
  centerY: number;
  pixelGrid: boolean;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture | null = null;
  private lut: WebGLTexture;
  private divLut: WebGLTexture;
  private lutName: ColormapName | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  width = 0;
  height = 0;
  layers = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
    this.prog = link(gl, VERT, FRAG);
    gl.useProgram(this.prog);
    for (const n of ["uScale", "uOffset", "uSize", "uFrames", "uLut", "uDivLut", "uMode", "uLayerA", "uLayerB",
      "uBlack", "uWhite", "uLimit", "uStretch", "uBeta", "uMix", "uNoData", "uGrid"]) {
      this.loc[n] = gl.getUniformLocation(this.prog, n);
    }
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(this.prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    this.lut = makeLutTexture(gl, buildLut("gray"));
    this.divLut = makeLutTexture(gl, buildLut("diverging"));
  }

  /** Upload all planes (each width*height float32). NaN -> sentinel. */
  upload(planes: Float32Array[], width: number, height: number): void {
    const gl = this.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    this.tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R32F, width, height, Math.max(1, planes.length));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const tmp = new Float32Array(width * height);
    planes.forEach((p, i) => {
      for (let k = 0; k < tmp.length; k++) tmp[k] = Number.isFinite(p[k]) ? p[k] : NODATA;
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, width, height, 1, gl.RED, gl.FLOAT, tmp);
    });
    this.width = width;
    this.height = height;
    this.layers = planes.length;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  draw(p: DrawParams): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.02, 0.027, 0.043, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.tex || !this.layers) return;
    if (p.colormap !== this.lutName) {
      gl.deleteTexture(this.lut);
      this.lut = makeLutTexture(gl, buildLut(p.colormap));
      this.lutName = p.colormap;
    }
    gl.useProgram(this.prog);
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth || this.canvas.width);
    const z = p.zoom * dpr;
    const sx = (2 * z) / this.canvas.width;
    const sy = (2 * z) / this.canvas.height;
    gl.uniform2f(this.loc.uScale, sx, sy);
    gl.uniform2f(this.loc.uOffset, -p.centerX * sx, -p.centerY * sy);
    gl.uniform2f(this.loc.uSize, this.width, this.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.uniform1i(this.loc.uFrames, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.uniform1i(this.loc.uLut, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.divLut);
    gl.uniform1i(this.loc.uDivLut, 2);
    gl.uniform1i(this.loc.uMode, p.mode === "diff" ? 1 : 0);
    gl.uniform1i(this.loc.uLayerA, clampLayer(p.layerA, this.layers));
    gl.uniform1i(this.loc.uLayerB, clampLayer(p.layerB, this.layers));
    gl.uniform1f(this.loc.uBlack, p.black);
    gl.uniform1f(this.loc.uWhite, p.white);
    gl.uniform1f(this.loc.uLimit, p.limit);
    gl.uniform1i(this.loc.uStretch, p.stretch === "linear" ? 1 : 0);
    gl.uniform1f(this.loc.uBeta, ASINH_BETA);
    gl.uniform1f(this.loc.uMix, p.mix);
    gl.uniform3f(this.loc.uNoData, 0.09, 0.07, 0.12);
    gl.uniform1f(this.loc.uGrid, p.pixelGrid && z >= 12 ? z : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose(): void {
    const gl = this.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    gl.deleteTexture(this.lut);
    gl.deleteTexture(this.divLut);
    gl.deleteProgram(this.prog);
  }
}

const clampLayer = (i: number, n: number) => Math.max(0, Math.min(n - 1, i | 0));

function makeLutTexture(gl: WebGL2RenderingContext, data: Uint8Array): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader compile failed");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link failed");
  return p;
}
