import { ChevronLeft, ChevronRight, X } from "lucide-react";

export interface TourStep {
  title: string;
  body: string;
}

interface Props {
  steps: TourStep[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}

export function Tour({ steps, index, onIndex, onClose }: Props) {
  const s = steps[index];
  if (!s) return null;
  return (
    <div className="panel absolute right-3 top-12 z-20 w-80 max-w-[calc(100%-1.5rem)] rounded p-3 text-sm shadow-xl" role="dialog" aria-label="Guided tour">
      <div className="mb-1 flex items-center gap-2">
        <span className="mono text-[11px] text-sky-400">
          {index + 1} / {steps.length}
        </span>
        <h2 className="flex-1 font-semibold text-slate-100">{s.title}</h2>
        <button aria-label="Close tour" title="Close tour" onClick={onClose} className="rounded p-0.5 text-slate-400 hover:text-slate-100">
          <X size={14} />
        </button>
      </div>
      <p className="text-xs leading-relaxed text-slate-300">{s.body}</p>
      <div className="mt-3 flex items-center justify-between">
        <button
          onClick={() => onIndex(index - 1)}
          disabled={index === 0}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-slate-300 hover:bg-sky-400/10 disabled:opacity-30"
        >
          <ChevronLeft size={14} /> Back
        </button>
        {index < steps.length - 1 ? (
          <button onClick={() => onIndex(index + 1)} className="inline-flex items-center gap-1 rounded bg-sky-400/20 px-2 py-1 text-xs text-sky-100 hover:bg-sky-400/30">
            Next <ChevronRight size={14} />
          </button>
        ) : (
          <button onClick={onClose} className="rounded bg-sky-400/20 px-2 py-1 text-xs text-sky-100 hover:bg-sky-400/30">
            Explore on your own
          </button>
        )}
      </div>
    </div>
  );
}
