import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Renderer, type DrawParams } from "../gl/renderer";
import type { Bundle } from "../lib/bundle";
import { mjdToYear, propagate } from "../lib/astro";
import { formatDec, formatRa, pixelToWorld, worldToPixel } from "../lib/wcs";
import type { Step } from "../lib/sequence";
import { allPlanes } from "../lib/sequence";

/** Gaia markers down to this G magnitude (fainter ones crowd the view and are mostly below SPHEREx's single-visit depth). */
export const GAIA_G_LIMIT = 16;

export interface View {
  zoom: number; // CSS px per data px
  cx: number;
  cy: number;
}

export interface SkyCanvasHandle {
  resetView(): void;
  view(): View;
  redraw(): void;
}

interface Props {
  bundle: Bundle;
  draw: Omit<DrawParams, "zoom" | "centerX" | "centerY">;
  /** the frame on screen: sets the date for Gaia markers */
  step: Step | null;
  /** for difference mode: dates of both frames */
  diffMjds?: [number, number];
  showGaia: boolean;
  handleRef?: Ref<SkyCanvasHandle>;
  onHover?: (info: HoverInfo | null) => void;
  /** value lookup for hover readout */
  valueAt?: (x: number, y: number) => number | null;
  /** click (not drag) at a data-pixel position */
  onPick?: (x: number, y: number) => void;
  /** highlighted source (moves with the frame date) */
  selected?: MovingSource | null;
  /** measured positions to mark (data pixels) */
  marks?: { x: number; y: number; label: string }[];
  /** colour mode: three planes on the cube grid */
  colour?: { planes: [Float32Array, Float32Array, Float32Array]; n: number } | null;
  /** date for the overlays when no frame/difference is shown (colour mode) */
  overlayMjd?: number;
  /** text alternative for screen readers */
  ariaLabel?: string;
}

export interface MovingSource {
  ra: number;
  dec: number;
  pmra: number;
  pmdec: number;
  ref_year: number;
}

export interface HoverInfo {
  x: number;
  y: number;
  ra: number;
  dec: number;
  value: number | null;
}

export function SkyCanvas({ bundle, draw, step, diffMjds, showGaia, handleRef, onHover, valueAt, onPick, selected, marks, colour, overlayMjd, ariaLabel }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const ovRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const uploaded = useRef<Bundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewRef = useRef<View>({ zoom: 4, cx: 0, cy: 0 });
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);

  const fit = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const z = Math.min(el.clientWidth / bundle.width, el.clientHeight / bundle.height) * 0.94;
    viewRef.current = { zoom: Math.max(0.5, z), cx: bundle.width / 2, cy: bundle.height / 2 };
  }, [bundle]);

  // renderer + upload
  useEffect(() => {
    const c = glRef.current!;
    try {
      const r = rendererRef.current ?? new Renderer(c);
      rendererRef.current = r;
      r.upload(allPlanes(bundle), bundle.width, bundle.height);
      uploaded.current = bundle;
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
    fit();
    bump();
  }, [bundle, fit]);

  useEffect(
    () => () => {
      rendererRef.current?.dispose();
      rendererRef.current = null; // StrictMode remounts: the next effect builds a fresh one
    },
    [],
  );

  const paint = useCallback(() => {
    let r = rendererRef.current;
    if (!r && glRef.current) {
      // remounted after a dispose (StrictMode / HMR): rebuild and re-upload
      try {
        r = rendererRef.current = new Renderer(glRef.current);
        r.upload(allPlanes(bundle), bundle.width, bundle.height);
        uploaded.current = bundle;
      } catch {
        return;
      }
    }
    const wrap = wrapRef.current;
    const ov = ovRef.current;
    if (!r || !wrap || !ov) return;
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    r.resize(W, H, dpr);
    const v = viewRef.current;
    r.draw({ ...draw, zoom: v.zoom, centerX: v.cx, centerY: v.cy });
    drawOverlay(ov, W, H, dpr, v, bundle, step, diffMjds, showGaia, selected ?? null, marks ?? [], overlayMjd);
  }, [draw, bundle, step, diffMjds, showGaia, selected, marks, overlayMjd]);

  // colour planes change only when the mix changes
  const uploadedColour = useRef<{ colour: unknown; r: Renderer } | null>(null);
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !colour) return;
    const u = uploadedColour.current;
    if (u && u.colour === colour && u.r === r) return; // also re-upload if the renderer was rebuilt
    r.uploadColour(colour.planes, colour.n);
    uploadedColour.current = { colour, r };
    paint();
  });

  useEffect(() => {
    paint();
  });

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => paint());
    ro.observe(el);
    return () => ro.disconnect();
  }, [paint]);

  useImperativeHandle(handleRef, () => ({
    resetView: () => {
      fit();
      bump();
    },
    view: () => ({ ...viewRef.current }),
    redraw: paint,
  }));

  // screen <-> data pixel (data y grows up; screen y grows down)
  const toData = (sx: number, sy: number) => {
    const el = wrapRef.current!;
    const v = viewRef.current;
    return [v.cx + (sx - el.clientWidth / 2) / v.zoom, v.cy - (sy - el.clientHeight / 2) / v.zoom] as const;
  };

  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);

  return (
    <div
      ref={wrapRef}
      role="img"
      aria-label={ariaLabel}
      className="relative h-full w-full cursor-crosshair touch-none select-none overflow-hidden"
      onWheel={(e) => {
        const rect = wrapRef.current!.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const [dx, dy] = toData(sx, sy);
        const v = viewRef.current;
        const z = Math.min(64, Math.max(0.5, v.zoom * Math.exp(-e.deltaY * 0.0015)));
        // keep the data point under the cursor fixed
        v.cx = dx - (sx - rect.width / 2) / z;
        v.cy = dy + (sy - rect.height / 2) / z;
        v.zoom = z;
        bump();
      }}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, cx: viewRef.current.cx, cy: viewRef.current.cy, moved: false };
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved && onPick) {
          const rect = wrapRef.current!.getBoundingClientRect();
          const [x, y] = toData(e.clientX - rect.left, e.clientY - rect.top);
          onPick(x - 0.5, y - 0.5); // continuous -> pixel-centre convention
        }
      }}
      onPointerLeave={() => onHover?.(null)}
      onPointerMove={(e) => {
        const d = drag.current;
        const v = viewRef.current;
        if (d && !d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
        if (d && d.moved) {
          v.cx = d.cx - (e.clientX - d.x) / v.zoom;
          v.cy = d.cy + (e.clientY - d.y) / v.zoom;
          bump();
        }
        if (onHover) {
          const rect = wrapRef.current!.getBoundingClientRect();
          const [x, y] = toData(e.clientX - rect.left, e.clientY - rect.top);
          if (x < 0 || y < 0 || x >= bundle.width || y >= bundle.height) return onHover(null);
          const [ra, dec] = pixelToWorld(bundle.meta.wcs, x - 0.5, y - 0.5);
          onHover({ x: Math.floor(x), y: Math.floor(y), ra, dec, value: valueAt ? valueAt(Math.floor(x), Math.floor(y)) : null });
        }
      }}
    >
      <canvas ref={glRef} className="absolute inset-0 h-full w-full" />
      <canvas ref={ovRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      {error && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-rose-300">
          Can't draw the sky: {error}
        </div>
      )}
    </div>
  );
}

function drawOverlay(
  ov: HTMLCanvasElement,
  W: number,
  H: number,
  dpr: number,
  v: View,
  b: Bundle,
  step: Step | null,
  diffMjds: [number, number] | undefined,
  showGaia: boolean,
  selected: MovingSource | null,
  marks: { x: number; y: number; label: string }[],
  overlayMjd?: number,
) {
  const w = Math.round(W * dpr);
  const h = Math.round(H * dpr);
  if (ov.width !== w || ov.height !== h) {
    ov.width = w;
    ov.height = h;
  }
  const ctx = ov.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  // data pixel centre (x, y) -> screen; the texture spans 0..W in data coords, pixel i centred at i+0.5
  const toScreen = (x: number, y: number): [number, number] => [W / 2 + (x + 0.5 - v.cx) * v.zoom, H / 2 - (y + 0.5 - v.cy) * v.zoom];
  const sky = (ra: number, dec: number) => toScreen(...worldToPixel(b.meta.wcs, ra, dec));
  const t = b.meta.target;

  // field border
  const [x0, y0] = toScreen(-0.5, -0.5);
  const [x1, y1] = toScreen(b.width - 0.5, b.height - 0.5);
  ctx.strokeStyle = "rgba(148,163,184,0.18)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y1, x1 - x0, y0 - y1);

  const years = diffMjds ? diffMjds.map(mjdToYear) : step ? [mjdToYear(step.mjd)] : overlayMjd !== undefined ? [mjdToYear(overlayMjd)] : [];

  if (showGaia && years.length) {
    const yr = years[years.length - 1];
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y1, x1 - x0, y0 - y1); // only inside the image
    ctx.clip();
    ctx.strokeStyle = "rgba(134,239,172,0.38)";
    ctx.lineWidth = 1;
    for (const s of b.gaia.stars) {
      if (s.g === null || s.g > GAIA_G_LIMIT) continue;
      // brighter stars get bigger circles
      const r = Math.max(3, (0.6 + (GAIA_G_LIMIT - s.g) * 0.12) * v.zoom);
      const [ra, dec] = propagate(s.ra, s.dec, s.pmra, s.pmdec, b.gaia.ref_year, yr);
      const [sx, sy] = sky(ra, dec);
      if (sx < -20 || sy < -20 || sx > W + 20 || sy > H + 20) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // target track 2010 -> now, and the target's position at each shown date
  const [tx0, ty0] = sky(...t.pos_2010);
  const [tx1, ty1] = sky(...t.pos_now);
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(251,191,36,0.45)";
  ctx.beginPath();
  ctx.moveTo(tx0, ty0);
  ctx.lineTo(tx1, ty1);
  ctx.stroke();
  ctx.setLineDash([]);
  const colors = ["#fbbf24", "#22d3ee"];
  years.forEach((yr, i) => {
    const [ra, dec] = propagate(t.ra, t.dec, t.pmra, t.pmdec, t.ref_year, yr);
    const [sx, sy] = sky(ra, dec);
    const g = Math.max(7, 2.2 * v.zoom);
    ctx.strokeStyle = colors[i];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const [a, c] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      ctx.moveTo(sx + a * g, sy + c * g);
      ctx.lineTo(sx + a * g * 2, sy + c * g * 2);
    }
    ctx.stroke();
  });

  // selected source: a ring at its catalogue position for the shown date
  if (selected && years.length) {
    const [ra, dec] = propagate(selected.ra, selected.dec, selected.pmra, selected.pmdec, selected.ref_year, years[years.length - 1]);
    const [sx, sy] = sky(ra, dec);
    ctx.strokeStyle = "#f0efec";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(10, 3.2 * v.zoom), 0, Math.PI * 2);
    ctx.stroke();
  }
  // measured centroids
  ctx.font = "10px ui-monospace, Consolas, monospace";
  for (const m of marks) {
    const [sx, sy] = toScreen(m.x, m.y);
    ctx.strokeStyle = ctx.fillStyle = "#e879f9";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx - 4, sy - 4);
    ctx.lineTo(sx + 4, sy + 4);
    ctx.moveTo(sx + 4, sy - 4);
    ctx.lineTo(sx - 4, sy + 4);
    ctx.stroke();
    ctx.fillText(m.label, sx + 6, sy - 6);
  }

  // scale bar (1 arcmin) and compass, bottom left
  const pxPerArcmin = (60 / b.meta.pixel_scale_arcsec) * v.zoom;
  let len = pxPerArcmin;
  let lab = "1′";
  if (len > 260) {
    len = pxPerArcmin / 4;
    lab = "15″";
  } else if (len < 40) {
    len = pxPerArcmin * 2;
    lab = "2′";
  }
  ctx.fillStyle = ctx.strokeStyle = "rgba(226,232,240,0.85)";
  ctx.lineWidth = 2;
  ctx.font = "11px ui-monospace, Consolas, monospace";
  ctx.beginPath();
  ctx.moveTo(16, H - 18);
  ctx.lineTo(16 + len, H - 18);
  ctx.stroke();
  ctx.fillText(lab, 16 + len / 2 - 6, H - 24);
  const cx = W - 34;
  const cy = H - 22;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - 26);
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx - 26, cy);
  ctx.stroke();
  ctx.fillText("N", cx - 3, cy - 30);
  ctx.fillText("E", cx - 38, cy + 4);
}

export const formatHover = (h: HoverInfo) => `${formatRa(h.ra)} ${formatDec(h.dec)}`;
