import { shortName, type IndexEntry } from "../lib/bundle";

interface Props {
  targets: IndexEntry[];
  current: string;
  onPick: (id: string) => void;
}

/** Horizontal row of target cards: the first thing a visitor chooses. */
export function TargetBar({ targets, current, onPick }: Props) {
  return (
    <nav aria-label="Targets" className="flex gap-2 overflow-x-auto px-4 pb-3 pt-1">
      {targets.map((t, i) => {
        const active = t.id === current;
        return (
          <button
            key={t.id}
            onClick={() => onPick(t.id)}
            aria-pressed={active}
            className={`group flex min-w-[190px] max-w-[240px] shrink-0 flex-col items-start rounded-lg border px-3 py-2 text-left transition ${
              active
                ? "border-sky-400/70 bg-sky-400/10 shadow-[0_0_24px_-8px_rgba(56,189,248,0.6)]"
                : "border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.06]"
            }`}
          >
            <span className="flex w-full items-center gap-2">
              <span className={`mono text-[11px] ${active ? "text-sky-300" : "text-slate-500"}`}>{String(i + 1).padStart(2, "0")}</span>
              <span className={`truncate text-sm font-semibold ${active ? "text-white" : "text-slate-200"}`}>{shortName(t.name)}</span>
              {t.status === "conditional" && (
                <span className="ml-auto rounded bg-amber-400/15 px-1.5 text-[10px] font-medium text-amber-300" title="Shown with caveats: see the target notes">
                  caveats
                </span>
              )}
            </span>
            <span className="mt-0.5 line-clamp-1 text-xs text-slate-400">{t.tagline}</span>
          </button>
        );
      })}
    </nav>
  );
}
