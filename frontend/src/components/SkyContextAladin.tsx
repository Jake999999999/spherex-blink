import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Globe2 } from "lucide-react";
import type { GaiaStar, GridWcs } from "../lib/bundle";
import { pixelToWorld } from "../lib/wcs";

interface AladinGlobal {
  init: Promise<void>;
  aladin: (el: HTMLElement, opts: Record<string, unknown>) => AladinInstance;
  graphicOverlay: (opts: Record<string, unknown>) => AladinOverlay;
  polyline: (coords: [number, number][], opts?: Record<string, unknown>) => unknown;
  catalog: (opts: Record<string, unknown>) => AladinCatalog;
  source: (ra: number, dec: number, data?: Record<string, string | number>) => unknown;
}

interface AladinInstance {
  setImageSurvey: (survey: string) => void;
  gotoRaDec: (ra: number, dec: number) => void;
  setFov: (fovDeg: number) => void;
  addOverlay: (overlay: AladinOverlay) => void;
  addCatalog: (catalog: AladinCatalog) => void;
  removeLayers?: () => void;
}

interface AladinOverlay {
  add: (shape: unknown) => void;
  removeAll: () => void;
}

interface AladinCatalog {
  addSources: (sources: unknown[]) => void;
  removeAll: () => void;
  show: () => void;
  hide: () => void;
}

declare global {
  interface Window {
    A?: AladinGlobal;
  }
}

const ALADIN_SCRIPT_URLS = [
  "https://cdn.jsdelivr.net/npm/aladin-lite@3/dist/aladin.umd.cjs",
  "https://unpkg.com/aladin-lite@3/dist/aladin.umd.cjs",
  "https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js",
];
const SURVEYS = [
  { id: "P/allWISE/color", label: "AllWISE" },
  { id: "P/2MASS/color", label: "2MASS" },
  { id: "P/DSS2/color", label: "DSS2" },
] as const;

let aladinLoader: Promise<AladinGlobal> | null = null;

function injectScript(src: string): Promise<AladinGlobal> {
  return new Promise<AladinGlobal>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      if (!window.A) {
        reject(new Error("Aladin Lite did not initialize"));
        return;
      }
      window.A.init.then(() => resolve(window.A!)).catch(reject);
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

function loadAladinLite(): Promise<AladinGlobal> {
  if (typeof window === "undefined") return Promise.reject(new Error("No window"));
  if (window.A) return window.A.init.then(() => window.A!);
  if (aladinLoader) return aladinLoader;

  aladinLoader = (async () => {
    for (const url of ALADIN_SCRIPT_URLS) {
      try {
        return await injectScript(url);
      } catch {
        // try next CDN mirror
      }
    }
    aladinLoader = null;
    throw new Error("Could not load Aladin Lite from CDN or CDS Strasbourg");
  })();
  return aladinLoader;
}

interface VizierGaiaRow {
  ra: number;
  dec: number;
  g: number | null;
  pmra: number | null;
  pmdec: number | null;
}

async function fetchGaiaContextStars(ra: number, dec: number, radiusDeg: number, signal: AbortSignal): Promise<VizierGaiaRow[]> {
  const r = Math.min(Math.max(radiusDeg, 0.08), 0.35);
  const adql = `SELECT TOP 400 RA_ICRS, DE_ICRS, Gmag, pmRA, pmDE FROM "I/355/gaiadr3" WHERE 1=CONTAINS(POINT('ICRS', RA_ICRS, DE_ICRS), CIRCLE('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}, ${r.toFixed(4)})) ORDER BY Gmag ASC`;
  const url = `https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=json&QUERY=${encodeURIComponent(adql)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`VizieR TAP HTTP ${res.status}`);
  const payload = (await res.json()) as { data?: unknown[][] };
  const rows = payload.data ?? [];
  return rows
    .filter((row) => typeof row[0] === "number" && typeof row[1] === "number")
    .map((row) => ({
      ra: row[0] as number,
      dec: row[1] as number,
      g: typeof row[2] === "number" ? (row[2] as number) : null,
      pmra: typeof row[3] === "number" ? (row[3] as number) : null,
      pmdec: typeof row[4] === "number" ? (row[4] as number) : null,
    }));
}

interface Props {
  wcs: GridWcs;
  shape: [number, number];
  gaiaStars: GaiaStar[];
  streak?: [[number, number], [number, number]] | null;
}

export function SkyContextAladin({ wcs, shape, gaiaStars, streak }: Props) {
  const [open, setOpen] = useState(false);
  const [survey, setSurvey] = useState<(typeof SURVEYS)[number]["id"]>("P/allWISE/color");
  const [showGaiaCatalog, setShowGaiaCatalog] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gaiaNote, setGaiaNote] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  const hostRef = useRef<HTMLDivElement>(null);
  const aladinRef = useRef<AladinInstance | null>(null);
  const overlayRef = useRef<AladinOverlay | null>(null);
  const catalogRef = useRef<AladinCatalog | null>(null);

  const [height, width] = shape;
  const [ra, dec] = wcs.crval;
  const fieldWidthDeg = Math.abs(wcs.cdelt[0]) * width;
  const fieldHeightDeg = Math.abs(wcs.cdelt[1]) * height;
  const contextFovDeg = Math.max(Math.max(fieldWidthDeg, fieldHeightDeg) * 2.6, 0.32);

  const footprintCorners = useMemo<[number, number][]>(() => {
    const c0 = pixelToWorld(wcs, 0, 0);
    const c1 = pixelToWorld(wcs, width - 1, 0);
    const c2 = pixelToWorld(wcs, width - 1, height - 1);
    const c3 = pixelToWorld(wcs, 0, height - 1);
    return [c0, c1, c2, c3, c0];
  }, [wcs, width, height]);

  // Mount Aladin Lite each time the panel is opened
  useEffect(() => {
    if (!open || !hostRef.current) {
      aladinRef.current = null;
      overlayRef.current = null;
      catalogRef.current = null;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    loadAladinLite()
      .then((A) => {
        if (cancelled || !hostRef.current) return;
        const instance = A.aladin(hostRef.current, {
          survey,
          fov: contextFovDeg,
          target: `${ra} ${dec}`,
          showReticle: true,
          showZoomControl: true,
          showFullscreenControl: false,
          showLayersControl: false,
          showGotoControl: false,
          showFrame: false,
          cooFrame: "ICRSd",
        });
        const overlay = A.graphicOverlay({ color: "#f59e0b", lineWidth: 2 });
        const catalog = A.catalog({
          name: "Gaia DR3",
          sourceSize: 9,
          color: "#22d3ee",
          shape: "circle",
          onClick: "showPopup",
        });
        instance.addOverlay(overlay);
        instance.addCatalog(catalog);
        aladinRef.current = instance;
        overlayRef.current = overlay;
        catalogRef.current = catalog;
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = typeof err === "string" ? err : err instanceof Error ? err.message : "Failed to load Aladin Lite";
        setError(msg);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // Intentionally initialize when opened/retried; updates are handled in separate effects
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, retryKey]);

  // Update survey when toggled
  useEffect(() => {
    if (!open || !aladinRef.current) return;
    aladinRef.current.setImageSurvey(survey);
  }, [open, survey]);

  // Update target centre, FOV, orange footprint box, and optional measured streak
  useEffect(() => {
    if (!open || !aladinRef.current || !overlayRef.current || !window.A || loading) return;
    const A = window.A;
    aladinRef.current.gotoRaDec(ra, dec);
    aladinRef.current.setFov(contextFovDeg);
    overlayRef.current.removeAll();
    overlayRef.current.add(A.polyline(footprintCorners, { color: "#f59e0b", lineWidth: 2 }));
    if (streak) {
      overlayRef.current.add(A.polyline(streak, { color: "#ef4444", lineWidth: 2.5 }));
    }
  }, [open, loading, ra, dec, contextFovDeg, footprintCorners, streak]);

  // Show/hide and populate Gaia DR3 stars (VizieR TAP 400 brightest in wider field, fallback to bundle)
  useEffect(() => {
    if (!open || !catalogRef.current || !window.A || loading) return;
    const cat = catalogRef.current;
    if (!showGaiaCatalog) {
      cat.hide();
      return;
    }
    cat.show();
    const A = window.A;
    const ac = new AbortController();
    setGaiaNote("Loading Gaia DR3 stars…");

    fetchGaiaContextStars(ra, dec, contextFovDeg * 0.55, ac.signal)
      .then((rows) => {
        if (ac.signal.aborted) return;
        cat.removeAll();
        cat.addSources(
          rows.map((s) =>
            A.source(s.ra, s.dec, {
              "G mag": s.g !== null ? s.g.toFixed(2) : "—",
              "pm RA (mas/yr)": s.pmra !== null ? s.pmra.toFixed(1) : "—",
              "pm Dec (mas/yr)": s.pmdec !== null ? s.pmdec.toFixed(1) : "—",
            }),
          ),
        );
        setGaiaNote(`${rows.length} Gaia DR3 stars drawn (CDS VizieR). Click any circle for details.`);
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        cat.removeAll();
        if (gaiaStars.length > 0) {
          cat.addSources(
            gaiaStars.map((s) =>
              A.source(s.ra, s.dec, {
                "G mag": s.g !== null ? s.g.toFixed(2) : "—",
                "pm RA (mas/yr)": s.pmra.toFixed(1),
                "pm Dec (mas/yr)": s.pmdec.toFixed(1),
              }),
            ),
          );
          setGaiaNote(`${gaiaStars.length} Gaia DR3 stars drawn (field catalogue).`);
        } else {
          setGaiaNote("Gaia DR3 overlay unavailable offline.");
        }
      });

    return () => ac.abort();
  }, [open, loading, showGaiaCatalog, ra, dec, contextFovDeg, gaiaStars]);

  return (
    <div className="border-t border-white/10 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left text-xs font-medium text-slate-200 hover:text-white"
      >
        <span className="inline-flex items-center gap-1.5">
          <Globe2 size={13} className="text-sky-400" />
          Sky context (Aladin)
        </span>
        {open ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
      </button>

      {open && (
        <div className="mt-2.5 space-y-2">
          <div className="relative h-56 w-full overflow-hidden rounded-lg border border-white/10 bg-slate-950">
            <div ref={hostRef} className="h-full w-full" />
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 text-xs text-slate-400">
                Loading Aladin Lite…
              </div>
            )}
            {error && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-950/90 p-3 text-center text-xs text-amber-300">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={() => {
                    aladinLoader = null;
                    setRetryKey((k) => k + 1);
                  }}
                  className="rounded border border-amber-400/40 px-2.5 py-1 text-[11px] text-amber-200 hover:bg-amber-400/10"
                >
                  Retry
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <div className="inline-flex overflow-hidden rounded-md border border-white/10 bg-white/[0.03]">
              {SURVEYS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSurvey(s.id)}
                  className={`px-2 py-0.5 font-medium transition ${
                    survey === s.id ? "bg-amber-400 text-slate-950" : "text-slate-300 hover:bg-white/5"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <label className="inline-flex cursor-pointer items-center gap-1.5 text-slate-300">
              <input
                type="checkbox"
                checked={showGaiaCatalog}
                onChange={(e) => setShowGaiaCatalog(e.target.checked)}
                className="accent-sky-400"
              />
              <span>Gaia DR3 stars</span>
            </label>
          </div>

          <p className="text-[11px] leading-snug text-slate-400">
            Wider sky around this target. Orange box = cutout field{streak ? "; red line = measured motion" : ""}.
            {gaiaNote ? ` ${gaiaNote}` : ""}
          </p>
        </div>
      )}
    </div>
  );
}
