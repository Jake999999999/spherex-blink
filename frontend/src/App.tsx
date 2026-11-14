import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, SkipBack, SkipForward, RotateCcw, Info, Compass, Route } from "lucide-react";
import { GAIA_G_LIMIT, SkyCanvas, formatHover, type HoverInfo, type SkyCanvasHandle } from "./components/SkyCanvas";
import { SpectrumPanel, type PanelTab } from "./components/SpectrumPanel";
import { Tour, type TourStep } from "./components/Tour";
import { framePlane, loadBundle, loadIndex, wisePlane, type Bundle, type IndexEntry } from "./lib/bundle";
import { blinkSteps, epochsWithBand, layerOf, type Step } from "./lib/sequence";
import { diffLimit, levelsFor, subtract } from "./lib/stretch";
import { DEFAULT_STATE, parseState, serializeState, type ViewState } from "./lib/urlState";
import { COLORMAPS, type ColormapName } from "./gl/colormaps";
import { formatMjdRange, mjdToYear, propagate } from "./lib/astro";
import { formatDec, formatRa, separationArcsec, worldToPixel } from "./lib/wcs";
import { nearestSource } from "./lib/spectra";
import { centroid, fitMotion } from "./lib/motion";

const initialUrl = parseState(window.location.search);
const SILENT = initialUrl.silent;

declare global {
  interface Window {
    __spherex?: {
      state: () => unknown;
      frame: (dtMs?: number) => void;
      setEpoch: (i: number) => void;
      set: (patch: Partial<ViewState>) => void;
      select: (id: string | null) => void;
      tour: (i: number | null) => void;
      motion: () => unknown;
      silent: boolean;
    };
  }
}

const TOUR_KEY = "spherex-blink.tourSeen";
const storage = {
  get: (k: string) => {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      window.localStorage.setItem(k, v);
    } catch {
      /* private mode etc. */
    }
  },
};

interface TourAction {
  target: string;
  patch: Partial<ViewState>;
  select: string | null;
  tab: PanelTab;
  playing: boolean;
}

const TOUR: (TourStep & TourAction)[] = [
  {
    title: "A star that moves",
    body:
      "Barnard's Star, 6 light-years away, crosses 10.4″ of sky a year. The blink starts with WISE's 2010 image and then shows each SPHEREx visit (2025–2026): the star jumps almost 3′. Between SPHEREx visits it moves only 1–2 pixels; step with ← → to see it. The yellow marks show where Gaia says it should be on each date.",
    target: "barnard",
    patch: { mode: "blink", band: 6, wise: true },
    select: null,
    tab: "spectrum",
    playing: true,
  },
  {
    title: "Subtract two visits",
    body:
      "Epsilon Indi Ba+Bb are two brown dwarfs, 0.7″ apart, so SPHEREx sees one blended source. Subtracting an earlier visit from a later one cancels the stars that stayed put. This pair moved about 0.8 pixel a year, which leaves a faint amber/cyan pair. Below is its spectrum: each dot is one SPHEREx exposure at one wavelength.",
    target: "eps-ind-b",
    patch: { mode: "diff", band: 3, t1: 0, t2: 99 },
    select: "target",
    tab: "spectrum",
    playing: false,
  },
  {
    title: "A star that pulses",
    body:
      "This red giant sits next to the north ecliptic pole, which SPHEREx sees every day; Gaia found it pulses over about a year. It's so bright in the infrared that its centre saturates, so the light curve measures a ring of light around the centre instead. Over 18 months it fades to about half and brightens again. Each dot is one exposure; colour is the wavelength inside the detector.",
    target: "nep-lpv",
    patch: { mode: "blink", band: 6, wise: false },
    select: "target",
    tab: "lightcurve",
    playing: true,
  },
];

export default function App() {
  const [index, setIndex] = useState<IndexEntry[] | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<ViewState>({ ...DEFAULT_STATE, ...stripSilent(initialUrl) });
  const [stepIdx, setStepIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [fps, setFps] = useState(1.5);
  const [showGaia, setShowGaia] = useState(true);
  const [pixelGrid, setPixelGrid] = useState(false);
  const [lo, setLo] = useState(5);
  const [hi, setHi] = useState(99.7);
  const [diffPct, setDiffPct] = useState(99.8);
  const [cmap, setCmap] = useState<ColormapName>("gray");
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const canvasRef = useRef<SkyCanvasHandle>(null);
  const urlApplied = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<PanelTab>("spectrum");
  const [measure, setMeasure] = useState(false);
  const [pickHint, setPickHint] = useState<string | null>(null);
  const [tourIdx, setTourIdx] = useState<number | null>(() => (storage.get(TOUR_KEY) || initialUrl.target ? null : 0));
  const pending = useRef<TourAction | null>(null);

  // index, then the chosen target
  useEffect(() => {
    loadIndex()
      .then(setIndex)
      .catch((e) => setError(`No baked targets found (${e.message}). Run the bake step in backend/.`));
  }, []);

  useEffect(() => {
    if (!index) return;
    const id = index.some((t) => t.id === state.target) ? state.target : index[0]?.id;
    if (!id) return;
    let live = true;
    setBundle(null);
    loadBundle(id)
      .then((b) => {
        if (!live) return;
        setBundle(b);
        setStepIdx(0);
        setMeasure(false);
        setPickHint(null);
        const tourAct = pending.current?.target === id ? pending.current : null;
        pending.current = null;
        setSelectedId(tourAct?.select ?? null);
        if (tourAct) {
          setTab(tourAct.tab);
          setPlaying(tourAct.playing);
        }
        // decide outside the updater: StrictMode runs updaters twice
        const fromUrl = !urlApplied.current && !tourAct;
        urlApplied.current = true;
        setState((s) => {
          if (tourAct) {
            const E = b.meta.epochs.length;
            const next = { ...s, target: id, mode: b.meta.default_mode, band: b.meta.default_band, t1: 0, t2: E - 1, ...tourAct.patch };
            next.t1 = Math.min(next.t1, E - 1);
            next.t2 = Math.min(next.t2, E - 1);
            return next;
          }
          const E = b.meta.epochs.length;
          const next: ViewState = fromUrl
            ? { ...s, target: id }
            : { ...s, target: id, mode: b.meta.default_mode, band: b.meta.default_band, t1: 0, t2: E - 1 };
          if (fromUrl && initialUrl.mode === undefined) next.mode = b.meta.default_mode;
          if (fromUrl && initialUrl.band === undefined) next.band = b.meta.default_band;
          if (fromUrl && initialUrl.t2 === undefined) next.t2 = E - 1;
          next.t1 = Math.min(next.t1, E - 1);
          next.t2 = Math.min(next.t2, E - 1);
          return next;
        });
      })
      .catch((e) => live && setError(`Couldn't load ${id}: ${e.message}`));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, state.target]);

  // URL sync
  useEffect(() => {
    if (!bundle) return;
    const q = serializeState(state, SILENT);
    if (q !== window.location.search.slice(1)) window.history.replaceState(null, "", `?${q}`);
  }, [state, bundle]);

  const steps: Step[] = useMemo(() => (bundle ? blinkSteps(bundle, state.band, state.wise) : []), [bundle, state.band, state.wise]);
  const step = steps.length ? steps[stepIdx % steps.length] : null;
  const bandEpochs = useMemo(() => (bundle ? epochsWithBand(bundle, state.band) : []), [bundle, state.band]);

  // levels: one set per detector across all SPHEREx visits (so the blink compares like with like)
  const spxLevels = useMemo(() => {
    if (!bundle || !bandEpochs.length) return { black: 0, white: 1 };
    const n = bundle.width * bundle.height;
    const all = new Float32Array(n * bandEpochs.length);
    bandEpochs.forEach((e, i) => all.set(framePlane(bundle, e, state.band), i * n));
    return levelsFor(all, lo, hi);
  }, [bundle, bandEpochs, state.band, lo, hi]);
  const wiseLevels = useMemo(() => {
    if (!bundle || !step || step.kind !== "wise") return null;
    const i = step.layer - bundle.meta.epochs.length * 6;
    return levelsFor(wisePlane(bundle, i), lo, hi);
  }, [bundle, step, lo, hi]);

  const diffOk = bundle && bandEpochs.includes(state.t1) && bandEpochs.includes(state.t2) && state.t1 !== state.t2;
  const diffData = useMemo(() => {
    if (!bundle || !diffOk) return null;
    return subtract(framePlane(bundle, state.t2, state.band), framePlane(bundle, state.t1, state.band));
  }, [bundle, diffOk, state.t1, state.t2, state.band]);
  const limit = useMemo(() => (diffData ? diffLimit(diffData, diffPct) : 1), [diffData, diffPct]);

  const isDiff = state.mode === "diff" && !!diffData;
  const isDiffRef = useRef(isDiff);
  isDiffRef.current = isDiff;
  const levels = step?.kind === "wise" && wiseLevels ? wiseLevels : spxLevels;
  const draw = {
    mode: isDiff ? ("diff" as const) : ("single" as const),
    layerA: isDiff ? layerOf(state.t2, state.band) : (step?.layer ?? 0),
    layerB: isDiff ? layerOf(state.t1, state.band) : 0,
    black: levels.black,
    white: levels.white,
    limit,
    stretch: state.stretch,
    mix: 0,
    colormap: cmap,
    pixelGrid,
  };

  const valueAt = useCallback(
    (x: number, y: number) => {
      if (!bundle) return null;
      const i = y * bundle.width + x;
      if (isDiff && diffData) return diffData[i];
      if (!step) return null;
      const p = step.kind === "wise" ? wisePlane(bundle, step.layer - bundle.meta.epochs.length * 6) : framePlane(bundle, step.epoch, state.band);
      return Number.isFinite(p[i]) ? p[i] : null;
    },
    [bundle, isDiff, diffData, step, state.band],
  );

  // playback
  const acc = useRef(0);
  const advance = useCallback(
    (dtMs: number) => {
      if (!playing || state.mode !== "blink" || steps.length < 2) return;
      acc.current += dtMs;
      const period = 1000 / fps;
      if (acc.current >= period) {
        const n = Math.floor(acc.current / period);
        acc.current -= n * period;
        setStepIdx((i) => (i + n) % steps.length);
      }
    },
    [playing, state.mode, steps.length, fps],
  );
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      advance(now - last);
      last = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [advance]);

  const set = useCallback((patch: Partial<ViewState>) => setState((s) => ({ ...s, ...patch })), []);

  // ---- guided tour: only steps whose target is baked
  const tourSteps = useMemo(() => TOUR.filter((t) => index?.some((x) => x.id === t.target)), [index]);
  const goTour = useCallback(
    (i: number | null) => {
      if (i === null || !tourSteps[i]) {
        setTourIdx(null);
        storage.set(TOUR_KEY, "1");
        return;
      }
      setTourIdx(i);
      const a = tourSteps[i];
      if (bundle && bundle.meta.id === a.target) {
        const E = bundle.meta.epochs.length;
        setState((s) => {
          const next = { ...s, ...a.patch };
          next.t1 = Math.min(next.t1, E - 1);
          next.t2 = Math.min(next.t2, E - 1);
          return next;
        });
        setSelectedId(a.select);
        setTab(a.tab);
        setPlaying(a.playing);
        setStepIdx(0);
      } else {
        pending.current = a;
        set({ target: a.target });
      }
    },
    [tourSteps, bundle, set],
  );
  // first visit: run step 1 once the index is known
  const tourStarted = useRef(false);
  useEffect(() => {
    if (tourIdx === 0 && !tourStarted.current && tourSteps.length && bundle) {
      tourStarted.current = true;
      goTour(0);
    }
  }, [tourIdx, tourSteps, bundle, goTour]);

  // ---- selected source (spectrum / light curve / motion)
  const selected = bundle?.spectra?.sources.find((s) => s.id === selectedId) ?? null;

  const onPick = useCallback(
    (x: number, y: number) => {
      if (!bundle) return;
      if (!bundle.spectra) {
        setPickHint("This bundle has no spectra yet (it was baked before photometry existed).");
        return;
      }
      const mjd = isDiffRef.current ? bundle.meta.epochs[state.t2].mjd : (step?.mjd ?? bundle.meta.epochs[0].mjd);
      const src = nearestSource(bundle.spectra, bundle.meta.wcs, x, y, mjd, 3);
      if (src) {
        setSelectedId(src.id);
        setMeasure(false);
        setPickHint(null);
      } else {
        setPickHint(`Spectra are baked for the target and the ${bundle.spectra.sources.length - 1} brightest Gaia stars in the field (G < 15). Click closer to one of those.`);
      }
    },
    [bundle, step, state.t2],
  );

  const motion = useMemo(() => {
    if (!bundle || !selected) return null;
    const scale = bundle.meta.pixel_scale_arcsec;
    const yrs = steps.map((s) => mjdToYear(s.mjd));
    const pm = Math.hypot(selected.pmra, selected.pmdec) / 1000;
    const expectedPx = steps.length > 1 ? (pm * (Math.max(...yrs) - Math.min(...yrs))) / scale : 0;
    if (!measure || expectedPx < 1) return { expectedPx, pts: [], fit: null };
    const pts = steps
      .map((s) => {
        const year = mjdToYear(s.mjd);
        const plane = s.kind === "wise" ? wisePlane(bundle, s.layer - bundle.meta.epochs.length * 6) : framePlane(bundle, s.epoch, state.band);
        const [ra, dec] = propagate(selected.ra, selected.dec, selected.pmra, selected.pmdec, selected.ref_year, year);
        const [sx, sy] = worldToPixel(bundle.meta.wcs, ra, dec);
        const c = centroid(plane, bundle.width, bundle.height, sx, sy, 3);
        return c ? { year, x: c.x, y: c.y, label: s.kind === "wise" ? "2010" : `V${s.epoch + 1}` } : null;
      })
      .filter((p): p is { year: number; x: number; y: number; label: string } => !!p);
    return { expectedPx, pts, fit: fitMotion(pts, scale) };
  }, [bundle, selected, steps, measure, state.band]);

  // test hooks (a hidden pane stops requestAnimationFrame)
  useEffect(() => {
    window.__spherex = {
      state: () => ({ ...state, stepIdx, step, steps: steps.map((s) => s.label), playing, fps, target: bundle?.meta.id, levels, limit }),
      frame: (dtMs = 1000 / fps) => {
        advance(dtMs);
        canvasRef.current?.redraw();
      },
      setEpoch: (i: number) => setStepIdx(((i % Math.max(1, steps.length)) + steps.length) % Math.max(1, steps.length)),
      set,
      select: (id) => {
        setSelectedId(id);
        setMeasure(false);
      },
      tour: (i) => goTour(i),
      motion: () => {
        setMeasure(true);
        return motion;
      },
      silent: SILENT,
    };
  });

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const n = Math.max(1, steps.length);
      switch (e.key) {
        case " ":
          e.preventDefault();
          setPlaying((p) => !p);
          break;
        case "ArrowRight":
          setPlaying(false);
          setStepIdx((i) => (i + 1) % n);
          break;
        case "ArrowLeft":
          setPlaying(false);
          setStepIdx((i) => (i - 1 + n) % n);
          break;
        case "d":
        case "D":
          set({ mode: state.mode === "diff" ? "blink" : "diff" });
          break;
        case "g":
        case "G":
          setShowGaia((g) => !g);
          break;
        case "r":
        case "R":
          canvasRef.current?.resetView();
          break;
        case "Escape":
          setSelectedId(null);
          setPickHint(null);
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [steps.length, state.mode, set]);

  if (error) return <Centered>{error}</Centered>;
  if (!index || !bundle) return <Centered>Loading SPHEREx data…</Centered>;

  const m = bundle.meta;
  const t = m.target;
  const diffYears = isDiff ? [m.epochs[state.t1].mjd, m.epochs[state.t2].mjd] : null;
  const shownYear = isDiff ? null : step ? mjdToYear(step.mjd) : null;
  const targetPm = Math.hypot(t.pmra, t.pmdec) / 1000; // arcsec/yr
  const det = m.detectors[state.band - 1];

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* sidebar */}
      <aside className="panel order-2 flex w-full shrink-0 flex-col gap-4 overflow-y-auto p-4 text-sm lg:order-1 lg:w-80">
        <header>
          <h1 className="text-base font-semibold tracking-wide text-sky-300">SPHEREx Blink</h1>
          <p className="text-xs text-slate-400">Real near-infrared sky survey data, visit by visit.</p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {tourSteps.length > 0 && (
              <button onClick={() => goTour(0)} className="inline-flex items-center gap-1 rounded border border-sky-400/30 px-2 py-0.5 text-sky-200 hover:bg-sky-400/10">
                <Route size={12} /> Guided tour
              </button>
            )}
            {bundle.spectra && !selected && (
              <button onClick={() => setSelectedId("target")} className="rounded border border-sky-400/30 px-2 py-0.5 text-sky-200 hover:bg-sky-400/10">
                Target spectrum
              </button>
            )}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">Click a star for its spectrum and light curve.</p>
        </header>

        <Field label="Target">
          <select
            className="w-full rounded border border-sky-400/20 bg-slate-900 px-2 py-1.5"
            value={m.id}
            onChange={(e) => set({ target: e.target.value })}
          >
            {index.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs leading-relaxed text-slate-400">{m.blurb}</p>
          {m.notes.map((n) => (
            <p key={n} className="mt-1 text-xs text-amber-300/80">
              {n}
            </p>
          ))}
        </Field>

        <Field label="Mode">
          <Segmented
            value={state.mode}
            options={[
              ["blink", "Blink"],
              ["diff", "Difference"],
            ]}
            onChange={(v) => set({ mode: v as ViewState["mode"] })}
          />
          {state.mode === "diff" && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(["t1", "t2"] as const).map((k) => (
                <label key={k} className="text-xs text-slate-400">
                  {k === "t1" ? "Earlier (T1)" : "Later (T2)"}
                  <select
                    className="mt-1 w-full rounded border border-sky-400/20 bg-slate-900 px-1 py-1 text-slate-200"
                    value={state[k]}
                    onChange={(e) => set({ [k]: Number(e.target.value) })}
                  >
                    {m.epochs.map((ep, i) => (
                      <option key={i} value={i} disabled={!bandEpochs.includes(i)}>
                        Visit {i + 1} · {formatMjdRange(ep.mjd_min, ep.mjd_max)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              {!diffOk && <p className="col-span-2 text-xs text-amber-300">Pick two different visits that both have this detector.</p>}
              <p className="col-span-2 text-xs text-slate-400">
                Amber = brighter in T2, cyan = brighter in T1. Stars that didn't change cancel to black.
              </p>
            </div>
          )}
        </Field>

        <Field label={`Detector ${state.band} · ${det.wl_min}–${det.wl_max} µm`}>
          <div className="grid grid-cols-6 gap-1">
            {m.detectors.map((d) => (
              <button
                key={d.detector}
                title={`${d.wl_min}–${d.wl_max} µm`}
                onClick={() => set({ band: d.detector })}
                className={`rounded border py-1 mono text-xs ${
                  state.band === d.detector ? "border-sky-400 bg-sky-400/15 text-sky-200" : "border-sky-400/20 text-slate-400 hover:text-slate-200"
                }`}
              >
                D{d.detector}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-500">Each frame stacks all of a visit's exposures on one detector (several wavelengths inside its range).</p>
        </Field>

        <Field label="Display">
          <Segmented
            value={state.stretch}
            options={[
              ["asinh", "Asinh"],
              ["linear", "Linear"],
            ]}
            onChange={(v) => set({ stretch: v as ViewState["stretch"] })}
          />
          {isDiff ? (
            <Slider label="Contrast" value={diffPct} min={95} max={99.99} step={0.01} onChange={setDiffPct} fmt={(v) => `${v.toFixed(2)}%`} />
          ) : (
            <>
              <Slider label="Black" value={lo} min={0} max={50} step={0.5} onChange={(v) => setLo(Math.min(v, hi - 1))} fmt={(v) => `${v}%`} />
              <Slider label="White" value={hi} min={60} max={100} step={0.1} onChange={(v) => setHi(Math.max(v, lo + 1))} fmt={(v) => `${v.toFixed(1)}%`} />
              <select
                className="mt-2 w-full rounded border border-sky-400/20 bg-slate-900 px-2 py-1"
                value={cmap}
                onChange={(e) => setCmap(e.target.value as ColormapName)}
              >
                {COLORMAPS.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </>
          )}
          <div className="mt-2 flex flex-col gap-1 text-xs">
            <Check
              label={m.wise.length ? "Include 2010 WISE frame" : "No 2010 WISE frame in this bundle"}
              checked={state.wise && m.wise.length > 0}
              onChange={(v) => set({ wise: v })}
              disabled={state.mode === "diff" || !m.wise.length}
            />
            <Check label={`Gaia DR3 stars, G < ${GAIA_G_LIMIT} (G)`} checked={showGaia} onChange={setShowGaia} />
            <Check label="Pixel grid (zoom in)" checked={pixelGrid} onChange={setPixelGrid} />
          </div>
        </Field>

        <Field label="Target data">
          <dl className="mono grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-slate-500">RA</dt>
            <dd>{formatRa(t.pos_now[0])} ({t.pos_now[0].toFixed(5)}°)</dd>
            <dt className="text-slate-500">Dec</dt>
            <dd>{formatDec(t.pos_now[1])} ({t.pos_now[1].toFixed(5)}°)</dd>
            <dt className="text-slate-500">at</dt>
            <dd>2026.5</dd>
            <dt className="text-slate-500">motion</dt>
            <dd>
              {targetPm.toFixed(2)}″/yr = {(targetPm / m.pixel_scale_arcsec).toFixed(2)} px/yr
            </dd>
            <dt className="text-slate-500">2010→26</dt>
            <dd>{separationArcsec(...t.pos_2010, ...t.pos_now).toFixed(0)}″ moved</dd>
          </dl>
          <p className="mt-1 text-[11px] text-slate-500">{t.source}. Parallax ignored.</p>
        </Field>

        <footer className="mt-auto space-y-1 text-[11px] leading-snug text-slate-500">
          <p>{m.provenance.credit}</p>
          <p>
            SPHEREx DR1 doi:{m.provenance.dois.spherex_dr1} · QR3 doi:{m.provenance.dois.spherex_qr3}. {m.provenance.wise}. {m.provenance.gaia}.
          </p>
          <button className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300" onClick={() => setShowAbout((a) => !a)}>
            <Info size={12} /> How these frames were made
          </button>
          {showAbout && (
            <p>
              {m.provenance.exposures_found} SPHEREx exposures cover this field; {m.exposures.filter((e) => e.used).length} were used. Each was
              downloaded as a cutout, the zodiacal-light model was subtracted, bad pixels (flag bits {m.provenance.mask_bits.join(", ")}) and
              saturated pixels were dropped, and the exposure was resampled to a north-up {m.pixel_scale_arcsec}″/px grid. Exposures from the
              same visit and detector were averaged, weighted by their noise. Baked {m.provenance.baked_utc} by {m.provenance.pipeline}.
            </p>
          )}
        </footer>
      </aside>

      {/* sky */}
      <main className="order-1 flex min-h-[70vh] flex-1 flex-col lg:order-2 lg:min-h-0">
        <div className="relative min-h-[45vh] flex-1">
        <SkyCanvas
          bundle={bundle}
          draw={draw}
          step={step}
          diffMjds={diffYears ? [diffYears[0], diffYears[1]] : undefined}
          showGaia={showGaia}
          handleRef={canvasRef}
          onHover={setHover}
          valueAt={valueAt}
          onPick={onPick}
          selected={selected}
          marks={motion?.pts ?? []}
        />
        {tourIdx !== null && <Tour steps={tourSteps} index={tourIdx} onIndex={goTour} onClose={() => goTour(null)} />}
        {pickHint && (
          <button onClick={() => setPickHint(null)} className="panel absolute left-1/2 top-12 max-w-md -translate-x-1/2 rounded px-3 py-2 text-xs text-slate-300">
            {pickHint}
          </button>
        )}

        <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1">
          <span className="panel rounded px-2 py-1 mono text-xs text-sky-200">
            {isDiff
              ? `Visit ${state.t2 + 1} − Visit ${state.t1 + 1}`
              : step
                ? `${step.label} · ${step.sublabel}`
                : "No frames for this detector"}
          </span>
          {shownYear !== null && step?.kind === "wise" && (
            <span className="panel rounded px-2 py-1 text-xs text-amber-200">Different telescope (WISE, 2010): compare positions, not brightness.</span>
          )}
        </div>
        {!isDiff && step?.kind === "wise" ? (
          <span className="panel absolute right-3 top-3 rounded px-2 py-1 text-xs font-medium text-amber-300" title={m.provenance.wise}>
            AllWISE 2010 (IRSA)
          </span>
        ) : (
          <span className="panel absolute right-3 top-3 rounded px-2 py-1 text-xs font-medium text-emerald-300" title={m.provenance.collections.join(", ")}>
            {m.provenance.label}
          </span>
        )}
        {hover && (
          <span className="panel pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded px-2 py-1 mono text-xs">
            {formatHover(hover)} · {hover.value === null ? "no data" : `${hover.value.toFixed(3)} ${step?.kind === "wise" && !isDiff ? "DN" : "MJy/sr"}`}
          </span>
        )}

        {/* timeline */}
        {state.mode === "blink" && (
          <div className="panel absolute bottom-12 left-1/2 flex max-w-[95%] -translate-x-1/2 items-center gap-2 overflow-x-auto rounded px-2 py-1.5 lg:bottom-3">
            <IconBtn title="Previous (←)" onClick={() => (setPlaying(false), setStepIdx((i) => (i - 1 + steps.length) % Math.max(1, steps.length)))}>
              <SkipBack size={14} />
            </IconBtn>
            <IconBtn title="Play / pause (Space)" onClick={() => setPlaying((p) => !p)}>
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </IconBtn>
            <IconBtn title="Next (→)" onClick={() => (setPlaying(false), setStepIdx((i) => (i + 1) % Math.max(1, steps.length)))}>
              <SkipForward size={14} />
            </IconBtn>
            {steps.map((s, i) => (
              <button
                key={s.layer}
                onClick={() => (setPlaying(false), setStepIdx(i))}
                className={`whitespace-nowrap rounded px-2 py-0.5 mono text-xs ${
                  i === stepIdx % steps.length ? "bg-sky-400/20 text-sky-100" : "text-slate-400 hover:text-slate-200"
                } ${s.kind === "wise" ? "text-amber-300" : ""}`}
              >
                {s.kind === "wise" ? "2010" : `V${s.epoch + 1}`}
              </button>
            ))}
            <label className="flex items-center gap-1 text-xs text-slate-400">
              <input type="range" min={0.5} max={8} step={0.5} value={fps} onChange={(e) => setFps(Number(e.target.value))} className="w-20" />
              <span className="mono w-12">{fps} fps</span>
            </label>
            <IconBtn title="Reset view (R)" onClick={() => canvasRef.current?.resetView()}>
              <RotateCcw size={14} />
            </IconBtn>
          </div>
        )}
        </div>

        {selected && bundle.spectra && (
          <div className="h-[46%] min-h-[260px] shrink-0 border-t border-sky-400/20">
            <SpectrumPanel
              spectra={bundle.spectra}
              source={selected}
              epochs={m.epochs}
              detectors={m.detectors}
              band={state.band}
              tab={tab}
              onTab={setTab}
              onClose={() => setSelectedId(null)}
            >
              <MotionBar
                expectedPx={motion?.expectedPx ?? 0}
                measuring={measure}
                onMeasure={() => setMeasure((x) => !x)}
                fit={motion?.fit ?? null}
                n={motion?.pts.length ?? 0}
                gaia={{ east: selected.pmra / 1000, north: selected.pmdec / 1000 }}
                frames={steps.length}
              />
            </SpectrumPanel>
          </div>
        )}
      </main>
    </div>
  );
}

function MotionBar(p: {
  expectedPx: number;
  measuring: boolean;
  onMeasure: () => void;
  fit: ReturnType<typeof fitMotion>;
  n: number;
  gaia: { east: number; north: number };
  frames: number;
}) {
  const gTot = Math.hypot(p.gaia.east, p.gaia.north);
  if (p.expectedPx < 1) {
    return (
      <p className="mb-1 text-[11px] text-slate-500">
        Motion: Gaia says {gTot.toFixed(3)}″/yr, under one pixel across these {p.frames} frames, so it can't be measured here.
      </p>
    );
  }
  return (
    <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      <button onClick={p.onMeasure} className="inline-flex items-center gap-1 rounded border border-fuchsia-400/40 px-2 py-0.5 text-fuchsia-200 hover:bg-fuchsia-400/10">
        <Compass size={12} /> {p.measuring ? "Hide motion" : "Measure motion"}
      </button>
      {p.measuring && p.fit && (
        <span className="mono text-slate-200">
          measured {p.fit.total.toFixed(2)}{p.fit.sigma !== null ? ` ± ${p.fit.sigma.toFixed(2)}` : ""}″/yr toward PA {p.fit.pa.toFixed(0)}° from {p.n} frames over{" "}
          {p.fit.baselineYears.toFixed(1)} yr · Gaia {gTot.toFixed(2)}″/yr ({(((p.fit.total - gTot) / gTot) * 100).toFixed(0)}%)
        </span>
      )}
      {p.measuring && !p.fit && <span className="text-amber-300">Couldn't find the star in enough frames.</span>}
      {p.measuring && (
        <span className="text-slate-500">Centroids (pink ×) of this detector's frames{p.frames > 1 ? "" : ""}; the search starts at the Gaia position for each date.</span>
      )}
    </div>
  );
}

function stripSilent(p: ReturnType<typeof parseState>): Partial<ViewState> {
  const { silent, ...rest } = p;
  void silent;
  return rest;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-400">{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</h2>
      {children}
    </section>
  );
}

function Segmented({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="grid grid-flow-col gap-1 rounded border border-sky-400/20 p-0.5">
      {options.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)} className={`rounded py-1 text-xs ${value === v ? "bg-sky-400/20 text-sky-100" : "text-slate-400 hover:text-slate-200"}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Slider(p: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt: (v: number) => string }) {
  return (
    <label className="mt-2 flex items-center gap-2 text-xs text-slate-400">
      <span className="w-14">{p.label}</span>
      <input type="range" className="flex-1" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} />
      <span className="mono w-14 text-right">{p.fmt(p.value)}</span>
    </label>
  );
}

function Check({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`flex items-center gap-2 ${disabled ? "opacity-40" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} aria-label={title} onClick={onClick} className="rounded p-1 text-slate-300 hover:bg-sky-400/10">
      {children}
    </button>
  );
}
