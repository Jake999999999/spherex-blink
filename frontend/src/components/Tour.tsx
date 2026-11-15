import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronLeft, X } from "lucide-react";
import { placeCard, type Rect, type TourStep } from "../lib/tour";

interface Props {
  steps: TourStep[];
  index: number;
  taskDone: boolean;
  onIndex: (i: number) => void;
  onClose: () => void;
}

const PAD = 6;

function rectOf(anchor?: string): Rect | null {
  if (!anchor) return null;
  const el = document.querySelector(`[data-tour="${anchor}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { left: r.left - PAD, top: r.top - PAD, width: r.width + 2 * PAD, height: r.height + 2 * PAD };
}

function sameRect(a: Rect | null, b: Rect | null) {
  if (!a || !b) return a === b;
  return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

function sameRectList(a: Rect[], b: Rect[]) {
  return a.length === b.length && a.every((r, i) => sameRect(r, b[i]));
}

interface ArrowGeom {
  d: string;
  tipX: number;
  tipY: number;
}

/**
 * Computes a smooth curved SVG arrow from the nearest edge of the tour card to the nearest
 * edge of the spotlighted target rect. Returns null if the card sits inside the target rect.
 */
function arrowBetween(card: Rect, target: Rect): ArrowGeom | null {
  const cardCx = card.left + card.width / 2;
  const cardCy = card.top + card.height / 2;
  const targCx = target.left + target.width / 2;
  const targCy = target.top + target.height / 2;

  // If the card's centre is inside the target rect (e.g., huge sky canvas), skip external arrow
  if (
    cardCx >= target.left &&
    cardCx <= target.left + target.width &&
    cardCy >= target.top &&
    cardCy <= target.top + target.height
  ) {
    return null;
  }

  const dx = targCx - cardCx;
  const dy = targCy - cardCy;

  let startX: number;
  let startY: number;
  let endX: number;
  let endY: number;
  let c1x: number;
  let c1y: number;
  let c2x: number;
  let c2y: number;

  if (Math.abs(dy) >= Math.abs(dx) * 0.75) {
    // Mostly vertical separation
    const goingDown = dy > 0;
    startX = Math.max(card.left + 20, Math.min(card.left + card.width - 20, targCx));
    startY = goingDown ? card.top + card.height + 4 : card.top - 4;
    endX = Math.max(target.left + 16, Math.min(target.left + target.width - 16, startX));
    endY = goingDown ? target.top - 6 : target.top + target.height + 6;
    const midY = (startY + endY) / 2;
    c1x = startX;
    c1y = midY;
    c2x = endX;
    c2y = midY;
  } else {
    // Mostly horizontal separation
    const goingRight = dx > 0;
    startX = goingRight ? card.left + card.width + 4 : card.left - 4;
    startY = Math.max(card.top + 20, Math.min(card.top + card.height - 20, targCy));
    endX = goingRight ? target.left - 6 : target.left + target.width + 6;
    endY = Math.max(target.top + 16, Math.min(target.top + target.height - 16, startY));
    const midX = (startX + endX) / 2;
    c1x = midX;
    c1y = startY;
    c2x = midX;
    c2y = endY;
  }

  return {
    d: `M ${startX.toFixed(1)} ${startY.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${endX.toFixed(1)} ${endY.toFixed(1)}`,
    tipX: endX,
    tipY: endY,
  };
}

/**
 * Spotlight tour: dims inactive parts of the page via an SVG mask (keeping both the primary
 * anchor and any `alsoLit` regions completely un-darkened), draws a curved arrow from the
 * callout card to the active control, and keeps all spotlighted elements interactive.
 */
export function Tour({ steps, index, taskDone, onIndex, onClose }: Props) {
  const s = steps[index];
  const cardRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [extraRects, setExtraRects] = useState<Rect[]>([]);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: 0 });
  const [cardSize, setCardSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const maskId = useId().replace(/:/g, "");
  const arrowId = `${maskId}-arrow`;

  useEffect(() => {
    if (!s?.anchor) return;
    const el = document.querySelector(`[data-tour="${s.anchor}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [s?.anchor]);

  useLayoutEffect(() => {
    const measure = () => {
      const r = rectOf(s?.anchor);
      setRect((old) => (sameRect(old, r) ? old : r));
      const extras = (s?.alsoLit ?? [])
        .map((a) => rectOf(a))
        .filter((x): x is Rect => x !== null);
      setExtraRects((old) => (sameRectList(old, extras) ? old : extras));
      const c = cardRef.current;
      if (c) {
        const w = c.offsetWidth;
        const h = c.offsetHeight;
        setCardSize((o) => (o.w === w && o.h === h ? o : { w, h }));
        const p = placeCard(r, { w, h }, window.innerWidth, window.innerHeight);
        setPos((o) => (o.left === p.left && o.top === p.top ? o : p));
      }
    };
    measure();
    const id = window.setInterval(measure, 250);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [s, taskDone]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!s) return null;
  const last = index === steps.length - 1;
  const hasTask = !!s.task;
  const arrow =
    rect && pos.left > -1000 && cardSize.w > 0
      ? arrowBetween({ left: pos.left, top: pos.top, width: cardSize.w, height: cardSize.h }, rect)
      : null;

  return (
    <div className="pointer-events-none fixed inset-0 z-50" aria-live="polite">
      {/* Multi-hole SVG dimmer: everything outside `rect` + `extraRects` is darkened */}
      <svg className="pointer-events-none fixed inset-0 h-full w-full" aria-hidden="true">
        <defs>
          <mask id={maskId}>
            <rect width="100%" height="100%" fill="white" />
            {rect && <rect x={rect.left} y={rect.top} width={rect.width} height={rect.height} rx={12} fill="black" />}
            {extraRects.map((er, i) => (
              <rect key={i} x={er.left} y={er.top} width={er.width} height={er.height} rx={12} fill="black" />
            ))}
          </mask>
          <marker id={arrowId} viewBox="0 0 12 12" refX="9" refY="6" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 1 1.5 L 10.5 6 L 1 10.5 z" fill="#38bdf8" />
          </marker>
        </defs>

        <rect width="100%" height="100%" fill="rgba(2, 6, 16, 0.72)" mask={`url(#${maskId})`} />

        {extraRects.map((er, i) => (
          <rect
            key={i}
            x={er.left}
            y={er.top}
            width={er.width}
            height={er.height}
            rx={12}
            fill="none"
            stroke="rgba(56, 189, 248, 0.45)"
            strokeWidth={1.5}
            strokeDasharray="6 4"
          />
        ))}

        {rect && (
          <rect
            x={rect.left}
            y={rect.top}
            width={rect.width}
            height={rect.height}
            rx={12}
            fill="none"
            stroke="#38bdf8"
            strokeWidth={2}
          />
        )}

        {arrow && (
          <>
            <path
              d={arrow.d}
              fill="none"
              stroke="rgba(56, 189, 248, 0.3)"
              strokeWidth={6}
              strokeLinecap="round"
            />
            <path
              d={arrow.d}
              fill="none"
              stroke="#38bdf8"
              strokeWidth={2.5}
              strokeLinecap="round"
              markerEnd={`url(#${arrowId})`}
            />
            <circle cx={arrow.tipX} cy={arrow.tipY} r={4} fill="#38bdf8" opacity={0.85} />
          </>
        )}
      </svg>

      <div
        ref={cardRef}
        role="dialog"
        aria-label={`Tour step ${index + 1} of ${steps.length}: ${s.title}`}
        className="pointer-events-auto absolute w-[min(22rem,calc(100vw-1rem))] rounded-xl border border-sky-400/50 bg-slate-950/95 p-4 text-sm shadow-2xl"
        style={{ left: pos.left, top: pos.top, visibility: pos.left < -1000 ? "hidden" : "visible" }}
      >
        <div className="mb-2 flex items-center gap-2">
          <div className="flex gap-1" aria-hidden="true">
            {steps.map((_, i) => (
              <span key={i} className={`h-1.5 rounded-full transition-all ${i === index ? "w-5 bg-sky-400" : i < index ? "w-1.5 bg-sky-400/60" : "w-1.5 bg-white/20"}`} />
            ))}
          </div>
          <button aria-label="Close tour" title="Close tour (Esc)" onClick={onClose} className="ml-auto rounded p-0.5 text-slate-400 hover:text-white">
            <X size={16} />
          </button>
        </div>
        <h2 className="text-base font-semibold text-white">{s.title}</h2>
        <p className="mt-1.5 leading-relaxed text-slate-300">{s.body}</p>

        {hasTask && !taskDone && (
          <p className="mt-3 flex items-center gap-2 rounded-lg bg-sky-400/15 px-3 py-2 font-medium text-sky-100">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-300 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-sky-300" />
            </span>
            {s.task}
          </p>
        )}
        {hasTask && taskDone && (
          <p className="mt-3 flex gap-2 rounded-lg bg-emerald-400/15 px-3 py-2 text-emerald-100">
            <Check size={16} className="mt-0.5 shrink-0" />
            <span>{s.doneText}</span>
          </p>
        )}

        <div className="mt-4 flex items-center gap-2">
          {index > 0 && (
            <button onClick={() => onIndex(index - 1)} className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-slate-400 hover:text-white">
              <ChevronLeft size={14} /> Back
            </button>
          )}
          {index === 0 && (
            <button onClick={onClose} className="rounded-md px-2 py-1.5 text-xs text-slate-400 hover:text-white">
              No thanks
            </button>
          )}
          <span className="ml-auto" />
          {hasTask && !taskDone && (
            <button onClick={() => onIndex(index + 1)} className="rounded-md px-2 py-1.5 text-xs text-slate-400 hover:text-slate-300">
              Skip
            </button>
          )}
          <button
            onClick={() => (last ? onClose() : onIndex(index + 1))}
            disabled={hasTask && !taskDone}
            className="rounded-md bg-sky-400 px-3.5 py-1.5 text-sm font-semibold text-slate-950 hover:bg-sky-300 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-400"
          >
            {index === 0 ? "Start the tour" : last ? "Start exploring" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
