import type { Bundle } from "./bundle";
import { PRESETS, blowOutSaturated, colourLevels, fillPinholes, windowMean, type Mix } from "./colour";
import { FLAG_OK, REFERENCE_BANDS, type Point } from "./spectra";
import { ASINH_BETA, type StretchKind } from "./stretch";
import { formatNumber, niceTicks, robustRange } from "./ticks";

type Cube = NonNullable<Bundle["cube"]>;

export type ExportFormat = "png" | "gif";
export type ExportLayout = "current" | "presets-grid";

export interface ExportOptions {
  format: ExportFormat;
  layout: ExportLayout;
  includeHeader: boolean;
  includeFooter: boolean;
  includeOverlays: boolean;
  includeSpectrum: boolean;
}

const VISIT_COLOURS = ["#38bdf8", "#fbbf24", "#34d399", "#f472b6", "#a78bfa", "#fb7185"];
const DETECTOR_BANDS = [
  { id: "D1", lo: 0.74, hi: 1.12 },
  { id: "D2", lo: 1.10, hi: 1.65 },
  { id: "D3", lo: 1.64, hi: 2.44 },
  { id: "D4", lo: 2.42, hi: 3.83 },
  { id: "D5", lo: 3.81, hi: 4.43 },
  { id: "D6", lo: 4.42, hi: 5.01 },
];

/** Render one 3-window colour mix using the exact Lupton et al. (2004) asinh/log/linear stretch from renderer.ts. */
export function renderColourMixRgba(cube: Cube, mix: Mix, stretch: StretchKind): Uint8ClampedArray {
  const n = cube.n;
  const filled = fillPinholes([windowMean(cube, mix.r), windowMean(cube, mix.g), windowMean(cube, mix.b)], n);
  const lv = colourLevels(filled, 1, 99.6, "balanced");
  const { planes } = blowOutSaturated(filled, n, lv.white);
  const [r, g, b] = planes;

  const out = new Uint8ClampedArray(n * n * 4);
  const logDen = Math.log(1 + ASINH_BETA);
  const asinhDen = Math.asinh(ASINH_BETA);

  // Cube row 0 is south (bottom); canvas y=0 is top, so flip vertically when writing RGBA.
  for (let py = 0; py < n; py++) {
    const sy = n - 1 - py;
    for (let px = 0; px < n; px++) {
      const si = sy * n + px;
      const di = (py * n + px) * 4;
      const rv = r[si];
      const gv = g[si];
      const bv = b[si];
      if (!Number.isFinite(rv) || !Number.isFinite(gv) || !Number.isFinite(bv)) {
        out[di] = 6;
        out[di + 1] = 10;
        out[di + 2] = 16;
        out[di + 3] = 255;
        continue;
      }
      const xr = Math.max(0, (rv - lv.black[0]) / Math.max(lv.white[0] - lv.black[0], 1e-12));
      const xg = Math.max(0, (gv - lv.black[1]) / Math.max(lv.white[1] - lv.black[1], 1e-12));
      const xb = Math.max(0, (bv - lv.black[2]) / Math.max(lv.white[2] - lv.black[2], 1e-12));

      let cr: number;
      let cg: number;
      let cb: number;
      if (stretch === "linear") {
        cr = Math.min(1, xr);
        cg = Math.min(1, xg);
        cb = Math.min(1, xb);
      } else {
        const I = (xr + xg + xb) / 3;
        const k =
          I > 1e-6
            ? stretch === "log"
              ? Math.log(1 + ASINH_BETA * I) / (logDen * I)
              : Math.asinh(ASINH_BETA * I) / (asinhDen * I)
            : 0;
        cr = xr * k;
        cg = xg * k;
        cb = xb * k;
        const m = Math.max(cr, cg, cb);
        if (m > 1) {
          cr /= m;
          cg /= m;
          cb /= m;
        }
      }
      out[di] = Math.round(cr * 255);
      out[di + 1] = Math.round(cg * 255);
      out[di + 2] = Math.round(cb * 255);
      out[di + 3] = 255;
    }
  }
  return out;
}

/** Draw all 4 colour presets in a clean 2x2 grid with dedicated tile headers (no text over stars). */
export function drawPresetGrid(
  ctx: CanvasRenderingContext2D,
  cube: Cube,
  stretch: StretchKind,
  smooth: boolean,
  x: number,
  y: number,
  totalW: number,
  totalH: number,
): void {
  const gap = 10;
  const tileBarH = 24;
  const cellW = Math.floor((totalW - gap) / 2);
  const cellImgH = Math.floor((totalH - gap) / 2) - tileBarH;
  const cellSize = Math.min(cellW, cellImgH);
  const gridW = cellSize * 2 + gap;
  const gridH = (cellSize + tileBarH) * 2 + gap;
  const startX = x + Math.floor((totalW - gridW) / 2);
  const startY = y + Math.floor((totalH - gridH) / 2);

  const off = document.createElement("canvas");
  off.width = cube.n;
  off.height = cube.n;
  const octx = off.getContext("2d");
  if (!octx) return;

  PRESETS.slice(0, 4).forEach((preset, idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const tx = startX + col * (cellSize + gap);
    const ty = startY + row * (cellSize + tileBarH + gap);

    ctx.fillStyle = "#0b111d";
    ctx.fillRect(tx, ty, cellSize, tileBarH);
    ctx.strokeStyle = "rgba(56, 189, 248, 0.2)";
    ctx.strokeRect(tx + 0.5, ty + 0.5, cellSize - 1, cellSize + tileBarH - 1);

    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText(`${idx + 1}. ${preset.name}`, tx + 8, ty + 16, cellSize - 16);

    const rgba = renderColourMixRgba(cube, preset.mix, stretch);
    const imgData = octx.createImageData(cube.n, cube.n);
    imgData.data.set(rgba);
    octx.putImageData(imgData, 0, 0);

    ctx.save();
    ctx.imageSmoothingEnabled = smooth;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(off, tx + 1, ty + tileBarH, cellSize - 2, cellSize - 2);
    ctx.restore();
  });
}

/** Draw a crisp dark-themed 0.75-5.0 um spectrum panel below the sky image. */
export function drawSpectrumChart(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  title: string,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  ctx.fillStyle = "#070b12";
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = "rgba(56, 189, 248, 0.18)";
  ctx.fillRect(x, y, width, 1);

  const padL = 56;
  const padR = 18;
  const padT = 30;
  const padB = 30;
  const pw = Math.max(40, width - padL - padR);
  const ph = Math.max(40, height - padT - padB);

  ctx.font = "600 12px system-ui, sans-serif";
  ctx.fillStyle = "#e2e8f0";
  ctx.fillText(`Spectrum · ${title}`, x + 12, y + 19, width - 24);

  const clean = points.filter((p) => Number.isFinite(p.wl) && Number.isFinite(p.flux) && p.flag === FLAG_OK);
  const all = points.filter((p) => Number.isFinite(p.wl) && Number.isFinite(p.flux));
  const use = clean.length >= 2 ? clean : all;
  if (!use.length) {
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillStyle = "#94a3b8";
    ctx.fillText("No valid spectral points available for this source.", x + padL, y + padT + ph / 2);
    return;
  }

  const [yLo, yHi] = robustRange(use.map((p) => p.flux));
  const wlMin = 0.72;
  const wlMax = 5.05;
  const sx = (wl: number) => x + padL + ((wl - wlMin) / (wlMax - wlMin)) * pw;
  const sy = (f: number) => y + padT + ph - ((f - yLo) / Math.max(yHi - yLo, 1e-12)) * ph;

  // Detector bands background
  DETECTOR_BANDS.forEach((d, idx) => {
    const x0 = sx(d.lo);
    const x1 = sx(d.hi);
    ctx.fillStyle = idx % 2 === 0 ? "rgba(255,255,255,0.025)" : "rgba(56,189,248,0.02)";
    ctx.fillRect(x0, y + padT, x1 - x0, ph);
    ctx.font = "10px ui-monospace, Consolas, monospace";
    ctx.fillStyle = "rgba(148,163,184,0.55)";
    ctx.fillText(d.id, (x0 + x1) / 2 - 6, y + padT + 11);
  });

  // Reference molecular bands (H2O, CH4, CO2, CO)
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = "rgba(148, 163, 184, 0.25)";
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillStyle = "rgba(148, 163, 184, 0.75)";
  REFERENCE_BANDS.forEach((b) => {
    const bx = sx(b.wl);
    ctx.beginPath();
    ctx.moveTo(bx, y + padT + 14);
    ctx.lineTo(bx, y + padT + ph);
    ctx.stroke();
    ctx.fillText(b.label, bx - 9, y + padT + ph - 5);
  });
  ctx.restore();

  // Axes & Y ticks
  ctx.strokeStyle = "rgba(148, 163, 184, 0.28)";
  ctx.beginPath();
  ctx.moveTo(x + padL, y + padT);
  ctx.lineTo(x + padL, y + padT + ph);
  ctx.lineTo(x + padL + pw, y + padT + ph);
  ctx.stroke();

  ctx.font = "10px ui-monospace, Consolas, monospace";
  ctx.fillStyle = "#94a3b8";
  niceTicks(yLo, yHi, 4).forEach((t) => {
    const ty = sy(t);
    if (ty < y + padT || ty > y + padT + ph) return;
    ctx.strokeStyle = "rgba(148,163,184,0.1)";
    ctx.beginPath();
    ctx.moveTo(x + padL, ty);
    ctx.lineTo(x + padL + pw, ty);
    ctx.stroke();
    ctx.fillText(formatNumber(t), x + 8, ty + 3, padL - 12);
  });

  [1, 2, 3, 4, 5].forEach((wl) => {
    const tx = sx(wl);
    ctx.fillText(`${wl} µm`, tx - 12, y + padT + ph + 16);
  });
  ctx.fillText("mJy", x + 10, y + padT + 10);

  // Data points + error bars
  all.forEach((p) => {
    const ok = p.flag === FLAG_OK;
    const px = sx(p.wl);
    const py = Math.max(y + padT, Math.min(y + padT + ph, sy(p.flux)));
    const col = VISIT_COLOURS[Math.max(0, p.epoch) % VISIT_COLOURS.length];
    if (Number.isFinite(p.err) && p.err > 0 && ok) {
      const pyTop = Math.max(y + padT, sy(p.flux + p.err));
      const pyBot = Math.min(y + padT + ph, sy(p.flux - p.err));
      ctx.strokeStyle = `${col}66`;
      ctx.beginPath();
      ctx.moveTo(px, pyTop);
      ctx.lineTo(px, pyBot);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(px, py, ok ? 2.6 : 2.3, 0, Math.PI * 2);
    if (ok) {
      ctx.fillStyle = col;
      ctx.fill();
    } else {
      ctx.strokeStyle = col;
      ctx.stroke();
    }
  });
}

export function composePngFigure(params: {
  baseRgba?: { width: number; height: number; rgba: Uint8ClampedArray } | null;
  cube?: Cube | null;
  stretch: StretchKind;
  smooth: boolean;
  options: ExportOptions;
  headerText: string;
  footerText: string;
  spectrum?: { title: string; points: Point[] } | null;
}): HTMLCanvasElement | null {
  const { baseRgba, cube, stretch, smooth, options, headerText, footerText, spectrum } = params;
  const isGrid = options.layout === "presets-grid" && !!cube;
  if (!isGrid && !baseRgba) return null;

  const contentW = isGrid ? 880 : baseRgba!.width;
  const contentH = isGrid ? 880 : baseRgba!.height;
  const headerH = options.includeHeader ? 34 : 0;
  const specH = options.includeSpectrum && spectrum ? 230 : 0;
  const footerH = options.includeFooter ? 26 : 0;

  const canvas = document.createElement("canvas");
  canvas.width = contentW;
  canvas.height = headerH + contentH + specH + footerH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#05070b";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (options.includeHeader) {
    ctx.fillStyle = "#070b12";
    ctx.fillRect(0, 0, canvas.width, headerH);
    ctx.fillStyle = "rgba(56, 189, 248, 0.2)";
    ctx.fillRect(0, headerH - 1, canvas.width, 1);
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.fillStyle = "#f1f5f9";
    ctx.fillText(headerText, 12, headerH - 11, canvas.width - 24);
  }

  if (isGrid && cube) {
    drawPresetGrid(ctx, cube, stretch, smooth, 0, headerH, contentW, contentH);
  } else if (baseRgba) {
    const tmp = document.createElement("canvas");
    tmp.width = baseRgba.width;
    tmp.height = baseRgba.height;
    const tctx = tmp.getContext("2d");
    if (tctx) {
      const id = tctx.createImageData(baseRgba.width, baseRgba.height);
      id.data.set(baseRgba.rgba);
      tctx.putImageData(id, 0, 0);
      ctx.drawImage(tmp, 0, headerH);
    }
  }

  if (options.includeSpectrum && spectrum) {
    drawSpectrumChart(ctx, spectrum.points, spectrum.title, 0, headerH + contentH, canvas.width, specH);
  }

  if (options.includeFooter) {
    const fy = headerH + contentH + specH;
    ctx.fillStyle = "#070b12";
    ctx.fillRect(0, fy, canvas.width, footerH);
    ctx.fillStyle = "rgba(56, 189, 248, 0.16)";
    ctx.fillRect(0, fy, canvas.width, 1);
    ctx.font = "11px ui-monospace, Consolas, monospace";
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(footerText, 12, fy + footerH - 8, canvas.width - 24);
  }

  return canvas;
}
