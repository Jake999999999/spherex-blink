import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ListFilter, X } from "lucide-react";
import { parseTargetList, type TargetListItem } from "../lib/targetlist";

interface Props {
  disabled?: boolean;
  onSelect: (query: string) => void;
}

/** Compact CSV/TSV target-list loader and Prev/Next stepper for survey vetting. */
export function TargetListStepper({ disabled = false, onSelect }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<TargetListItem[]>([]);
  const [idx, setIdx] = useState(0);

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    const parsed = parseTargetList(await file.text());
    if (!parsed.length) return;
    setItems(parsed);
    setIdx(0);
    onSelect(parsed[0].query);
  };

  const step = (delta: number) => {
    if (!items.length) return;
    const next = (idx + delta + items.length) % items.length;
    setIdx(next);
    onSelect(items[next].query);
  };

  return (
    <div className="inline-flex items-center gap-1">
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.tsv,.txt"
        className="hidden"
        onChange={(e) => {
          void loadFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {items.length === 0 ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          title="Load a CSV/TSV target list (name, ra, dec) to step through candidates"
          className="inline-flex items-center gap-1 rounded-md border border-white/15 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-40"
        >
          <ListFilter size={13} /> List
        </button>
      ) : (
        <div className="inline-flex items-center gap-1 rounded-md border border-sky-400/30 bg-sky-400/10 px-1.5 py-1 text-xs text-sky-100">
          <button type="button" disabled={disabled} onClick={() => step(-1)} aria-label="Previous target in list" className="rounded p-0.5 hover:bg-white/10 disabled:opacity-40">
            <ChevronLeft size={13} />
          </button>
          <span className="mono max-w-[120px] truncate" title={items[idx].label}>
            {idx + 1}/{items.length} · {items[idx].label}
          </span>
          <button type="button" disabled={disabled} onClick={() => step(1)} aria-label="Next target in list" className="rounded p-0.5 hover:bg-white/10 disabled:opacity-40">
            <ChevronRight size={13} />
          </button>
          <button type="button" onClick={() => setItems([])} aria-label="Clear target list" className="rounded p-0.5 text-slate-300 hover:bg-white/10">
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
