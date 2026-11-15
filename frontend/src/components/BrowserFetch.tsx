import { useEffect, useRef, useState } from "react";
import { ExternalLink, FileUp, Loader2, Search, X } from "lucide-react";
import { looksLikeCoords, parseCoords } from "../lib/coords";
import { formatDec, formatRa } from "../lib/wcs";
import { BUNDLE_FILES, estimateBytesPerExposure, putMemBundle, readBundleFiles, type BundleFiles, type Progress } from "../lib/browser/fieldbuild";
import { irsaSearchUrl, MAX_LIST_BYTES, parseExposureList, sampleByVisit, type ExposureRef } from "../lib/browser/exposures";
import { resolveNameInBrowser, startBrowserBuild, type BuildHandle } from "../lib/browser/client";
import type { CubeDesc } from "../lib/colour";
import type { LiveResult } from "./LiveSearch";
import { claimAutostart } from "../lib/live";
import { TargetListStepper } from "./TargetListStepper";

interface Props {
  onReady: (r: LiveResult) => void;
  autostart?: { ra: number; dec: number; fov: number; name?: string } | null;
}

interface Field {
  id: string;
  name: string;
  ra: number;
  dec: number;
  fov: number;
  cube: { desc: CubeDesc; data: Float32Array } | null;
}

const CONFIRM_MB = 50;
const MAX_MB = 600;
const PHASE: Record<Progress["phase"], string> = { map: "Reading the 102-colour map", headers: "Reading file headers", exposures: "Processing exposures", packing: "Stacking visits" };

const fieldId = (ra: number, dec: number, fov: number) => `b-${Math.round(ra * 1e4).toString(36)}-${Math.round((dec + 90) * 1e4).toString(36)}-${fov}`;

/**
 * No local server (e.g. the public GitHub Pages site): build fields in this browser from NASA's public
 * S3 copy of SPHEREx. Step 1 (one click): the 102-colour map at any position. Step 2 (optional): the
 * time series, from IRSA's exposure list saved by the person (IRSA's search can't be called from a web
 * page) or from SPHEREx FITS files they downloaded.
 */
export function BrowserFetch({ onReady, autostart }: Props) {
  const [text, setText] = useState("");
  const [fov, setFov] = useState(4);
  const [field, setField] = useState<Field | null>(null);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<Progress | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [list, setList] = useState<{ refs: ExposureRef[]; format: string; skipped: number } | null>(null);
  const [allData, setAllData] = useState(false);
  const [drag, setDrag] = useState(false);
  const handle = useRef<BuildHandle | null>(null);
  const lastProg = useRef<Progress | null>(null);

  const run = async (req: Parameters<typeof startBrowserBuild>[0], f: Field, label: string) => {
    setBusy(true);
    setErr(null);
    setMsg(label);
    setProg(null);
    lastProg.current = null;
    const h = startBrowserBuild(req, (p) => {
      lastProg.current = p;
      setProg(p);
    });
    handle.current = h;
    try {
      const files: BundleFiles = await h.done;
      putMemBundle(f.id, files);
      const meta = JSON.parse(files["meta.json"] as string);
      const cube = files["cube.bin"] && meta.cube?.file ? { desc: meta.cube as CubeDesc, data: new Float32Array((files["cube.bin"] as ArrayBuffer).slice(0)) } : f.cube;
      setField({ ...f, cube });
      const used = (meta.exposures as { used: boolean }[]).filter((x) => x.used).length;
      setMsg(
        meta.epochs.length
          ? `Ready: ${meta.epochs.length} visit${meta.epochs.length > 1 ? "s" : ""} from ${used} exposures. ${(lastProg.current as Progress | null)?.note ?? ""}`
          : cube
            ? "Ready: the 102-colour map. Add the exposure list below to blink this spot."
            : "Nothing usable came back.",
      );
      onReady({ id: f.id, name: f.name, ra: f.ra, dec: f.dec, fov: f.fov, browser: true });
    } catch (e) {
      const m = (e as Error).message;
      setErr(m === "cancelled" ? "Stopped." : `Couldn't build it: ${m}`);
      setMsg(null);
    } finally {
      setBusy(false);
      handle.current = null;
    }
  };

  const fetchMap = (ra: number, dec: number, f: number, name: string) => {
    const fl: Field = { id: fieldId(ra, dec, f), name: name || `RA ${ra.toFixed(3)}°, Dec ${dec.toFixed(3)}°`, ra, dec, fov: f, cube: null };
    setField(fl);
    setList(null);
    void run({ id: fl.id, name: fl.name, ra, dec, fov: f, withCube: true }, fl, "Reading the 102-colour map from NASA's S3 copy…");
  };

  useEffect(() => {
    if (autostart && claimAutostart()) {
      setFov(Math.min(10, autostart.fov));
      setText(autostart.name || `${autostart.ra.toFixed(5)} ${autostart.dec.toFixed(5)}`);
      fetchMap(autostart.ra, autostart.dec, Math.min(10, autostart.fov), autostart.name ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autostart]);

  const submit = async () => {
    const s = text.trim();
    if (!s) return;
    if (looksLikeCoords(s)) {
      const p = parseCoords(s);
      if (!p) return setErr("Couldn't read those coordinates. Try “08h55m10.8s -07d14m42.5s” or “133.795 -7.245”.");
      return fetchMap(p.ra, p.dec, fov, "");
    }
    setBusy(true);
    setErr(null);
    setMsg(`Looking up “${s}”…`);
    try {
      const r = await resolveNameInBrowser(s);
      setBusy(false);
      fetchMap(r.ra, r.dec, fov, r.name);
    } catch (e) {
      setErr((e as Error).message);
      setMsg(null);
      setBusy(false);
    }
  };

  const sample = list ? sampleByVisit(list.refs, allData ? 6 : 3, allData ? 8 : 4) : null;
  const mb = sample && field ? (sample.refs.length * estimateBytesPerExposure(field.fov)) / 1e6 : 0;

  const buildSeries = () => {
    if (!field || !sample) return;
    if (mb > MAX_MB) return setErr(`That would download about ${mb.toFixed(0)} MB; the limit here is ${MAX_MB} MB. Use a smaller field or the quick look.`);
    if (mb > CONFIRM_MB && !window.confirm(`This downloads about ${mb.toFixed(0)} MB from NASA's S3 copy (${sample.refs.length} exposures). Go ahead?`)) return;
    void run(
      { id: field.id, name: field.name, ra: field.ra, dec: field.dec, fov: field.fov, refs: sample.refs.map((ref) => ({ ref, visit: sample.visitOf.get(ref.key) ?? -1 })), withCube: !field.cube, reuseCube: field.cube },
      field,
      `Fetching ${sample.refs.length} exposures from NASA's S3 copy…`,
    );
  };

  const takeText = (t: string) => {
    try {
      const l = parseExposureList(t);
      if (!l.refs.length) return setErr("No SPHEREx level-2 images found in that. Save the IRSA list from the link above (or paste its links).");
      setErr(null);
      setList(l);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const takeFiles = async (files: File[]) => {
    // a whole field made by the pipeline (meta.json, frames.bin, …), shared as files or a folder
    if (files.some((f) => f.name === "meta.json")) {
      const r = await readBundleFiles(files.filter((f) => BUNDLE_FILES.includes(f.name)));
      if (typeof r === "string") return setErr(r);
      const id = `f-${Date.now().toString(36)}`;
      putMemBundle(id, r.files);
      setErr(null);
      setMsg(`Opened the shared field “${r.name}”.`);
      return onReady({ id, name: r.name, ra: r.ra, dec: r.dec, fov: r.fov, browser: true, shared: true });
    }
    const fits = files.filter((f) => /\.fits?(\.gz)?$/i.test(f.name) || f.type === "application/fits");
    const other = files.filter((f) => !fits.includes(f));
    if (fits.some((f) => /\.gz$/i.test(f.name))) return setErr("Please unzip .gz files first (or download cutouts with gzip off).");
    if (!field && other.length) return setErr("Type the position first, then drop the exposure list.");
    if (other.length) {
      const f = other[0];
      if (f.size > MAX_LIST_BYTES) return setErr("That file is too large for an exposure list.");
      return takeText(await f.text());
    }
    if (fits.length) {
      let targetField = field;
      if (!targetField) {
        const center = await fitsCenter(fits[0]);
        if (!center) return setErr("Type the position first, then drop the FITS files.");
        targetField = {
          id: fieldId(center.ra, center.dec, fov),
          name: fits[0].name.replace(/\.fits?$/i, ""),
          ra: center.ra,
          dec: center.dec,
          fov,
          cube: null,
        };
        setField(targetField);
      }
      void run(
        { id: targetField.id, name: targetField.name, ra: targetField.ra, dec: targetField.dec, fov: targetField.fov, files: fits, withCube: !targetField.cube, reuseCube: targetField.cube },
        targetField,
        `Reading ${fits.length} files…`,
      );
    }
  };

  return (
    <div
      className={`mx-4 mb-2 rounded-lg border px-3 py-2 ${drag ? "border-sky-300 bg-sky-400/10" : "border-white/10 bg-white/[0.03]"}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (!busy) void collectDroppedFiles(e.dataTransfer).then(takeFiles);
      }}
    >
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-md border border-white/15 bg-slate-950/60 px-2">
          <Search size={14} className="text-slate-400" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Any spot: a name (R Draconis) or coordinates (08h55m10.8s -07d14m42.5s)"
            aria-label="Object name or sky coordinates"
            className="w-full bg-transparent py-1.5 text-sm text-white placeholder:text-slate-400 focus:outline-none"
            disabled={busy}
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-300" title="In the browser, bigger fields mean bigger downloads">
          Field
          <input type="range" min={2} max={10} step={1} value={fov} onChange={(e) => setFov(Number(e.target.value))} disabled={busy} className="w-24" />
          <span className="mono w-8">{fov}′</span>
        </label>
        {busy ? (
          <button type="button" onClick={() => handle.current?.cancel()} className="inline-flex items-center gap-1 rounded-md border border-white/15 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/5">
            <X size={13} /> Stop
          </button>
        ) : (
          <>
            <TargetListStepper onSelect={(q) => setText(q)} />
            <button type="submit" className="rounded-md bg-sky-400 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-300">
              Fetch from NASA
            </button>
          </>
        )}
      </form>

      <p className="mt-1.5 text-[11px] text-slate-400">
        Runs in this browser, straight from NASA's public copy of SPHEREx on Amazon S3 (no server needed). The 102-colour map comes first, in seconds. Someone
        shared a field with you? Drop all its files (meta.json, frames.bin, …) here, or{" "}
        <label className="cursor-pointer text-sky-300 underline">
          choose them
          <input type="file" multiple accept=".json,.bin" className="sr-only" onChange={(e) => void takeFiles([...(e.target.files ?? [])])} />
        </label>
        .
      </p>

      {(busy || msg || err) && (
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-300" aria-live="polite">
          {busy && <Loader2 size={13} className="animate-spin text-sky-300" />}
          {err ? <span className="text-amber-300">{err}</span> : msg}
          {busy && prog && (
            <span className="mono text-slate-400">
              {PHASE[prog.phase]} {prog.done}/{prog.total} · {(prog.bytes / 1e6).toFixed(1)} MB
            </span>
          )}
        </p>
      )}

      {field && !busy && (
        <div className="mt-2 rounded-md border border-white/10 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">
          <div className="mb-1 font-medium text-slate-200">
            Blink this spot: add its exposures{" "}
            <span className="mono font-normal text-slate-400">
              ({formatRa(field.ra)} {formatDec(field.dec)})
            </span>
          </div>
          <ol className="ml-4 list-decimal space-y-1">
            <li>
              <a href={irsaSearchUrl(field.ra, field.dec)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sky-300 underline hover:text-sky-200">
                Open IRSA's list of SPHEREx exposures here <ExternalLink size={11} />
              </a>{" "}
              (NASA's archive; web pages can't ask it directly, so it opens in a new tab).
            </li>
            <li>Save that page (Ctrl+S / ⌘S, or it downloads by itself) and drop the file on this box, or paste its text below.</li>
          </ol>
          <textarea
            aria-label="Paste an IRSA exposure list or links to SPHEREx level-2 images"
            placeholder="…or paste the list / links here"
            rows={1}
            className="mt-1.5 w-full resize-y rounded border border-white/10 bg-slate-950/60 px-2 py-1 font-mono text-[11px] text-slate-200 placeholder:text-slate-500"
            onChange={(e) => {
              if (e.target.value.trim()) takeText(e.target.value);
            }}
          />
          <label className="mt-1 inline-flex cursor-pointer items-center gap-1 text-slate-400 hover:text-slate-200">
            <FileUp size={12} />
            <span className="underline">choose a file</span> (the saved list, or SPHEREx FITS cutouts / level-2 images you downloaded from IRSA)
            <input type="file" multiple className="sr-only" onChange={(e) => void takeFiles([...(e.target.files ?? [])])} />
          </label>
          {list && sample && (
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <span>
                {list.refs.length} exposures in the {list.format === "text" ? "list" : list.format}
                {list.skipped ? ` (${list.skipped} rows skipped)` : ""}; {sample.visits ? `${sample.visits} visits` : "no times in the list, so each file's header is read first to find its visit"}. {allData ? "All data" : "Quick look"}: {sample.refs.length} exposures, about{" "}
                <b>{mb.toFixed(0)} MB</b>.
              </span>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={allData} onChange={(e) => setAllData(e.target.checked)} /> more data (up to 8 visits, 6 per detector)
              </label>
              <button onClick={buildSeries} className="rounded-md bg-sky-400 px-3 py-1 font-semibold text-slate-950 hover:bg-sky-300">
                Build the blink
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Read CRVAL1/CRVAL2 from the first ~28 KB of a FITS file so users can drop FITS before typing coordinates. */
async function fitsCenter(file: File): Promise<{ ra: number; dec: number } | null> {
  const head = await file.slice(0, 28800).text();
  const m1 = /CRVAL1\s*=\s*([-\d.eE+]+)/.exec(head);
  const m2 = /CRVAL2\s*=\s*([-\d.eE+]+)/.exec(head);
  if (!m1 || !m2) return null;
  const ra = Number(m1[1]);
  const dec = Number(m2[1]);
  return Number.isFinite(ra) && Number.isFinite(dec) && dec >= -90 && dec <= 90 ? { ra: ((ra % 360) + 360) % 360, dec } : null;
}

/** Expand dropped directories (shared field folders) into flat File[]. */
async function collectDroppedFiles(dt: DataTransfer): Promise<File[]> {
  const entries = [...(dt.items ?? [])].map((it) => it.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return [...dt.files];
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const f = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push(f);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      for (const child of batch) await walk(child);
    }
  };
  for (const e of entries) await walk(e);
  return out.length ? out : [...dt.files];
}
