import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Compass, Route, BookOpen, Settings, TriangleAlert, Activity, ChevronRight, Download, Send, Share2, Film, Camera, Copy, Check as CheckIcon } from "lucide-react";
import { buildFits, card, download, longCards, wcsCards } from "./lib/fitsio";
import { encodeAnimatedGif, type GifFrame } from "./lib/gif";
import { liveAvailable } from "./lib/live";
import { sendViaSamp } from "./lib/samp";
import { GAIA_G_LIMIT, SkyCanvas, formatHover, type HoverInfo, type SkyCanvasHandle } from "./components/SkyCanvas";
import { SpectrumPanel, type MapOverlay, type PanelTab } from "./components/SpectrumPanel";
import { ColourMixer } from "./components/ColourMixer";
import { Accuracy } from "./components/Accuracy";
import { PRESETS, blowOutSaturated, colourLevels, fillPinholes, mainToCube, mapSpectrum, mapSpectrumCaveat, whyColour, windowMean, windowShares, type Mix } from "./lib/colour";
import { ColourIntro } from "./components/ColourIntro";
import { Tour } from "./components/Tour";
import { availableSteps, type TourContext, type TourSetup } from "./lib/tour";
import { MEM_PREFIX, memFetch } from "./lib/browser/fieldbuild";
import { flagPlane as flagPlaneOf, framePlane, loadBundle, loadIndex, loadRemoteIndex, matchedPlane, resolveRemoteDataRoot, shortName, type Bundle, type IndexEntry } from "./lib/bundle";
import { TargetBar } from "./components/TargetBar";
import { Timeline } from "./components/Timeline";
import { WavelengthPicker } from "./components/WavelengthPicker";
import { blinkSteps, epochsWithBand, layerOf, matchedLayer, stepPlane, type Step } from "./lib/sequence";
import { diffLimit, levelsFor, subtract } from "./lib/stretch";
import { DEFAULT_STATE, parseLive, parseState, serializeState, type ViewState } from "./lib/urlState";
import { LiveSearch, type LiveResult, type SourceMode } from "./components/LiveSearch";
import { DataSourceStatus } from "./components/DataSourceStatus";
import { ExportDialog } from "./components/ExportDialog";
import { composePngFigure, type ExportOptions } from "./lib/exportFigure";
import { GuideAndSettings, type HelpTab } from "./components/GuideAndSettings";
import { liveBase, FORCE_BROWSER } from "./lib/live";
import { COLORMAPS, COLORMAP_LABELS, buildLut, type ColormapName } from "./gl/colormaps";
import { formatMjdMonth, formatMjdRange, mjdToYear, propagate } from "./lib/astro";
import { formatDec, formatRa, pixelToWorld, separationArcsec, worldToPixel } from "./lib/wcs";
import { FLAG_OK, REFERENCE_BANDS, nearestSource, points } from "./lib/spectra";
import { centroid, fitMotion } from "./lib/motion";
import { stopSound } from "./lib/sonify";

const initialUrl = parseState(window.location.search);
const initialLive = parseLive(window.location.search);
const SILENT = initialUrl.silent;
const REDUCED_MOTION = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

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


export default function App() {
  const [index, setIndex] = useState<IndexEntry[] | null>(null);
  const [liveEntries, setLiveEntries] = useState<IndexEntry[]>([]);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<ViewState>({ ...DEFAULT_STATE, ...stripSilent(initialUrl) });
  const [stepIdx, setStepIdx] = useState(0);
  const [playing, setPlaying] = useState(() => !REDUCED_MOTION);
  const [fps, setFps] = useState(1.5);
  const [showGaia, setShowGaia] = useState(true);
  const [showFlags, setShowFlags] = useState(false);
  const [pixelGrid, setPixelGrid] = useState(false);
  const [lo, setLo] = useState(20);
  const [hi, setHi] = useState(99.8);
  const [smooth, setSmooth] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [helpTab, setHelpTab] = useState<HelpTab>("science");
  const [irsaUpstream502, setIrsaUpstream502] = useState(false);
  const [sourceMode, setSourceMode] = useState<SourceMode>(() => {
    const saved = storage.get("spherex-blink.sourceMode");
    return saved === "browser" || saved === "server" ? saved : "auto";
  });
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const checkServer = useCallback(() => {
    if (FORCE_BROWSER) {
      setServerOnline(false);
      return;
    }
    setServerOnline(null);
    liveAvailable().then(setServerOnline);
  }, []);
  useEffect(() => {
    checkServer();
  }, [checkServer]);
  const updateSourceMode = useCallback((m: SourceMode) => {
    setSourceMode(m);
    storage.set("spherex-blink.sourceMode", m);
  }, []);
  const [shortcutsOn, setShortcutsOn] = useState(() => storage.get("spherex-blink.shortcuts") !== "off");
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [diffPct, setDiffPct] = useState(99.8);
  const [cmap, setCmap] = useState<ColormapName>("night");
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const canvasRef = useRef<SkyCanvasHandle>(null);
  const urlApplied = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<PanelTab>("spectrum");
  const [measure, setMeasure] = useState(false);
  const [pickHint, setPickHint] = useState<string | null>(null);
  const [tourIdx, setTourIdx] = useState<number | null>(() => (storage.get(TOUR_KEY) || initialUrl.target || initialLive ? null : 0)); // a shared link opens straight to its view
  const pending = useRef<TourSetup | null>(null);
  // colour mode
  const [mix, setMix] = useState<Mix>(PRESETS[0].mix);
  const [colourSource, setColourSource] = useState<"fine" | "archive">("fine");
  const [presetId, setPresetId] = useState<string | null>(PRESETS[0].id);
  const [mapPoint, setMapPoint] = useState<{ x: number; y: number; mx: number; my: number; ra: number; dec: number } | null>(null);
  const frameWant = useRef<TourSetup["frame"] | null>(null);

  // index, then the chosen target (plus non-blocking merge from secondary data repo)
  useEffect(() => {
    let cancelled = false;
    loadIndex()
      .then((local) => {
        if (cancelled) return;
        setIndex(local);
        loadRemoteIndex().then((remote) => {
          if (cancelled || remote.length === 0) return;
          setIndex((prev) => {
            const base = prev ?? local;
            const seen = new Set(base.map((t) => t.id));
            const extra = remote.filter((t) => !seen.has(t.id));
            return extra.length > 0 ? [...base, ...extra] : base;
          });
        });
      })
      .catch((e) => {
        // if local index.json is missing, still try the remote data repo before failing
        loadRemoteIndex().then((remote) => {
          if (cancelled) return;
          if (remote.length > 0) setIndex(remote);
          else setError(`No baked targets found (${e.message}). Run the bake step in backend/.`);
        });
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!index) return;
    const all = [...index, ...liveEntries];
    const entry = all.find((t) => t.id === state.target) ?? index[0];
    const id = entry?.id;
    if (!id) return;
    let live = true;
    setLoadingId(id); // keep showing the old target until the new one is ready
    const fetcher = entry.base?.startsWith(MEM_PREFIX) ? memFetch : fetch;
    loadBundle(id, fetcher, entry.base)
      .catch((err) => {
        if (entry.base) throw err;
        return loadBundle(id, fetch, `${resolveRemoteDataRoot()}/${encodeURIComponent(id)}`);
      })
      .then((b) => {
        if (!live) return;
        setBundle(b);
        setLoadingId(null);
        setStepIdx(0);
        setMeasure(false);
        setPickHint(null);
        setMapPoint(null);
        const tourAct = pending.current?.target === id ? pending.current : null;
        pending.current = null;
        setSelectedId(tourAct?.select ?? null);
        // each target opens Colour mode with the preset that shows it best
        const preset = PRESETS.find((p) => p.id === (tourAct?.preset ?? b.meta.colour_preset)) ?? PRESETS[0];
        setPresetId(preset.id);
        setMix(preset.mix);
        if (tourAct) {
          if (tourAct.tab) setTab(tourAct.tab);
          if (tourAct.playing !== undefined) setPlaying(tourAct.playing);
          if (tourAct.frame) frameWant.current = tourAct.frame;
        }
        // decide outside the updater: StrictMode runs updaters twice
        const fromUrl = !urlApplied.current && !tourAct;
        urlApplied.current = true;
        setState((s) => {
          if (tourAct) {
            const E = b.meta.epochs.length;
            const next = { ...s, target: id, mode: b.meta.default_mode, band: b.meta.default_band, t1: 0, t2: E - 1, ...(tourAct.patch ?? {}) };
            next.t1 = Math.max(0, Math.min(next.t1, E - 1));
            next.t2 = Math.max(0, Math.min(next.t2, E - 1));
            return next;
          }
          const E = b.meta.epochs.length;
          const next: ViewState = fromUrl
            ? { ...s, target: id }
            : { ...s, target: id, mode: b.meta.default_mode, band: b.meta.default_band, t1: 0, t2: E - 1 };
          if (fromUrl && initialUrl.mode === undefined) next.mode = b.meta.default_mode;
          if (fromUrl && initialUrl.band === undefined) next.band = b.meta.default_band;
          if (fromUrl && initialUrl.t2 === undefined) next.t2 = E - 1;
          next.t1 = Math.max(0, Math.min(next.t1, E - 1));
          next.t2 = Math.max(0, Math.min(next.t2, E - 1));
          if (E === 0) next.mode = "colour";
          return next;
        });
      })
      .catch((e) => live && setError(`Couldn't load ${id}: ${e.message}`));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, state.target, liveEntries]);

  // URL sync
  useEffect(() => {
    if (!bundle) return;
    let q = serializeState(state, SILENT);
    const lv = liveEntries.find((t) => t.id === state.target)?.live;
    if (lv) {
      // a live field is shared by its coordinates, so the link works for anyone running the server
      const p = new URLSearchParams(q);
      p.delete("target");
      p.delete("silent");
      p.set("ra", lv.ra.toFixed(5));
      p.set("dec", lv.dec.toFixed(5));
      p.set("fov", String(lv.fov));
      q = p.toString() + (SILENT ? "&silent" : "");
    }
    if (FORCE_BROWSER) q += "&browser";
    if (q !== window.location.search.slice(1)) window.history.replaceState(null, "", `?${q}`);
  }, [state, bundle]);

  const [showNeowise, setShowNeowise] = useState(true);
  const steps: Step[] = useMemo(() => (bundle ? blinkSteps(bundle, state.band, state.wise, showNeowise) : []), [bundle, state.band, state.wise, showNeowise]);
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
    return levelsFor(stepPlane(bundle, step, state.band), lo, hi);
  }, [bundle, step, lo, hi]);

  const diffOk = bundle && bandEpochs.includes(state.t1) && bandEpochs.includes(state.t2) && state.t1 !== state.t2;
  const diffState = useMemo(() => {
    if (!bundle || !diffOk) return null;
    const plain = subtract(framePlane(bundle, state.t2, state.band), framePlane(bundle, state.t1, state.band));
    // S2: wavelength-matched frames when the bundle has them and channel overlap covers most of the field
    const m2 = matchedPlane(bundle, state.t2, state.band);
    const m1 = matchedPlane(bundle, state.t1, state.band);
    if (m2 && m1) {
      const matched = subtract(m2, m1);
      let plainN = 0;
      let matchedN = 0;
      for (let i = 0; i < plain.length; i++) {
        if (Number.isFinite(plain[i])) plainN++;
        if (Number.isFinite(matched[i])) matchedN++;
      }
      if (matchedN >= 0.6 * plainN) return { data: matched, matched: true };
    }
    return { data: plain, matched: false };
  }, [bundle, diffOk, state.t1, state.t2, state.band]);
  const diffData = diffState?.data ?? null;
  const limit = useMemo(() => (diffData ? diffLimit(diffData, diffPct) : 1), [diffData, diffPct]);

  const isDiff = state.mode === "diff" && !!diffData;
  const isDiffRef = useRef(isDiff);
  isDiffRef.current = isDiff;
  const levels = step?.kind === "wise" && wiseLevels ? wiseLevels : spxLevels;

  const hasMatched = diffState ? diffState.matched : !!bundle?.meta.layout.matched;
  // Colour from our own 6.15" map (twice as sharp) unless the visitor picks NASA's archive map
  // contamination flags for the frame on screen (the later visit in a difference)
  const flagEpoch = state.mode === "diff" ? state.t2 : step?.kind === "spherex" ? step.epoch : -1;
  const flagsOnScreen = showFlags && bundle && flagEpoch >= 0 && state.mode !== "colour" ? flagPlaneOf(bundle, flagEpoch, state.band) : null;
  const flagSummary = bundle?.meta.flags?.summary?.[flagEpoch]?.[state.band - 1] ?? null;
  // our map only when it is (nearly) complete: a quick look has too few exposures to fill every channel
  const fineComplete = ((bundle?.meta.finecube as { coverage?: { median_pixel_fill?: number } } | null | undefined)?.coverage?.median_pixel_fill ?? 0) >= 0.9;
  const cube = (colourSource === "fine" && fineComplete ? bundle?.finecube : null) ?? bundle?.cube ?? bundle?.finecube ?? null;
  const isColour = state.mode === "colour" && !!cube;
  // One brightness scale for all three colours ("true ratios"): a colour then means more light at that
  // wavelength. Black at the sky level (median), white near the brightest star; the renderer stretches
  // the combined brightness and keeps the ratios.
  const colourView = useMemo(() => {
    if (!cube || state.mode !== "colour") return null;
    const raw = [windowMean(cube, mix.r), windowMean(cube, mix.g), windowMean(cube, mix.b)] as [Float32Array, Float32Array, Float32Array];
    const lv = colourLevels(raw, 50, 99.0, "physical");
    const blown = blowOutSaturated(raw, cube.n, lv.white);
    blown.planes = fillPinholes(blown.planes, cube.n);
    return { planes: { planes: blown.planes, n: cube.n }, raw, levels: lv, blownOut: blown.count };
  }, [cube, mix, state.mode]);
  const colourPlanes = colourView?.planes ?? null;
  const colourLv = colourView?.levels ?? null;
  const cubeMid = cube && cube.desc.mjd_min !== null && cube.desc.mjd_max !== null ? (cube.desc.mjd_min + cube.desc.mjd_max) / 2 : undefined;

  const draw = {
    mode: isColour ? ("colour" as const) : isDiff ? ("diff" as const) : ("single" as const),
    colour:
      isColour && colourLv && bundle && cube
        ? { ...colourLv, cubeScale: (bundle.width * bundle.meta.pixel_scale_arcsec) / (cube.n * cube.desc.pixel_scale_arcsec) }
        : undefined,
    layerA: isDiff ? (hasMatched ? matchedLayer(bundle!, state.t2, state.band) : layerOf(state.t2, state.band)) : (step?.layer ?? 0),
    layerB: isDiff ? (hasMatched ? matchedLayer(bundle!, state.t1, state.band) : layerOf(state.t1, state.band)) : 0,
    black: levels.black,
    white: levels.white,
    limit,
    stretch: state.stretch,
    mix: 0,
    colormap: cmap,
    pixelGrid,
    smooth,
  };

  const valueAt = useCallback(
    (x: number, y: number) => {
      if (!bundle) return null;
      const i = y * bundle.width + x;
      if (isDiff && diffData) return diffData[i];
      if (!step) return null;
      const p = stepPlane(bundle, step, state.band);
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
  useEffect(() => {
    if (bandEpochs.length < 2) return;
    const t1Ok = bandEpochs.includes(state.t1);
    const t2Ok = bandEpochs.includes(state.t2);
    if (t1Ok && t2Ok && state.t1 !== state.t2) return;
    const nextT1 = t1Ok ? state.t1 : bandEpochs[0];
    let nextT2 = t2Ok ? state.t2 : bandEpochs[bandEpochs.length - 1];
    if (nextT1 === nextT2) nextT2 = bandEpochs.find((e) => e !== nextT1) ?? nextT2;
    set({ t1: nextT1, t2: nextT2 });
  }, [bandEpochs, state.t1, state.t2, set]);

  const onLiveReady = useCallback(
    (r: LiveResult) => {
      setLiveEntries((cur) => [
        ...cur.filter((e) => e.id !== r.id),
        {
          id: r.id,
          name: r.name || `RA ${r.ra.toFixed(3)}°, Dec ${r.dec.toFixed(3)}°`,
          tagline: r.shared ? "Shared files · not checked against NASA's archive" : r.browser ? `Your field · ${r.fov}′ · built in this browser` : `Your field · ${r.fov}′ · live from NASA`,
          status: "ready",
          base: r.browser ? `${MEM_PREFIX}${r.id}` : liveBase(r.id),
          live: { ra: r.ra, dec: r.dec, fov: r.fov },
        },
      ]);
      set({ target: r.id });
    },
    [set],
  );

  // ---- guided tour: only steps whose target is baked
  const tourSteps = useMemo(() => availableSteps(index?.map((x) => x.id) ?? []), [index]);
  const goTour = useCallback(
    (i: number | null) => {
      if (i === null || !tourSteps[i]) {
        setTourIdx(null);
        storage.set(TOUR_KEY, "1");
        return;
      }
      setTourIdx(i);
      const a = tourSteps[i].setup;
      if (!a) return;
      if (a.target && (!bundle || bundle.meta.id !== a.target)) {
        pending.current = a;
        set({ target: a.target });
        return;
      }
      if (a.patch) {
        const E = bundle ? bundle.meta.epochs.length : 1;
        setState((s) => {
          const next = { ...s, ...a.patch };
          next.t1 = Math.max(0, Math.min(next.t1, E - 1));
          next.t2 = Math.max(0, Math.min(next.t2, E - 1));
          return next;
        });
      }
      if (a.select !== undefined) setSelectedId(a.select);
      if (a.tab) setTab(a.tab);
      if (a.playing !== undefined) setPlaying(a.playing);
      if (a.frame) frameWant.current = a.frame;
      if (a.preset) {
        const p = PRESETS.find((x) => x.id === a.preset);
        if (p) {
          setPresetId(p.id);
          setMix(p.mix);
        }
      }
    },
    [tourSteps, bundle, set],
  );
  // a tour step can ask for a particular frame once the blink steps exist
  useEffect(() => {
    const want = frameWant.current;
    if (!want || !steps.length) return;
    const i = steps.findIndex((s) => (want === "wise" ? s.kind === "wise" : s.kind === "spherex"));
    if (i >= 0) setStepIdx(i);
    frameWant.current = null;
  });
  const tourCtx: TourContext = {
    target: bundle?.meta.id ?? "",
    mode: state.mode,
    band: state.band,
    frameKind: step?.kind ?? null,
    playing,
    selectedId,
    tab,
  };
  const tourStep = tourIdx !== null ? tourSteps[tourIdx] : null;
  const taskDone = !!tourStep?.done?.(tourCtx);
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
      if (state.mode === "colour" && bundle.cube) {
        // any point: nearest baked star if there is one, else a map spectrum of that spot
        const mjd = cubeMid ?? bundle.meta.epochs[0].mjd;
        const src = bundle.spectra ? nearestSource(bundle.spectra, bundle.meta.wcs, x, y, mjd, 2.5) : null;
        setPickHint(null);
        setMeasure(false);
        if (src) {
          setSelectedId(src.id);
          setMapPoint(null);
        } else {
          const [cx, cy] = mainToCube(bundle.meta.wcs, bundle.cube.desc.wcs, x, y);
          const [ra, dec] = pixelToWorld(bundle.meta.wcs, x, y);
          setSelectedId(null);
          setMapPoint({ x: cx, y: cy, mx: x, my: y, ra, dec });
        }
        return;
      }
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
        setPickHint(
          `Per-exposure spectra exist for the target and the ${bundle.spectra.sources.length - 1} brightest Gaia stars here (G < 15). Click closer to one${
            bundle.cube ? ", or switch to Colour to get a map spectrum of any point" : ""
          }.`,
        );
      }
    },
    [bundle, step, state.t2, state.mode, cubeMid],
  );

  const mapOverlay = useMemo((): MapOverlay | null => {
    if (!cube) return null;
    const label = "All-sky map (time-averaged)";
    if (selected) {
      const pm = Math.hypot(selected.pmra, selected.pmdec) / 1000;
      const caveat = mapSpectrumCaveat(cube, pm, selected.id === "target" && !!bundle?.meta.variable);
      if (caveat) return { spectrum: null, caveat, label };
      const [ra, dec] = propagate(selected.ra, selected.dec, selected.pmra, selected.pmdec, selected.ref_year, mjdToYear(cubeMid ?? 61000));
      const [cx, cy] = worldToPixel(cube.desc.wcs, ra, dec);
      return { spectrum: mapSpectrum(cube, cx, cy), caveat: null, label };
    }
    if (mapPoint) return { spectrum: mapSpectrum(cube, mapPoint.x, mapPoint.y), caveat: null, label };
    return null;
  }, [cube, selected, mapPoint, bundle, cubeMid]);

  // "Why does it look this colour?" from the source's own clean measurements (or the map spectrum)
  const colourWhy = useMemo((): string | null => {
    if (!isColour) return null;
    // Explain with the same data the picture is made from (the all-sky map) when there is a map
    // spectrum; otherwise fall back to the star's own clean single-exposure points.
    let wl: number[] = [];
    let fl: number[] = [];
    if (mapOverlay?.spectrum) {
      mapOverlay.spectrum.flux.forEach((f, i) => {
        if (f !== null) {
          wl.push(mapOverlay.spectrum!.wl[i]);
          fl.push(f);
        }
      });
    } else if (selected && bundle?.spectra) {
      const good = points(bundle.spectra, selected).filter((p) => p.flag === FLAG_OK);
      wl = good.map((p) => p.wl);
      fl = good.map((p) => p.flux);
    }
    const shares = windowShares(wl, fl, mix);
    if (!shares) return selected ? "Too bright (saturated) or too faint in these windows to say what colour it really is." : null;
    return whyColour(shares, mix, REFERENCE_BANDS);
  }, [isColour, selected, bundle, mapOverlay, mix]);

  // S5: save what's on screen as FITS (raw values, never the display-only fills), with WCS and provenance
  const currentFitsPayload = useCallback(() => {
    if (!bundle) return null;
    const m = bundle.meta;
    const common = [
      card("ORIGIN", "SPHEREx Blink"),
      card("OBJECT", shortName(m.name)),
      card("RADESYS", "ICRS"),
      card("REFERENC", "doi:10.26131/IRSA678 doi:10.26131/IRSA662"),
      ...longCards("COMMENT", `${m.provenance.credit} Pipeline ${m.provenance.pipeline}, baked ${m.provenance.baked_utc}.`),
    ];
    let data: Float32Array;
    let axes: number[];
    let wcs = m.wcs;
    let extra: string[] = [];
    let name = `${m.id}`;
    if (isColour && cube && colourView) {
      const n = cube.n;
      data = new Float32Array(3 * n * n);
      colourView.raw.forEach((pl, k) => data.set(pl, k * n * n));
      axes = [n, n, 3];
      wcs = cube.desc.wcs;
      extra = [
        card("TELESCOP", "SPHEREx"),
        card("BUNIT", "MJy/sr"),
        card("PLANE1", `red ${mix.r.lo}-${mix.r.hi} um`),
        card("PLANE2", `green ${mix.g.lo}-${mix.g.hi} um`),
        card("PLANE3", `blue ${mix.b.lo}-${mix.b.hi} um`),
        card("MJD-BEG", cube.desc.mjd_min ?? 0),
        card("MJD-END", cube.desc.mjd_max ?? 0),
        ...longCards("COMMENT", `Mean of the 102-channel map's channels inside each window. ${cube.desc.note}`),
      ];
      name += "-colour";
    } else if (isDiff && diffData) {
      data = diffData;
      axes = [bundle.width, bundle.height];
      extra = [
        card("TELESCOP", "SPHEREx"),
        card("BUNIT", "MJy/sr"),
        card("DETECTOR", state.band),
        card("WAVEMIN", m.detectors[state.band - 1].wl_min, "[um]"),
        card("WAVEMAX", m.detectors[state.band - 1].wl_max, "[um]"),
        card("MJD-T2", m.epochs[state.t2].mjd, "later visit"),
        card("MJD-T1", m.epochs[state.t1].mjd, "earlier visit"),
        ...longCards("COMMENT", hasMatched ? "Later minus earlier visit, matched by wavelength: each visit minus the all-visit map, channel by channel, sky gradient removed." : "Later minus earlier visit stack."),
      ];
      name += `-diff-v${state.t2 + 1}-v${state.t1 + 1}-d${state.band}`;
    } else if (step) {
      const wise = step.kind === "wise";
      data = stepPlane(bundle, step, state.band);
      axes = [bundle.width, bundle.height];
      extra = wise
        ? [card("TELESCOP", "WISE"), card("BUNIT", "DN"), card("MJD-AVG", step.mjd), ...longCards("COMMENT", `AllWISE atlas image resampled to the SPHEREx grid. ${m.provenance.wise}.`)]
        : [
            card("TELESCOP", "SPHEREx"),
            card("BUNIT", "MJy/sr"),
            card("DETECTOR", state.band),
            card("WAVEMIN", m.detectors[state.band - 1].wl_min, "[um]"),
            card("WAVEMAX", m.detectors[state.band - 1].wl_max, "[um]"),
            card("MJD-AVG", step.mjd),
            card("NEXPOSUR", m.epochs[step.epoch].bands[state.band - 1].n, "exposures stacked"),
            ...longCards("COMMENT", "Inverse-variance stack of zodi-subtracted single exposures, resampled north-up."),
          ];
      name += wise ? "-wise2010" : `-v${step.epoch + 1}-d${state.band}`;
    } else return null;
    return { filename: `${name}.fits`, bytes: buildFits(axes, data, [...wcsCards(wcs), ...common, ...extra]) };
  }, [bundle, isColour, cube, colourView, mix, isDiff, diffData, state.band, state.t1, state.t2, hasMatched, step]);

  const exportFits = useCallback(() => {
    const p = currentFitsPayload();
    if (p) download(p.filename, p.bytes, "application/fits");
  }, [currentFitsPayload]);

  const [sampNote, setSampNote] = useState<string | null>(null);
  const [gifBusy, setGifBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportOpts, setExportOpts] = useState<ExportOptions>({
    format: "png",
    layout: "current",
    includeHeader: true,
    includeFooter: true,
    includeOverlays: true,
    includeSpectrum: false,
  });
  const [linkCopied, setLinkCopied] = useState(false);
  const [coordsCopied, setCoordsCopied] = useState(false);
  const sampTimer = useRef<number | null>(null);
  const flashSamp = useCallback((msg: string) => {
    setSampNote(msg);
    if (sampTimer.current) window.clearTimeout(sampTimer.current);
    sampTimer.current = window.setTimeout(() => setSampNote(null), 5000);
  }, []);
  const sampFits = useCallback(async () => {
    const p = currentFitsPayload();
    if (!p) return;
    try {
      await sendViaSamp({ filename: p.filename, data: p.bytes, contentType: "application/fits", mtype: "image.load.fits", label: p.filename });
      flashSamp("Sent FITS to SAMP hub");
    } catch (e) {
      flashSamp(e instanceof Error ? e.message : String(e));
    }
  }, [currentFitsPayload, flashSamp]);

  const exportSpectrum = useMemo(() => {
    if (!bundle) return null;
    if (isColour && mapOverlay?.spectrum?.wl?.length) {
      return {
        title: `Map point ${formatRa(mapPoint!.ra)} ${formatDec(mapPoint!.dec)}`,
        points: mapOverlay.spectrum.wl
          .map((wl, i) => ({
            i,
            wl,
            bw: 0,
            flux: mapOverlay.spectrum!.flux[i] ?? NaN,
            err: 0,
            flag: FLAG_OK,
            epoch: 0,
            det: 1,
            mjd: 0,
          }))
          .filter((p) => Number.isFinite(p.flux)),
      };
    }
    const src = selected ?? bundle.spectra?.sources.find((s) => s.id === "target") ?? bundle.spectra?.sources[0] ?? null;
    if (src && bundle.spectra) {
      return {
        title: src.id === "target" ? shortName(bundle.meta.name) : src.name,
        points: points(bundle.spectra, src),
      };
    }
    return null;
  }, [bundle, isColour, mapOverlay, mapPoint, selected]);

  const runExport = useCallback(async () => {
    if (!bundle || gifBusy) return;
    const m = bundle.meta;
    const det = m.detectors[state.band - 1];
    const fovArcmin = (bundle.width * m.pixel_scale_arcsec) / 60;

    if (exportOpts.format === "gif") {
      if (!steps.length) return;
      setGifBusy(true);
      setPlaying(false);
      if (state.mode !== "blink") {
        set({ mode: "blink" });
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      const prevIdx = stepIdx;
      try {
        const frames: GifFrame[] = [];
        let gw = 0;
        let gh = 0;
        const delayCs = Math.max(10, Math.round(100 / Math.max(0.5, fps)));
        const footer = `${formatRa(m.wcs.crval[0])} ${formatDec(m.wcs.crval[1])} · ${fovArcmin.toFixed(1)}′ · D${state.band} ${det.wl_min}–${det.wl_max} µm · ${m.pixel_scale_arcsec.toFixed(2)}″/px`;
        for (let i = 0; i < steps.length; i++) {
          setStepIdx(i);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const snap = canvasRef.current?.snapshot({
            header: exportOpts.includeHeader ? `${shortName(m.name)} · ${steps[i].label}` : undefined,
            footer: exportOpts.includeFooter ? footer : undefined,
            includeOverlays: exportOpts.includeOverlays,
            maxW: 480,
          });
          if (snap) {
            gw = snap.width;
            gh = snap.height;
            frames.push({ rgba: snap.rgba, delayCs });
          }
        }
        if (frames.length && gw > 0 && gh > 0) {
          const bytes = encodeAnimatedGif(gw, gh, frames);
          download(`${m.id}-blink.gif`, bytes, "image/gif");
        }
        setExportOpen(false);
      } finally {
        setStepIdx(prevIdx);
        setGifBusy(false);
      }
      return;
    }

    const modeLabel =
      exportOpts.layout === "presets-grid" && cube
        ? "4-Preset Infrared Comparison"
        : isColour
          ? PRESETS.find((p) => p.id === presetId)?.name ?? `RGB (${mix.r.lo}–${mix.r.hi}/${mix.g.lo}–${mix.g.hi}/${mix.b.lo}–${mix.b.hi} µm)`
          : isDiff
            ? `Difference (${formatMjdMonth(m.epochs[state.t2].mjd)} − ${formatMjdMonth(m.epochs[state.t1].mjd)})`
            : step
              ? step.label
              : "Sky";
    const wlLabel =
      exportOpts.layout === "presets-grid"
        ? "0.75–5.0 µm (4 presets)"
        : isColour
          ? `R ${mix.r.lo}–${mix.r.hi} G ${mix.g.lo}–${mix.g.hi} B ${mix.b.lo}–${mix.b.hi} µm`
          : step?.kind === "wise" && !isDiff
            ? "WISE"
            : `D${state.band} ${det.wl_min}–${det.wl_max} µm`;
    const scaleLabel = (exportOpts.layout === "presets-grid" || isColour) && cube ? `${cube.desc.native_scale_arcsec}″/px` : `${m.pixel_scale_arcsec.toFixed(2)}″/px`;
    const baseSnap =
      exportOpts.layout === "current"
        ? canvasRef.current?.snapshot({
            maxW: 960,
            includeOverlays: exportOpts.includeOverlays,
          })
        : null;
    const figCanvas = composePngFigure({
      baseRgba: baseSnap,
      cube,
      stretch: state.stretch,
      smooth,
      options: exportOpts,
      headerText: `${shortName(m.name)} · ${modeLabel}`,
      footerText: `${formatRa(m.wcs.crval[0])} ${formatDec(m.wcs.crval[1])} · ${fovArcmin.toFixed(1)}′ · ${wlLabel} · ${scaleLabel} · SPHEREx Blink`,
      spectrum: exportSpectrum,
    });
    if (!figCanvas) return;
    figCanvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const suffix = exportOpts.layout === "presets-grid" ? "presets-2x2" : state.mode;
      a.download = `${m.id}-${suffix}.png`;
      a.click();
      URL.revokeObjectURL(url);
      setExportOpen(false);
    }, "image/png");
  }, [bundle, gifBusy, exportOpts, steps, state.mode, state.band, state.t1, state.t2, state.stretch, stepIdx, fps, set, cube, isColour, presetId, mix, isDiff, step, smooth, exportSpectrum]);

  const copyShareLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 2500);
    } catch {
      flashSamp("Copy the URL from your browser's address bar.");
    }
  }, [flashSamp]);

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
        const plane = stepPlane(bundle, s, state.band);
        const [ra, dec] = propagate(selected.ra, selected.dec, selected.pmra, selected.pmdec, selected.ref_year, year);
        const [sx, sy] = worldToPixel(bundle.meta.wcs, ra, dec);
        const c = centroid(plane, bundle.width, bundle.height, sx, sy, 3);
        return c ? { year, x: c.x, y: c.y, label: s.kind === "wise" ? s.label.replace("WISE ", "") : `V${s.epoch + 1}` } : null;
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
      const el = e.target instanceof HTMLElement ? e.target : null;
      // never steal keys from text fields, menus or sliders (the colour mixer uses the arrow keys)
      if (el && (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el.isContentEditable || el.getAttribute("role") === "slider")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // single-key shortcuts can be switched off (WCAG 2.1.4); Esc always works
      if (!shortcutsOn && e.key !== "Escape") return;
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
          if (bundle?.meta.epochs.length) set({ mode: state.mode === "diff" ? "blink" : "diff" });
          break;
        case "c":
        case "C":
          if (bundle?.cube && bundle.meta.epochs.length) set({ mode: state.mode === "colour" ? "blink" : "colour" });
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
          stopSound();
          setSelectedId(null);
          setPickHint(null);
          setShowHelp(false);
          break;
        case "n":
        case "N": {
          const srcs = bundle?.spectra?.sources ?? [];
          if (!srcs.length) break;
          const cur = srcs.findIndex((s) => s.id === selectedId);
          const next = (cur + (e.shiftKey ? -1 : 1) + srcs.length) % srcs.length;
          setSelectedId(srcs[next < 0 ? 0 : next].id);
          setMapPoint(null);
          setMeasure(false);
          break;
        }
        case "p":
        case "P":
          setSmooth((s) => !s);
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [steps.length, state.mode, set, bundle, shortcutsOn, selectedId]);

  if (error) return <Centered>{error}</Centered>;
  if (!index || !bundle) return <Centered>Loading SPHEREx data…</Centered>;

  const m = bundle.meta;
  const t = m.target;
  const diffYears = isDiff ? [m.epochs[state.t1].mjd, m.epochs[state.t2].mjd] : null;
  const targetPm = Math.hypot(t.pmra, t.pmdec) / 1000; // arcsec/yr
  const det = m.detectors[state.band - 1];

  const sourceLabel =
    !isDiff && step?.kind === "wise"
      ? step.source?.kind === "neowise"
        ? "NEOWISE single exposures, median per visit · NASA/JPL-Caltech/UCLA via IRSA"
        : "AllWISE 2010 · NASA/JPL-Caltech/UCLA via IRSA"
      : `${m.provenance.label} · NASA/JPL-Caltech/IPAC`;

  return (
    <div className="flex h-full flex-col">
      {tourIdx !== null && <Tour steps={tourSteps} index={tourIdx} taskDone={taskDone} onIndex={goTour} onClose={() => goTour(null)} />}
      {/* header */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-1.5 pt-2.5">
        <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
          <circle cx="14" cy="14" r="12" fill="none" stroke="#38bdf8" strokeOpacity="0.5" />
          <circle cx="14" cy="14" r="5" fill="#38bdf8" />
          <circle cx="22" cy="8" r="2" fill="#fbbf24" />
        </svg>
        <div className="min-w-0">
          <h1 className="text-base font-semibold leading-tight text-white">SPHEREx Blink</h1>
          <p className="truncate text-xs text-slate-400">Watch the infrared sky change, using real data from NASA's SPHEREx telescope</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {irsaUpstream502 && (
            <span
              role="status"
              title="IRSA's live search returned HTTP 502 (Bad Gateway). Showing baked local/mirror datasets instead."
              className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/35 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-200"
            >
              <TriangleAlert size={12} className="text-amber-300" />
              IRSA Upstream 502 — Using Offline/Mirror Data
            </span>
          )}
          {tourSteps.length > 0 && (
            <button onClick={() => goTour(0)} className="inline-flex items-center gap-1.5 rounded-md border border-sky-400/40 px-3 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-400/10">
              <Route size={14} /> Guided tour
            </button>
          )}
          <button
            onClick={copyShareLink}
            title="Copy shareable link to this exact view, target, wavelength, and mode"
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
          >
            <Share2 size={14} /> {linkCopied ? "Copied!" : "Share"}
          </button>
          <button
            onClick={() => {
              if (showHelp && helpTab !== "settings") setShowHelp(false);
              else {
                setHelpTab("science");
                setShowHelp(true);
              }
            }}
            aria-expanded={showHelp && helpTab !== "settings"}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
          >
            <BookOpen size={14} /> Guide
          </button>
          <button
            onClick={() => {
              if (showHelp && helpTab === "settings") setShowHelp(false);
              else {
                setHelpTab("settings");
                setShowHelp(true);
              }
            }}
            aria-expanded={showHelp && helpTab === "settings"}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
          >
            <Settings size={14} /> Settings
          </button>
        </div>
      </header>
      {showHelp && (
        <GuideAndSettings
          tab={helpTab}
          onTab={setHelpTab}
          onClose={() => setShowHelp(false)}
          sourceMode={sourceMode}
          onSourceMode={updateSourceMode}
          serverOnline={serverOnline}
          onCheckServer={checkServer}
          forceBrowser={FORCE_BROWSER}
          shortcutsOn={shortcutsOn}
          onShortcuts={(on) => {
            setShortcutsOn(on);
            storage.set("spherex-blink.shortcuts", on ? "on" : "off");
          }}
        />
      )}

      <LiveSearch
        onReady={onLiveReady}
        autostart={initialLive}
        sourceMode={sourceMode}
        serverOnline={serverOnline}
        onSwitchMode={updateSourceMode}
        onCheckServer={checkServer}
        onUpstream502={setIrsaUpstream502}
      />
      <DataSourceStatus serverOnline={serverOnline} onUpstream502={setIrsaUpstream502} />
      <div data-tour="targets">
        <TargetBar targets={[...index, ...liveEntries]} current={m.id} onPick={(id) => set({ target: id })} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* sky + timeline + spectrum */}
        <section className="flex min-h-[70vh] min-w-0 flex-1 flex-col lg:min-h-0">
          <div data-tour="sky" className={`relative mx-4 flex-1 overflow-hidden rounded-xl border border-white/10 bg-[#03050a] ${selected || mapPoint ? "min-h-[220px]" : "min-h-[44vh]"}`}>
            <SkyCanvas
              bundle={bundle}
              draw={draw}
              step={isColour ? null : step}
              diffMjds={diffYears && !isColour ? [diffYears[0], diffYears[1]] : undefined}
              showGaia={showGaia}
              handleRef={canvasRef}
              onHover={setHover}
              valueAt={valueAt}
              onPick={onPick}
              selected={selected}
              marks={isColour && mapPoint ? [{ x: mapPoint.mx, y: mapPoint.my, label: "map spectrum" }] : (motion?.pts ?? [])}
              colour={colourPlanes}
              overlayMjd={isColour ? cubeMid : undefined}
              flagPlane={flagsOnScreen}
              ariaLabel={`${shortName(m.name)}: ${
                isColour
                  ? "false-colour picture from SPHEREx's all-sky map"
                  : isDiff
                    ? `difference image, ${formatMjdMonth(m.epochs[state.t2].mjd)} minus ${formatMjdMonth(m.epochs[state.t1].mjd)}`
                    : step
                      ? `${step.label}, ${step.sublabel}, ${det.wl_min} to ${det.wl_max} micrometres`
                      : "no frame"
              }. ${m.blurb}`}
            />

            {/* what am I looking at */}
            {isColour && cube && (
              <div className="pointer-events-none absolute left-3 top-3 max-w-[min(26rem,calc(100%-6.5rem))] rounded-lg border border-white/10 bg-slate-950/75 px-3 py-2 backdrop-blur">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-emerald-400/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-200">Colour</span>
                  <span className="text-sm font-semibold text-white">{PRESETS.find((p) => p.id === presetId)?.name ?? "Your own mix"}</span>
                </div>
                <p className="mt-1 hidden text-xs leading-snug text-slate-300 sm:block">
                  {PRESETS.find((p) => p.id === presetId)?.what ??
                    `Red ${mix.r.lo}–${mix.r.hi} µm, green ${mix.g.lo}–${mix.g.hi} µm, blue ${mix.b.lo}–${mix.b.hi} µm.`}{" "}
                  Click anywhere for that spot's spectrum.
                </p>
                <p className="mt-1 text-[10px] text-slate-400">
                  SPHEREx all-sky map (DR1), average of every visit {cube.desc.mjd_min ? formatMjdRange(cube.desc.mjd_min, cube.desc.mjd_max ?? cube.desc.mjd_min) : ""} ·{" "}
                  {cube.desc.native_scale_arcsec}″ pixels · NASA/JPL-Caltech/IPAC
                </p>
              </div>
            )}
            <div className={`pointer-events-none absolute left-3 top-3 max-w-[min(26rem,calc(100%-6.5rem))] rounded-lg border border-white/10 bg-slate-950/75 px-3 py-2 backdrop-blur ${isColour ? "hidden" : ""}`}>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                    isDiff ? "bg-fuchsia-400/20 text-fuchsia-200" : step?.kind === "wise" ? "bg-amber-400/20 text-amber-200" : "bg-sky-400/20 text-sky-200"
                  }`}
                >
                  {isDiff ? "Difference" : step?.kind === "wise" ? "WISE" : "SPHEREx"}
                </span>
                <span className="text-sm font-semibold text-white">
                  {isDiff
                    ? `${formatMjdMonth(m.epochs[state.t2].mjd)} minus ${formatMjdMonth(m.epochs[state.t1].mjd)}`
                    : step
                      ? step.kind === "wise"
                        ? step.label.replace("WISE ", "")
                        : `Visit ${step.epoch + 1} · ${formatMjdRange(m.epochs[step.epoch].mjd_min, m.epochs[step.epoch].mjd_max)}`
                      : "No frames at this wavelength"}
                </span>
              </div>
              <p className="mt-1 hidden text-xs leading-snug text-slate-300 sm:block">
                {isDiff
                  ? "Amber got brighter, cyan got fainter, black stayed the same. A star that moved leaves an amber/cyan pair."
                  : step?.kind === "wise"
                    ? "An older telescope's view, for comparison. Compare where the stars are, not how bright."
                    : step
                      ? `${step.sublabel.split(" · ").pop()} stacked at ${det.wl_min}–${det.wl_max} µm. The yellow cross marks where the target should be on this date.`
                      : "Pick another wavelength."}
              </p>
              <p className="mt-1 text-[10px] text-slate-400">{sourceLabel}</p>
            </div>

            {pickHint && (
              <button onClick={() => setPickHint(null)} className="absolute left-1/2 top-24 max-w-md -translate-x-1/2 rounded-lg border border-white/10 bg-slate-950/90 px-3 py-2 text-xs text-slate-300">
                {pickHint}
              </button>
            )}
            {loadingId && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-950/60 text-sm text-slate-300 backdrop-blur-sm">Loading…</div>
            )}

            <div className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-lg border border-white/10 bg-slate-950/80 p-0.5 backdrop-blur">
              {(
                [
                  ["colour", "Colour"],
                  ["blink", "Blink"],
                  ["diff", "Diff"],
                ] as const
              ).map(([v, l]) => {
                const disabled = (v === "colour" && !cube) || (v !== "colour" && !bundle.meta.epochs.length);
                return (
                  <button
                    key={v}
                    type="button"
                    disabled={disabled}
                    onClick={() => set({ mode: v })}
                    aria-pressed={state.mode === v}
                    title={
                      disabled
                        ? v === "colour"
                          ? "No colour map in this bundle"
                          : "No time series for this field yet"
                        : `Switch to ${v === "diff" ? "Difference" : l} view`
                    }
                    className={`rounded-md px-2 py-1 text-[11px] font-medium transition disabled:opacity-30 ${
                      state.mode === v ? "bg-sky-400/25 text-white" : "text-slate-300 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    {l}
                  </button>
                );
              })}
            </div>
            <div className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2">
              {hover ? (
                <span className="mono whitespace-nowrap rounded bg-slate-950/80 px-2 py-1 text-[11px] text-slate-300">
                  {formatHover(hover)}
                  {flagsOnScreen && flagsOnScreen[hover.y * bundle.width + hover.x] !== 255
                    ? ` · flagged in ${flagsOnScreen[hover.y * bundle.width + hover.x]}% of exposures`
                    : ""}
                  {isColour
                    ? ""
                    : ` · ${hover.value === null ? "no value (saturated or not covered)" : `${hover.value.toFixed(3)} ${step?.kind === "wise" && !isDiff ? "DN" : "MJy/sr"}`}`}
                </span>
              ) : (
                <span className="hidden whitespace-nowrap rounded bg-slate-950/60 px-2 py-1 text-[11px] text-slate-400 sm:inline">Click a star for its spectrum · scroll to zoom · drag to pan</span>
              )}
            </div>
            <div className="absolute right-3 top-3 flex gap-1">
              <OverlayBtn active={smooth} onClick={() => setSmooth((s) => !s)} title="Smooth display vs. the raw 6.15″ pixels (P)">
                {smooth ? "Smooth" : "Pixels"}
              </OverlayBtn>
              <OverlayBtn active={false} onClick={exportFits} title="Save this image as FITS (raw values, sky coordinates, provenance)">
                <Download size={13} />
                <span className="ml-1">FITS</span>
              </OverlayBtn>
              <OverlayBtn
                active={exportOpen && exportOpts.format === "png"}
                onClick={() => {
                  setExportOpts((o) => ({
                    ...o,
                    format: "png",
                    layout: o.layout === "presets-grid" && !cube ? "current" : o.layout,
                  }));
                  setExportOpen(true);
                }}
                title="Open export menu to save PNG (current view, 2×2 colour presets, spectrum chart)"
              >
                <Camera size={13} />
                <span className="ml-1">PNG</span>
              </OverlayBtn>
              <OverlayBtn
                active={gifBusy || (exportOpen && exportOpts.format === "gif")}
                onClick={() => {
                  setExportOpts((o) => ({
                    ...o,
                    format: steps.length > 0 ? "gif" : "png",
                    layout: "current",
                  }));
                  setExportOpen(true);
                }}
                title={
                  steps.length > 0
                    ? "Open export menu for animated Blink GIF"
                    : "Load a time series to export an animated GIF"
                }
              >
                <Film size={13} />
                <span className={`ml-1 ${state.mode === "blink" ? "" : "opacity-75"}`}>{gifBusy ? "GIF…" : "GIF"}</span>
              </OverlayBtn>
              <OverlayBtn active={false} onClick={sampFits} title="Send this FITS image to Aladin, TOPCAT, or DS9 via Web SAMP (requires local server)">
                <Send size={12} />
                <span className="ml-1">SAMP</span>
              </OverlayBtn>
              <OverlayBtn active={false} onClick={() => canvasRef.current?.resetView()} title="Reset zoom (R)">
                <RotateCcw size={13} />
              </OverlayBtn>
            </div>
            {sampNote && (
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-lg border border-sky-400/30 bg-slate-950/90 px-3 py-1.5 text-xs text-sky-100 shadow-lg">
                {sampNote}
              </div>
            )}
          </div>

          {/* bottom bar: timeline or compare */}
          <div data-tour="timeline" className="mx-4 mt-2 rounded-xl border border-white/10 bg-white/[0.03]">
            {state.mode === "blink" ? (
              <Timeline
                steps={steps}
                current={steps.length ? stepIdx % steps.length : 0}
                playing={playing}
                fps={fps}
                onStep={(i) => {
                  setPlaying(false);
                  setStepIdx(i);
                }}
                onPlay={() => setPlaying((p) => !p)}
                onFps={setFps}
              />
            ) : isColour && cube ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-xs text-slate-400">
                <span className="text-sm text-slate-200">One picture from all visits</span>
                <span>
                  Each colour is the average brightness in its wavelength window, over every visit
                  {cube.desc.mjd_min ? ` from ${formatMjdRange(cube.desc.mjd_min, cube.desc.mjd_max ?? cube.desc.mjd_min)}` : ""}. Use Blink to see changes over time.
                </span>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="text-slate-400">Compare</span>
                <VisitSelect value={state.t2} epochs={m.epochs} ok={bandEpochs} onChange={(v) => set({ t2: v })} />
                <span className="text-slate-400">minus</span>
                <VisitSelect value={state.t1} epochs={m.epochs} ok={bandEpochs} onChange={(v) => set({ t1: v })} />
                {diffOk && (
                  <span className="mono text-xs text-slate-400">
                    ({Math.round(Math.abs(m.epochs[state.t2].mjd - m.epochs[state.t1].mjd))} days apart)
                  </span>
                )}
                {!diffOk && <span className="text-xs text-amber-300">Pick two different visits that both have this wavelength.</span>}
                {hasMatched ? (
                  <span className="text-xs text-slate-400" title="Each visit is compared wavelength by wavelength, so a star's colour can't make it look brighter or fainter.">
                    matched by wavelength
                  </span>
                ) : (
                  <span
                    className="text-xs text-amber-300"
                    title="The two visits saw each star at slightly different wavelengths, so every star leaves light and dark leftovers (about 10–15% of its brightness) even if nothing changed. Built-in targets and the local server match the wavelengths first."
                  >
                    not matched by wavelength: every star leaves leftovers
                  </span>
                )}
                <span className="ml-auto flex items-center gap-2 text-xs text-slate-300">
                  <span className="text-cyan-300">Cyan: faded / old spot</span>
                  <span className="h-2.5 w-20 rounded border border-white/10" style={{ background: "linear-gradient(90deg,#a5f3fc,#22d3ee,#085978,#060a10,#7c4206,#f59e0b,#fee68a)" }} />
                  <span className="text-amber-300">Amber: brighter / new spot</span>
                </span>
              </div>
            )}
          </div>

          {((selected && bundle.spectra) || (isColour && mapPoint)) && (
            <div data-tour="spectrum" className="mx-4 mb-3 mt-2 h-[46%] min-h-[340px] shrink-0 overflow-hidden rounded-xl border border-white/10">
              <SpectrumPanel
                spectra={bundle.spectra}
                source={selected}
                title={mapPoint ? `Map point ${formatRa(mapPoint.ra)} ${formatDec(mapPoint.dec)}` : undefined}
                map={mapOverlay}
                colourWindows={isColour ? mix : null}
                colourNote={colourWhy}
                silent={SILENT}
                epochs={m.epochs}
                detectors={m.detectors}
                exposures={m.exposures}
                band={state.band}
                tab={tab}
                onTab={setTab}
                onClose={() => {
                  setSelectedId(null);
                  setMapPoint(null);
                }}
              >
                {selected && (
                <MotionBar
                  expectedPx={motion?.expectedPx ?? 0}
                  measuring={measure}
                  onMeasure={() => setMeasure((x) => !x)}
                  fit={motion?.fit ?? null}
                  n={motion?.pts.length ?? 0}
                  gaia={{ east: selected.pmra / 1000, north: selected.pmdec / 1000 }}
                  frames={steps.length}
                  hasWise={steps.some((s) => s.kind === "wise")}
                />
                )}
              </SpectrumPanel>
            </div>
          )}
          {!selected && <div className="h-3 shrink-0" />}
        </section>

        {/* controls */}
        <aside className="flex w-full shrink-0 flex-col gap-5 overflow-y-auto border-t border-white/10 px-4 py-4 text-sm lg:w-[340px] lg:border-l lg:border-t-0 lg:px-5">
          <section>
            <h2 className="text-lg font-semibold text-white">{shortName(m.name)}</h2>
            {m.tagline && <p className="text-sm text-sky-300">{m.tagline}</p>}
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
              <span className="mono" title="Field centre (ICRS J2000)">
                {formatRa(m.wcs.crval[0])} {formatDec(m.wcs.crval[1])}
              </span>
              <span className="mono text-slate-500">
                ({m.wcs.crval[0].toFixed(4)}, {m.wcs.crval[1].toFixed(4)})
              </span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(`${m.wcs.crval[0].toFixed(5)} ${m.wcs.crval[1].toFixed(5)}`);
                  setCoordsCopied(true);
                  window.setTimeout(() => setCoordsCopied(false), 2000);
                }}
                title="Copy decimal RA Dec coordinates"
                className="inline-flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-white/5"
              >
                {coordsCopied ? <CheckIcon size={10} className="text-emerald-300" /> : <Copy size={10} />}
                {coordsCopied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-slate-300">{m.blurb}</p>
            {m.notes.map((n) => (
              <p key={n} className="mt-2 flex gap-2 rounded-md bg-amber-400/10 px-2.5 py-1.5 text-xs leading-snug text-amber-200">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" /> {n}
              </p>
            ))}
            {bundle.spectra && !selected && (
              <button onClick={() => setSelectedId("target")} className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-sky-400/15 px-3 py-1.5 text-xs font-medium text-sky-100 hover:bg-sky-400/25">
                <Activity size={14} /> Show its spectrum
              </button>
            )}
          </section>

          <Section title="View" anchor="view">
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-white/[0.04] p-1">
              {(
                [
                  ["blink", "Blink", "flip visits"],
                  ["diff", "Difference", "what changed"],
                  ["colour", "Colour", "102 colours"],
                ] as const
              ).map(([v, l, d]) => (
                <button
                  key={v}
                  onClick={() => set({ mode: v })}
                  aria-pressed={state.mode === v}
                  disabled={(v === "colour" && !cube) || (v !== "colour" && !bundle.meta.epochs.length)}
                  title={
                    v === "colour" && !cube
                      ? "No colour map in this bundle"
                      : v !== "colour" && !bundle.meta.epochs.length
                        ? "No time series for this field yet: add the exposure list to get visits to blink"
                        : undefined
                  }
                  className={`rounded-md px-2 py-2 text-left transition disabled:opacity-30 ${state.mode === v ? "bg-sky-400/20 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}
                >
                  <span className="block text-sm font-medium">{l}</span>
                  <span className="block text-[11px] opacity-80">{d}</span>
                </button>
              ))}
            </div>
          </Section>

          {isColour ? (
            <Section title="Colours" hint="Each colour of the picture is the average brightness in one wavelength window, all on one brightness scale. Drag the windows, or focus one and use ← →.">
              <ColourIntro mix={mix} />
              {m.colour_hint && (
                <p className="mt-3 rounded-md bg-emerald-400/10 px-2.5 py-2 text-xs leading-snug text-emerald-100">
                  <b className="text-emerald-50">What to look for: </b>
                  {m.colour_hint}
                </p>
              )}
              {(colourView?.blownOut ?? 0) > 0 && (
                <p className="mt-2 text-[11px] text-slate-400">White patches are star centres too bright for SPHEREx to measure, not white stars.</p>
              )}
              <div className="mb-3 mt-3 grid grid-cols-2 gap-1">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setPresetId(p.id);
                      setMix(p.mix);
                    }}
                    aria-pressed={presetId === p.id}
                    title={p.what}
                    className={`rounded-md border px-2 py-1.5 text-left text-xs ${presetId === p.id ? "border-emerald-400/60 bg-emerald-400/10 text-white" : "border-white/10 text-slate-300 hover:bg-white/5"}`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              {bundle.finecube && bundle.cube && fineComplete && (
                <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-white/[0.04] p-1 text-xs">
                  {(
                    [
                      ["fine", "Sharper map", "our map from the single exposures, 6.15″ pixels"],
                      ["archive", "NASA map", "SPHEREx's published all-sky map, 12.9″ pixels"],
                    ] as const
                  ).map(([v, l, d]) => (
                    <button
                      key={v}
                      onClick={() => setColourSource(v)}
                      aria-pressed={colourSource === v}
                      title={d}
                      className={`rounded-md py-1.5 ${colourSource === v ? "bg-white/10 text-white" : "text-slate-400"}`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              )}
              <ColourMixer
                mix={mix}
                detectors={m.detectors}
                onChange={(next) => {
                  setMix(next);
                  setPresetId(null);
                }}
              />
            </Section>
          ) : (
            <Section title="Wavelength" hint="SPHEREx splits the infrared into six detectors. Longer wavelengths see cooler things.">
              <WavelengthPicker detectors={m.detectors} band={state.band} available={(d) => epochsWithBand(bundle, d).length > 0} onBand={(d) => set({ band: d })} />
            </Section>
          )}

          <Section title="Show">
            <Toggle
              label="2010 WISE image"
              hint={m.wise.length ? "Adds a frame from 15 years earlier, so slow movers jump" : "Not available for this target"}
              checked={state.wise && m.wise.length > 0}
              disabled={!m.wise.length}
              onChange={(v) => set({ wise: v })}
            />
            {bundle.neowise && (
              <Toggle
                label="NEOWISE yearly images (2014–2024)"
                hint={`${m.neowise?.frames.length ?? 0} more WISE frames, about two a year: a nearby star's motion becomes a smooth 16-year video`}
                checked={showNeowise && state.wise}
                disabled={!state.wise}
                onChange={setShowNeowise}
              />
            )}
            <Toggle label="Gaia star markers" hint={`Where ESA's Gaia catalogue puts stars (G < ${GAIA_G_LIMIT}) on each date`} checked={showGaia} onChange={setShowGaia} />
            {bundle.flags && (
              <Toggle
                label="Contamination flags"
                hint="Tints pixels that were flagged (cosmic rays, ghosts, halos…) in this visit's exposures; flagged pixels are left out of every stack"
                checked={showFlags}
                disabled={state.mode === "colour"}
                onChange={setShowFlags}
              />
            )}
            {showFlags && flagSummary && state.mode !== "colour" && (
              <div className="ml-12 mt-1 text-[11px] text-slate-400">
                {Object.keys(flagSummary).length ? (
                  <>
                    Flags in this visit, D{state.band} (share of pixels):{" "}
                    {Object.entries(flagSummary)
                      .slice(0, 6)
                      .map(([k, v]) => `${k} ${v}%`)
                      .join(" · ")}
                  </>
                ) : (
                  "No flags set in this visit and detector."
                )}
              </div>
            )}
            <Toggle label="Smooth pixels" hint="SPHEREx pixels are 6.15″ wide. Smoothing is for display only" checked={smooth} onChange={setSmooth} />
          </Section>

          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-300">
              <ChevronRight size={14} className="transition group-open:rotate-90" /> Image settings
            </summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-white/[0.04] p-1 text-xs">
                {(["asinh", "log", "linear"] as const).map((s) => (
                  <button key={s} onClick={() => set({ stretch: s })} className={`rounded-md py-1.5 ${state.stretch === s ? "bg-white/10 text-white" : "text-slate-400"}`}>
                    {s === "asinh" ? "Asinh (faint)" : s === "log" ? "Log" : "Linear"}
                  </button>
                ))}
              </div>
              {isDiff ? (
                <Slider label="Contrast" value={diffPct} min={95} max={99.99} step={0.01} onChange={setDiffPct} fmt={(v) => `${v.toFixed(2)}%`} />
              ) : (
                <>
                  <Slider label="Black" value={lo} min={0} max={60} step={0.5} onChange={(v) => setLo(Math.min(v, hi - 1))} fmt={(v) => `${v}%`} />
                  <Slider label="White" value={hi} min={60} max={100} step={0.1} onChange={(v) => setHi(Math.max(v, lo + 1))} fmt={(v) => `${v.toFixed(1)}%`} />
                  <div className="grid grid-cols-3 gap-1">
                    {COLORMAPS.map((c) => (
                      <button
                        key={c}
                        onClick={() => setCmap(c)}
                        className={`rounded-md border px-1 py-1 text-[11px] ${cmap === c ? "border-sky-400 text-white" : "border-white/10 text-slate-400 hover:text-slate-200"}`}
                      >
                        <span className="mb-1 block h-1.5 rounded-sm" style={{ background: lutCss(c) }} />
                        {COLORMAP_LABELS[c]}
                      </button>
                    ))}
                  </div>
                  <Check label="Pixel grid (raw pixels, zoomed in)" checked={pixelGrid} onChange={setPixelGrid} disabled={smooth} />
                </>
              )}
            </div>
          </details>

          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-300">
              <ChevronRight size={14} className="transition group-open:rotate-90" /> Target data
            </summary>
            <dl className="mono mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-slate-400">RA</dt>
              <dd>
                {formatRa(t.pos_now[0])} <span className="text-slate-400">({t.pos_now[0].toFixed(5)}°)</span>
              </dd>
              <dt className="text-slate-400">Dec</dt>
              <dd>
                {formatDec(t.pos_now[1])} <span className="text-slate-400">({t.pos_now[1].toFixed(5)}°)</span>
              </dd>
              <dt className="text-slate-400">epoch</dt>
              <dd>2026.5</dd>
              <dt className="text-slate-400">motion</dt>
              <dd>
                {targetPm.toFixed(2)}″/yr = {(targetPm / m.pixel_scale_arcsec).toFixed(2)} px/yr
              </dd>
              <dt className="text-slate-400">2010→26</dt>
              <dd>{separationArcsec(...t.pos_2010, ...t.pos_now).toFixed(0)}″ moved</dd>
            </dl>
            <p className="mt-2 text-[11px] text-slate-400">{t.source}. Parallax ignored.</p>
          </details>

          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-300">
              <ChevronRight size={14} className="transition group-open:rotate-90" /> How accurate is this?
            </summary>
            <Accuracy target={m.id} />
          </details>

          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-300">
              <ChevronRight size={14} className="transition group-open:rotate-90" /> How these images were made
            </summary>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              {m.provenance.exposures_found} SPHEREx exposures cover this field; {m.exposures.filter((e) => e.used).length} were used. Each was downloaded as a cutout, the
              zodiacal-light model was subtracted, bad pixels (flag bits {m.provenance.mask_bits.join(", ")}) and saturated pixels were dropped, and the exposure was resampled
              to a north-up {m.pixel_scale_arcsec}″/px grid. Exposures from the same visit and detector were averaged, weighted by their noise. Baked {m.provenance.baked_utc} by{" "}
              {m.provenance.pipeline}.
            </p>
          </details>

          <footer className="mt-auto space-y-1 border-t border-white/10 pt-3 text-[11px] leading-snug text-slate-400">
            <p>{m.provenance.credit}</p>
            <p>
              SPHEREx DR1 doi:{m.provenance.dois.spherex_dr1} · QR3 doi:{m.provenance.dois.spherex_qr3}. {m.provenance.wise}. {m.provenance.gaia}.
            </p>
          </footer>
        </aside>
      </div>
      <ExportDialog
        open={exportOpen}
        options={exportOpts}
        onChange={setExportOpts}
        onExport={() => void runExport()}
        onClose={() => setExportOpen(false)}
        busy={gifBusy}
        hasCube={!!cube}
        hasBlink={steps.length > 0}
        hasSpectrum={!!exportSpectrum}
        spectrumLabel={exportSpectrum?.title}
        fps={fps}
      />
    </div>
  );
}

function Section({ title, hint, anchor, children }: { title: string; hint?: string; anchor?: string; children: React.ReactNode }) {
  return (
    <section data-tour={anchor}>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{title}</h3>
      {children}
      {hint && <p className="mt-1.5 text-[11px] leading-snug text-slate-400">{hint}</p>}
    </section>
  );
}

function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-md px-1 py-1.5 hover:bg-white/[0.03] ${disabled ? "cursor-not-allowed opacity-40" : ""}`}>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-5 w-9 rounded-full bg-white/15 transition peer-checked:bg-sky-400 peer-focus-visible:outline peer-focus-visible:outline-1 peer-focus-visible:outline-sky-300" />
        <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-4" />
      </span>
      <span>
        <span className="block text-sm text-slate-200">{label}</span>
        {hint && <span className="block text-[11px] leading-snug text-slate-400">{hint}</span>}
      </span>
    </label>
  );
}

function OverlayBtn({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`flex h-8 items-center rounded-md border px-2.5 text-xs backdrop-blur ${active ? "border-sky-400/50 bg-slate-950/80 text-sky-100" : "border-white/10 bg-slate-950/70 text-slate-300 hover:text-white"}`}
    >
      {children}
    </button>
  );
}

function VisitSelect({ value, epochs, ok, onChange }: { value: number; epochs: Bundle["meta"]["epochs"]; ok: number[]; onChange: (v: number) => void }) {
  return (
    <select className="rounded-md border border-white/15 bg-slate-900 px-2 py-1.5 text-sm text-white" value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {epochs.map((ep, i) => (
        <option key={i} value={i} disabled={!ok.includes(i)}>
          Visit {i + 1} · {formatMjdRange(ep.mjd_min, ep.mjd_max)}
        </option>
      ))}
    </select>
  );
}

function lutCss(name: ColormapName): string {
  const lut = buildLut(name);
  const stops = [0, 64, 128, 192, 255].map((i) => `rgb(${lut[i * 4]},${lut[i * 4 + 1]},${lut[i * 4 + 2]})`);
  return `linear-gradient(90deg, ${stops.join(",")})`;
}

function MotionBar(p: {
  expectedPx: number;
  measuring: boolean;
  onMeasure: () => void;
  fit: ReturnType<typeof fitMotion>;
  n: number;
  gaia: { east: number; north: number };
  frames: number;
  hasWise: boolean;
}) {
  const gTot = Math.hypot(p.gaia.east, p.gaia.north);
  if (p.expectedPx < 1) {
    return (
      <p className="mb-1 text-[11px] text-slate-400">
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
      {p.measuring && p.fit && !p.hasWise && (
        <span className="text-amber-300">Without the 2010 WISE frame this uses SPHEREx visits alone, which our fake-star tests show is unreliable (about half of movers recovered). Turn the 2010 image on for a trustworthy speed.</span>
      )}
      {p.measuring && (
        <span className="text-slate-400">Centroids (pink ×) of this detector's frames{p.frames > 1 ? "" : ""}; the search starts at the Gaia position for each date.</span>
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

