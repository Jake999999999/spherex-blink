/**
 * Minimal IVOA Web SAMP client (http://127.0.0.1:21012/) for handing off
 * FITS images and spectrum tables to desktop tools (Aladin, TOPCAT, DS9).
 */

export const SAMP_HUB_URL = "http://127.0.0.1:21012/";

export type SampMtype = "image.load.fits" | "table.load.votable";

const xmlEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function encodeValue(v: unknown): string {
  if (typeof v === "string") return `<value><string>${xmlEsc(v)}</string></value>`;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const members = Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `<member><name>${xmlEsc(k)}</name>${encodeValue(val)}</member>`)
      .join("");
    return `<value><struct>${members}</struct></value>`;
  }
  throw new Error(`Unsupported XML-RPC value: ${typeof v}`);
}

export function buildXmlRpcCall(method: string, params: unknown[]): string {
  const ps = params.map((p) => `<param>${encodeValue(p)}</param>`).join("");
  return `<?xml version="1.0"?><methodCall><methodName>${xmlEsc(method)}</methodName><params>${ps}</params></methodCall>`;
}

export function parseXmlRpcStruct(xml: string): Record<string, string> {
  const fault = xml.match(/<fault>[\s\S]*?<string>([\s\S]*?)<\/string>/);
  if (fault) throw new Error(`SAMP hub error: ${fault[1].trim()}`);
  const out: Record<string, string> = {};
  const re = /<member>\s*<name>([^<]+)<\/name>\s*<value>(?:\s*<string>)?([\s\S]*?)(?:<\/string>\s*)?<\/value>\s*<\/member>/g;
  for (const m of xml.matchAll(re)) {
    out[m[1].trim()] = m[2].trim();
  }
  return out;
}

async function rpc(method: string, params: unknown[], fetcher: typeof fetch = fetch): Promise<Record<string, string>> {
  let res: Response;
  try {
    res = await fetcher(SAMP_HUB_URL, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: buildXmlRpcCall(method, params),
    });
  } catch {
    throw new Error("No SAMP hub found on localhost:21012 — open Aladin, TOPCAT, or DS9 first.");
  }
  if (!res.ok) throw new Error(`SAMP hub returned HTTP ${res.status}`);
  return parseXmlRpcStruct(await res.text());
}

/** Stage bytes on the local Python server so desktop SAMP clients can fetch an http:// URL. */
export async function stageForSamp(
  filename: string,
  data: Uint8Array | string,
  contentType: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const body = typeof data === "string" ? data : new Uint8Array(data);
  let res: Response;
  try {
    res = await fetcher("/api/samp", {
      method: "POST",
      headers: { "Content-Type": contentType, "X-Filename": filename },
      body,
    });
  } catch {
    throw new Error("Start the local server (uv run python -m spherex_blink serve) for SAMP hand-off, or use Download.");
  }
  if (res.status === 404 || res.status === 405 || res.status === 415 || res.status === 502) {
    throw new Error("Start the local server (uv run python -m spherex_blink serve) for SAMP hand-off, or use Download.");
  }
  if (!res.ok) throw new Error(`Could not stage file for SAMP (HTTP ${res.status})`);
  const json = (await res.json()) as { url?: string };
  if (!json.url) throw new Error("Server did not return a SAMP URL");
  return json.url;
}

/** Register with the local Web SAMP hub, broadcast the file URL, and unregister. */
export async function sendViaSamp(
  opts: { filename: string; data: Uint8Array | string; contentType: string; mtype: SampMtype; label?: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const url = await stageForSamp(opts.filename, opts.data, opts.contentType, fetcher);
  const reg = await rpc("samp.hub.register", [{ "samp.name": "SPHEREx Blink" }], fetcher);
  const key = reg["samp.private-key"];
  if (!key) throw new Error("SAMP hub did not grant a private key");
  try {
    await rpc(
      "samp.hub.declareMetadata",
      [key, { "samp.name": "SPHEREx Blink", "samp.description.text": "NASA SPHEREx blink comparator & spectrum explorer" }],
      fetcher,
    );
    await rpc(
      "samp.hub.notifyAll",
      [key, { "samp.mtype": opts.mtype, "samp.params": { url, name: opts.label ?? opts.filename } }],
      fetcher,
    );
  } finally {
    await rpc("samp.hub.unregister", [key], fetcher).catch(() => {});
  }
}
