// Talking to the local live server (backend/spherex_blink/server.py) through Vite's /api proxy.

export interface JobView {
  id: string;
  status: "queued" | "running" | "done" | "error" | "cancelled" | "unknown";
  log: string[];
  error?: string;
  position?: number;
}

export interface FieldRequest {
  ra: number;
  dec: number;
  fov: number;
  quick: boolean;
  name?: string;
}

/** ?browser: use the no-server mode (what the public site does) even when a local server runs. Read once per page. */
export const FORCE_BROWSER = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("browser");

// The URL autostart runs once per page, even if the search panel is mounted again later.
let autostarted = false;
export const claimAutostart = () => (autostarted ? false : (autostarted = true));

const json = async (r: Response) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
};

/** Is the live server reachable? (False on the static GitHub Pages build.) */
export async function liveAvailable(): Promise<boolean> {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    return r.ok && (r.headers.get("content-type") ?? "").includes("json") && (await r.json()).ok === true;
  } catch {
    return false;
  }
}

export const resolveName = async (name: string): Promise<{ name: string; ra: number; dec: number; note: string }> =>
  json(await fetch(`/api/resolve?name=${encodeURIComponent(name)}`));

export const startField = async (req: FieldRequest): Promise<JobView> =>
  json(await fetch("/api/field", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) }));

export const jobStatus = async (id: string): Promise<JobView> => json(await fetch(`/api/job/${id}`, { cache: "no-store" }));

export const cancelJob = async (id: string): Promise<JobView> =>
  json(await fetch(`/api/job/${id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));

export const liveBase = (id: string) => `/api/bundle/${id}`;
