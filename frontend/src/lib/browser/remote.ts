// Reading NASA's public SPHEREx copy on Amazon S3 straight from the browser (it allows cross-origin
// GET/HEAD and byte ranges). Only this one bucket is ever contacted, and only keys that look like
// SPHEREx products: URLs found in dropped files are never fetched as given.

import { FitsError, type ByteSource } from "./fitsread";

export const S3_BASE = "https://nasa-irsa-spherex.s3.amazonaws.com/";
const KEY_RE = /^(dr1|qr2|qr3)\/(level2\/[0-9]{4}W[0-9]{2}_[0-9A-Z]{2}\/l2b(?:_retry)?-v[0-9]+-[0-9]{4}-[0-9]{3}\/[1-6]\/level2_[0-9A-Za-z_-]+\.fits|hips5_cube\/hips_[0-9]{8}\/Norder5\/Dir[0-9]+\/Npix[0-9]+_cube\.fits)$/;

export function safeKey(key: string): string | null {
  if (key.length > 300 || key.includes("..") || key.includes("%") || key.includes("//")) return null;
  return KEY_RE.test(key) ? key : null;
}

export interface Meter {
  bytes: number;
  requests: number;
}

/** At most `n` requests in flight (browsers allow ~6 per host over HTTP/1.1; S3 serves HTTP/1.1). */
export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private n = 4) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new DOMException("cancelled", "AbortError"));
    });
  });

export async function fetchRetry(url: string, init: RequestInit, signal?: AbortSignal, tries = 6): Promise<Response> {
  let last: unknown = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...init, signal });
      if (r.ok || r.status === 206) return r;
      if (r.status !== 500 && r.status !== 502 && r.status !== 503 && r.status !== 429) throw new FitsError(`HTTP ${r.status} for ${url.replace(S3_BASE, "")}`);
      last = new FitsError(`HTTP ${r.status}`);
    } catch (e) {
      if ((e as Error).name === "AbortError" || e instanceof FitsError) throw e;
      last = e;
    }
    await sleep(500 * 2 ** i * (0.5 + Math.random()), signal);
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function s3Size(key: string, limiter: Limiter, signal?: AbortSignal): Promise<number> {
  const k = safeKey(key);
  if (!k) throw new FitsError("not a SPHEREx product key");
  const r = await limiter.run(() => fetchRetry(S3_BASE + k, { method: "HEAD" }, signal));
  const n = Number(r.headers.get("content-length"));
  if (!Number.isFinite(n) || n <= 0) throw new FitsError("no file size");
  return n;
}

/** A ByteSource over one S3 object, read with HTTP Range requests. */
export async function s3Source(key: string, limiter: Limiter, meter: Meter, signal?: AbortSignal): Promise<ByteSource> {
  const k = safeKey(key)!;
  const size = await s3Size(k, limiter, signal);
  return {
    size,
    label: k.split("/").pop()!,
    async read(start, length, sig) {
      if (start < 0 || length <= 0 || start + length > size) throw new FitsError("read past the end");
      const r = await limiter.run(() => fetchRetry(S3_BASE + k, { headers: { Range: `bytes=${start}-${start + length - 1}` } }, sig ?? signal));
      const buf = await r.arrayBuffer();
      meter.bytes += buf.byteLength;
      meter.requests++;
      if (r.status === 200 && buf.byteLength === size && length !== size) return buf.slice(start, start + length); // server ignored Range
      if (buf.byteLength !== length) throw new FitsError("short read");
      return buf;
    },
  };
}

/** Newest all-sky map release folder (hips_YYYYMMDD) in the bucket. */
export async function cubeReleases(signal?: AbortSignal): Promise<string[]> {
  const r = await fetchRetry(`${S3_BASE}?list-type=2&prefix=dr1/hips5_cube/&delimiter=/`, {}, signal);
  const text = await r.text();
  const found = [...text.matchAll(/<Prefix>dr1\/hips5_cube\/(hips_\d{8})\/<\/Prefix>/g)].map((m) => m[1]);
  return [...new Set(found)].sort().reverse();
}
