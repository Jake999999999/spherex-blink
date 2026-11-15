import { BookOpen, RefreshCw, Settings, Sliders, X } from "lucide-react";
import type { SourceMode } from "./LiveSearch";

export type HelpTab = "science" | "howto" | "settings";

interface Props {
  tab: HelpTab;
  onTab: (t: HelpTab) => void;
  onClose: () => void;
  sourceMode: SourceMode;
  onSourceMode: (m: SourceMode) => void;
  serverOnline: boolean | null;
  onCheckServer: () => void;
  forceBrowser: boolean;
  shortcutsOn: boolean;
  onShortcuts: (on: boolean) => void;
}

const SHORTCUTS: [string, string][] = [
  ["Space", "play / pause blink"],
  ["← →", "previous / next frame"],
  ["D", "blink ↔ difference"],
  ["C", "colour view"],
  ["N / Shift+N", "next / previous measured star"],
  ["G", "Gaia star markers"],
  ["P", "smooth ↔ raw pixels"],
  ["R", "reset zoom"],
  ["Esc", "close panel"],
];

export function GuideAndSettings({
  tab,
  onTab,
  onClose,
  sourceMode,
  onSourceMode,
  serverOnline,
  onCheckServer,
  forceBrowser,
  shortcutsOn,
  onShortcuts,
}: Props) {
  return (
    <div className="mx-4 mb-2 rounded-lg border border-sky-400/25 bg-slate-950/90 p-3 text-xs text-slate-200 shadow-xl">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2">
        <div className="flex gap-1" role="tablist" aria-label="Guide and settings">
          <button
            role="tab"
            aria-selected={tab === "science"}
            onClick={() => onTab("science")}
            className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 font-medium ${tab === "science" ? "bg-sky-400/20 text-sky-100" : "text-slate-400 hover:text-slate-200"}`}
          >
            <BookOpen size={13} /> What is SPHEREx?
          </button>
          <button
            role="tab"
            aria-selected={tab === "howto"}
            onClick={() => onTab("howto")}
            className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 font-medium ${tab === "howto" ? "bg-sky-400/20 text-sky-100" : "text-slate-400 hover:text-slate-200"}`}
          >
            <Sliders size={13} /> How to use &amp; shortcuts
          </button>
          <button
            role="tab"
            aria-selected={tab === "settings"}
            onClick={() => onTab("settings")}
            className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 font-medium ${tab === "settings" ? "bg-sky-400/20 text-sky-100" : "text-slate-400 hover:text-slate-200"}`}
          >
            <Settings size={13} /> Settings
          </button>
        </div>
        <button onClick={onClose} aria-label="Close guide and settings" className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white">
          <X size={14} />
        </button>
      </div>

      {tab === "science" && (
        <div className="grid gap-3 text-slate-300 md:grid-cols-3">
          <div>
            <h3 className="mb-1 font-semibold text-white">NASA&apos;s SPHEREx telescope</h3>
            <p className="leading-relaxed">
              SPHEREx maps the entire sky every six months in <strong>102 near-infrared colours (0.75–5.0 µm)</strong> using six detectors.
              Because it uses linear variable filters, each single exposure captures one wavelength at a given star&apos;s position—so spectra are
              built from individual exposures, while blink frames stack exposures per detector and visit.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-white">Why look at these images?</h3>
            <ul className="list-disc space-y-1 pl-4 leading-relaxed">
              <li><strong>Spot motion across decades:</strong> pairing 2010 AllWISE and 2014–2024 NEOWISE with 2025–2026 SPHEREx turns slow proper motion into a visible glide.</li>
              <li><strong>See what changed:</strong> wavelength-matched epoch subtraction cancels steady stars and highlights movers (amber/cyan pairs) and variables.</li>
            </ul>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-white">What 102 infrared colours reveal</h3>
            <p className="leading-relaxed">
              Molecules invisible in optical light leave deep fingerprints between 1 and 5 µm: <strong>water ice &amp; vapour (H₂O)</strong>,{" "}
              <strong>methane (CH₄)</strong> in cool brown dwarfs (which turn pink in the Methane view), <strong>CO₂</strong>, and <strong>CO</strong>.
              Every number here comes from real IRSA archive data—nothing is simulated.
            </p>
          </div>
        </div>
      )}

      {tab === "howto" && (
        <div className="space-y-3">
          <div className="grid gap-3 text-slate-300 md:grid-cols-3">
            <div>
              <h3 className="mb-1 font-semibold text-white">Explore &amp; compare</h3>
              <p className="leading-relaxed">
                Pick a demo target or search any sky coordinate/name. Use <strong>Blink</strong> to flip visits, <strong>Difference</strong> to
                subtract visits, and <strong>Colour</strong> to mix custom 102-channel bands. Try <strong>Asinh / Log / Linear</strong> under{" "}
                <em>Image settings</em> to inspect faint nebulosity or bright cores.
              </p>
            </div>
            <div>
              <h3 className="mb-1 font-semibold text-white">Spectra &amp; provenance</h3>
              <p className="leading-relaxed">
                Click any ringed star for its PSF-fitted spectrum and light curve. Switch units between <strong>mJy</strong>, <strong>AB mag</strong>,
                and <strong>λF_λ</strong>; &lt;3σ points show as <strong>▼</strong> upper limits. Every point links to its IRSA{" "}
                <code className="mono">obs_id</code> in the Table tab and ECSV export.
              </p>
            </div>
            <div>
              <h3 className="mb-1 font-semibold text-white">Researcher workflows</h3>
              <p className="leading-relaxed">
                Export science-ready <strong>FITS</strong> (with WCS), <strong>ECSV</strong> (for Astropy), or send directly to{" "}
                <strong>Aladin / TOPCAT / DS9</strong> via <strong>SAMP</strong> (with the local server). Use <strong>List</strong> in the search
                bar to step through a CSV of candidate targets.
              </p>
            </div>
          </div>
          <div className="rounded-lg border border-sky-400/20 bg-sky-500/5 p-3 text-slate-300">
            <h3 className="mb-1 font-semibold text-white">Generate Coordinates with AI</h3>
            <p className="mb-2 leading-relaxed">
              Need interesting sky targets? Ask any AI assistant for J2000/ICRS coordinates in decimal degrees (<code className="mono">RA Dec</code>) — decimal
              coordinates bypass name-resolver servers and work directly with the SPHEREx all-sky map:
            </p>
            <div className="grid gap-2 md:grid-cols-2">
              <div className="rounded border border-white/10 bg-slate-950/60 p-2">
                <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-sky-200">
                  <span>Single target prompt</span>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard?.writeText("Give me the J2000 ICRS coordinates of a bright infrared galaxy or protostar with strong PAH or water-ice features in SPHEREx (0.75–5.0 µm), formatted strictly as decimal RA Dec on one line (example: 148.9685 69.6797).")}
                    className="rounded border border-sky-400/30 px-1.5 py-0.5 text-[10px] hover:bg-sky-400/10"
                  >
                    Copy prompt
                  </button>
                </div>
                <p className="mono text-[11px] text-slate-400">
                  "Give me the J2000 ICRS coordinates of a bright infrared galaxy or protostar with strong PAH or water-ice features in SPHEREx (0.75–5.0 µm), formatted strictly as decimal RA Dec on one line (example: 148.9685 69.6797)."
                </p>
              </div>
              <div className="rounded border border-white/10 bg-slate-950/60 p-2">
                <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-sky-200">
                  <span>Batch CSV list prompt (for the List button)</span>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard?.writeText("Generate a CSV with header name,ra,dec containing 5 famous brown dwarfs or star-forming regions in decimal degrees (ICRS J2000) ideal for 0.75–5.0 µm infrared spectroscopy.")}
                    className="rounded border border-sky-400/30 px-1.5 py-0.5 text-[10px] hover:bg-sky-400/10"
                  >
                    Copy prompt
                  </button>
                </div>
                <p className="mono text-[11px] text-slate-400">
                  "Generate a CSV with header name,ra,dec containing 5 famous brown dwarfs or star-forming regions in decimal degrees (ICRS J2000) ideal for 0.75–5.0 µm infrared spectroscopy."
                </p>
              </div>
            </div>
          </div>
          <div className="grid gap-x-6 gap-y-1 border-t border-white/10 pt-2 sm:grid-cols-2 lg:grid-cols-5">
            {SHORTCUTS.map(([k, v]) => (
              <span key={k} className={shortcutsOn || k === "Esc" ? "" : "opacity-40"}>
                <kbd className="mono mr-2 rounded border border-white/20 px-1.5 py-0.5 text-[11px] text-white">{k}</kbd>
                {v}
              </span>
            ))}
          </div>
        </div>
      )}

      {tab === "settings" && (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="font-semibold text-white">Any-spot data source</span>
              <span className="inline-flex items-center gap-1.5 text-[11px]">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    serverOnline === true ? "bg-emerald-400" : serverOnline === false ? "bg-amber-400" : "bg-slate-400"
                  }`}
                />
                {serverOnline === true ? "Local server connected" : serverOnline === false ? "Local server offline" : "Checking…"}
                <button
                  type="button"
                  onClick={onCheckServer}
                  title="Re-check local server (127.0.0.1:8091)"
                  className="ml-1 inline-flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-slate-300 hover:bg-white/10"
                >
                  <RefreshCw size={11} /> Check
                </button>
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-white/[0.04] p-1">
              {(
                [
                  ["auto", "Auto (prefer server)"],
                  ["browser", "Browser (NASA S3)"],
                  ["server", "Local server"],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  disabled={forceBrowser && m !== "browser"}
                  onClick={() => onSourceMode(m)}
                  className={`rounded-md px-2 py-1.5 text-center ${
                    (forceBrowser ? "browser" : sourceMode) === m ? "bg-sky-400/20 font-medium text-sky-100" : "text-slate-400 hover:text-slate-200"
                  } disabled:opacity-40`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400">
              {forceBrowser
                ? "Forced to browser mode by ?browser in the URL."
                : "Browser mode reads NASA's public S3 copy with nothing to install. The local server (uv run python -m spherex_blink serve) adds WISE/NEOWISE, Gaia, PSF spectra, matched differences, and SAMP."}
            </p>
          </div>
          <div className="space-y-2">
            <span className="block font-semibold text-white">Preferences</span>
            <label className="flex items-center gap-2 text-slate-300">
              <input type="checkbox" checked={shortcutsOn} onChange={(e) => onShortcuts(e.target.checked)} />
              Enable single-key shortcuts (turn off if using speech input)
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
