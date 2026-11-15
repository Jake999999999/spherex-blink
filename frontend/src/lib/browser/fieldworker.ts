// Runs buildField off the main thread, so the page stays responsive while exposures stream in.
/// <reference lib="webworker" />
import { buildField, type FieldRequest } from "./fieldbuild";

let ctl: AbortController | null = null;

self.onmessage = async (ev: MessageEvent<{ type: "start"; req: FieldRequest } | { type: "cancel" }>) => {
  const msg = ev.data;
  if (msg.type === "cancel") {
    ctl?.abort();
    return;
  }
  ctl = new AbortController();
  try {
    const files = await buildField(msg.req, (p) => self.postMessage({ type: "progress", p }), ctl.signal);
    const transfer = Object.values(files).filter((v): v is ArrayBuffer => v instanceof ArrayBuffer);
    self.postMessage({ type: "done", files }, { transfer });
  } catch (e) {
    const err = e as Error;
    self.postMessage({ type: "error", error: err.name === "AbortError" ? "cancelled" : err.message || String(e) });
  }
};
