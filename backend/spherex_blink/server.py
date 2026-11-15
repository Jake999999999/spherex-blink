"""Local live server: any sky position, fetched from NASA's archives on request (PLAN.md M7, Tier B).

Web pages can't query IRSA or Gaia directly (no CORS), so this small server runs the same pipeline as
the baked targets for any position and serves the result. Standard library only; loopback only.

Endpoints (Vite's dev server proxies /api here):
  GET  /api/health
  GET  /api/resolve?name=R+Draconis      -> {name, ra, dec} via CDS Sesame
  POST /api/field  {ra, dec, fov, quick, name} -> {id, status}
  GET  /api/job/<id>                     -> {id, status, log[], error?}
  POST /api/job/<id>/cancel
  GET  /api/bundle/<id>/<file>           -> bundle files (allowlist)

Safety (architect review): state changes need POST with a JSON body; the Host header must be this
machine (stops other web pages and DNS rebinding); no CORS headers; inputs validated; bundle ids and
file names allowlisted; one job at a time with a timeout; results written to a temp folder and renamed
only on success; at most LIVE_KEEP results kept.
"""

from __future__ import annotations

import collections
import hashlib
import json
import math
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx

from . import __version__, irsa

HOST = "127.0.0.1"
PORT = 8091
LIVE = irsa.CACHE_ROOT / "live"
LIVE_KEEP = 25
JOB_TIMEOUT_S = 25 * 60
ALLOWED_HOSTS = {f"{h}:{p}" for h in ("127.0.0.1", "localhost") for p in (8091, 5186, 5187)}
ID_RE = re.compile(r"^[0-9a-f]{16}$")
FILES = {
    "meta.json": "application/json",
    "gaia.json": "application/json",
    "spectra.json": "application/json",
    "frames.bin": "application/octet-stream",
    "cube.bin": "application/octet-stream",
    "finecube.bin": "application/octet-stream",
    "flags.bin": "application/octet-stream",
    "neowise.bin": "application/octet-stream",
}
SESAME = "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV"
BACKEND = Path(__file__).resolve().parents[1]


def parse_field(body: dict) -> dict:
    """Validated, normalised field request. Raises ValueError with a readable message."""
    try:
        ra = float(body["ra"])
        dec = float(body["dec"])
        fov = float(body.get("fov", 5.0))
    except (KeyError, TypeError, ValueError):
        raise ValueError("ra and dec must be numbers (degrees)") from None
    if not all(math.isfinite(v) for v in (ra, dec, fov)):
        raise ValueError("ra, dec and fov must be finite numbers")
    if not -90.0 <= dec <= 90.0:
        raise ValueError("dec must be between -90 and +90 degrees")
    ra %= 360.0
    fov = min(15.0, max(2.0, fov))
    quick = bool(body.get("quick", True))
    name = str(body.get("name") or "")[:80]
    name = re.sub(r"[\x00-\x1f]", "", name)
    return {"ra": round(ra, 5), "dec": round(dec, 5), "fov": round(fov, 1), "quick": quick, "name": name}


def job_id(f: dict) -> str:
    return hashlib.sha1(f"{f['ra']:.5f},{f['dec']:.5f},{f['fov']:.1f},{int(f['quick'])}".encode()).hexdigest()[:16]


class Jobs:
    """One worker, one job at a time, FIFO queue; job table under a lock."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.jobs: dict[str, dict] = {}
        self.queue: collections.deque[str] = collections.deque()
        self.proc: subprocess.Popen | None = None
        self.current: str | None = None
        self.stop = threading.Event()
        self.wake = threading.Event()
        threading.Thread(target=self._worker, daemon=True).start()

    def submit(self, f: dict) -> dict:
        jid = job_id(f)
        with self.lock:
            if (LIVE / jid / "meta.json").exists():
                self.jobs[jid] = {"id": jid, "status": "done", "log": ["ready (from cache)"], "field": f}
            elif jid not in self.jobs or self.jobs[jid]["status"] in ("error", "cancelled"):
                self.jobs[jid] = {"id": jid, "status": "queued", "log": collections.deque(maxlen=200), "field": f, "queued_at": time.time()}
                self.queue.append(jid)
                self.wake.set()
            return self.view(jid)

    def view(self, jid: str) -> dict:
        j = self.jobs.get(jid)
        if not j:
            if (LIVE / jid / "meta.json").exists():
                return {"id": jid, "status": "done", "log": []}
            return {"id": jid, "status": "unknown", "log": []}
        out = {"id": jid, "status": j["status"], "log": list(j["log"])[-14:]}
        if j["status"] == "queued":
            out["position"] = list(self.queue).index(jid) + 1 if jid in self.queue else 0
        if "error" in j:
            out["error"] = j["error"]
        return out

    def cancel(self, jid: str) -> dict:
        with self.lock:
            j = self.jobs.get(jid)
            if not j:
                return self.view(jid)
            if jid in self.queue:
                self.queue.remove(jid)
                j["status"] = "cancelled"
            elif self.current == jid and self.proc:
                j["status"] = "cancelled"
                self.proc.kill()
            return self.view(jid)

    def shutdown(self) -> None:
        self.stop.set()
        self.wake.set()
        if self.proc and self.proc.poll() is None:
            self.proc.kill()

    def _worker(self) -> None:
        while not self.stop.is_set():
            self.wake.wait(1.0)
            self.wake.clear()
            while not self.stop.is_set():
                with self.lock:
                    if not self.queue:
                        break
                    jid = self.queue.popleft()
                    j = self.jobs[jid]
                    j["status"] = "running"
                    self.current = jid
                self._run(jid, j)
                with self.lock:
                    self.current = None
                    self.proc = None
                prune()

    def _run(self, jid: str, j: dict) -> None:
        f = j["field"]
        tmp = LIVE / f"_tmp_{jid}"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True, exist_ok=True)
        argv = [sys.executable, "-u", "-X", "utf8", "-m", "spherex_blink", "field", "--ra", str(f["ra"]), "--dec", str(f["dec"]),
                "--fov", str(f["fov"]), "--id", jid, "--out", str(tmp)]
        if f["quick"]:
            argv.append("--quick")
        if f["name"]:
            argv += ["--name", f["name"]]
        log = j["log"]
        log.append(f"fetching {'a quick look' if f['quick'] else 'all visits'} for RA {f['ra']}, Dec {f['dec']}, {f['fov']}′ field")
        try:
            proc = subprocess.Popen(argv, cwd=BACKEND, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        except OSError as e:
            j["status"], j["error"] = "error", f"could not start the pipeline: {e}"
            return
        with self.lock:
            self.proc = proc

        def drain() -> None:  # never let the pipe fill (it stalls on Windows)
            assert proc.stdout
            for line in proc.stdout:
                line = line.rstrip()
                if line and not line.startswith("  ! https"):
                    log.append(line.strip())

        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        try:
            rc = proc.wait(timeout=JOB_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            proc.kill()
            rc = -1
            log.append(f"stopped after {JOB_TIMEOUT_S // 60} minutes")
        reader.join(timeout=5)
        if j["status"] == "cancelled":
            shutil.rmtree(tmp, ignore_errors=True)
            return
        built = tmp / jid
        if rc == 0 and (built / "meta.json").exists():
            dest = LIVE / jid
            shutil.rmtree(dest, ignore_errors=True)
            built.rename(dest)
            shutil.rmtree(tmp, ignore_errors=True)
            j["status"] = "done"
            log.append("ready")
        else:
            j["status"] = "error"
            last = [ln for ln in log if "!!" in ln or "Error" in ln or "error" in ln]
            j["error"] = (last[-1] if last else (log[-1] if log else "the pipeline failed")).replace("!! ", "")
            shutil.rmtree(tmp, ignore_errors=True)


def prune(keep: int = LIVE_KEEP) -> None:
    """Keep only the newest `keep` live results (the folder is gitignored; this caps disk use)."""
    if not LIVE.exists():
        return
    done = sorted((p for p in LIVE.iterdir() if p.is_dir() and ID_RE.match(p.name)), key=lambda p: p.stat().st_mtime, reverse=True)
    for p in done[keep:]:
        shutil.rmtree(p, ignore_errors=True)


SAMP_MAX_BYTES = 16 * 1024 * 1024
SAMP_MAX_ITEMS = 8
SAMP_TTL_S = 600
SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")


class SampStore:
    """Short-lived in-memory staging for Web SAMP hand-off (Aladin/TOPCAT/DS9)."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.items: dict[str, tuple[str, bytes, str, float]] = {}

    def put(self, filename: str, data: bytes, content_type: str) -> tuple[str, str]:
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", filename)[:80] or "export.bin"
        if not SAFE_NAME_RE.match(safe):
            safe = "export.bin"
        token = secrets.token_hex(8)
        now = time.monotonic()
        with self.lock:
            self._prune_locked(now)
            while len(self.items) >= SAMP_MAX_ITEMS:
                oldest = min(self.items, key=lambda k: self.items[k][3])
                del self.items[oldest]
            self.items[token] = (safe, data, content_type, now)
        return token, safe

    def get(self, token: str, filename: str) -> tuple[bytes, str] | None:
        now = time.monotonic()
        with self.lock:
            self._prune_locked(now)
            item = self.items.get(token)
            if not item or item[0] != filename:
                return None
            return item[1], item[2]

    def _prune_locked(self, now: float) -> None:
        expired = [k for k, v in self.items.items() if now - v[3] > SAMP_TTL_S]
        for k in expired:
            del self.items[k]


_resolve_cache: dict[str, dict] = {}


def resolve_name(name: str) -> dict:
    """Object name -> ICRS position via CDS Sesame (SIMBAD/NED/VizieR)."""
    name = name.strip()
    if not name or len(name) > 64:
        raise ValueError("name must be 1-64 characters")
    if name in _resolve_cache:
        return _resolve_cache[name]
    with httpx.Client(timeout=20, headers={"User-Agent": irsa.USER_AGENT}, follow_redirects=True) as c:
        raw = irsa.get_with_retry(c, f"{SESAME}?{urllib.parse.quote(name)}", tries=3).decode("utf-8", "replace")
    ra = re.search(r"<jradeg>\s*([-\d.eE+]+)\s*</jradeg>", raw)
    dec = re.search(r"<jdedeg>\s*([-\d.eE+]+)\s*</jdedeg>", raw)
    if not (ra and dec):
        raise LookupError(f"no position found for “{name}”")
    oname = re.search(r"<oname>\s*([^<]+?)\s*</oname>", raw)
    out = {"name": oname.group(1) if oname else name, "ra": float(ra.group(1)), "dec": float(dec.group(1)),
           "note": "J2000 position from SIMBAD/NED via CDS Sesame; fast-moving stars may have moved since."}
    _resolve_cache[name] = out
    return out


class Handler(BaseHTTPRequestHandler):
    jobs: Jobs
    samp: SampStore = SampStore()
    server_version = f"spherex-blink/{__version__}"

    def log_message(self, fmt: str, *args) -> None:  # quieter console
        if "/api/job/" not in (args[0] if args else ""):
            sys.stderr.write("%s\n" % (fmt % args))

    def _host_ok(self) -> bool:
        return (self.headers.get("Host") or "") in ALLOWED_HOSTS

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if not self._host_ok():
            return self._json(403, {"error": "this server only answers this computer"})
        url = urllib.parse.urlparse(self.path)
        parts = [p for p in url.path.split("/") if p]
        if parts == ["api", "health"]:
            return self._json(200, {"ok": True, "version": __version__})
        if parts == ["api", "resolve"]:
            name = urllib.parse.parse_qs(url.query).get("name", [""])[0]
            try:
                return self._json(200, resolve_name(name))
            except ValueError as e:
                return self._json(400, {"error": str(e)})
            except (LookupError, irsa.FetchError) as e:
                return self._json(404, {"error": str(e)})
        if len(parts) == 3 and parts[:2] == ["api", "job"] and ID_RE.match(parts[2]):
            return self._json(200, self.jobs.view(parts[2]))
        if len(parts) == 4 and parts[:2] == ["api", "bundle"] and ID_RE.match(parts[2]) and parts[3] in FILES:
            path = (LIVE / parts[2] / parts[3]).resolve()
            if not path.is_relative_to(LIVE.resolve()) or not path.is_file():
                return self._json(404, {"error": "not found"})
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", FILES[parts[3]])
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if len(parts) == 4 and parts[:2] == ["api", "samp"] and ID_RE.match(parts[2]) and SAFE_NAME_RE.match(parts[3]):
            item = self.samp.get(parts[2], parts[3])
            if not item:
                return self._json(404, {"error": "not found"})
            data, ctype = item
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Disposition", f'inline; filename="{parts[3]}"')
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return
        return self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._host_ok():
            return self._json(403, {"error": "this server only answers this computer"})
        parts = [p for p in urllib.parse.urlparse(self.path).path.split("/") if p]
        if parts == ["api", "samp"]:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return self._json(400, {"error": "bad Content-Length"})
            if length <= 0 or length > SAMP_MAX_BYTES:
                return self._json(413, {"error": f"payload must be 1..{SAMP_MAX_BYTES} bytes"})
            data = self.rfile.read(length)
            fname = self.headers.get("X-Filename") or "export.fits"
            ctype = (self.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip()
            token, safe = self.samp.put(fname, data, ctype)
            host_hdr = self.headers.get("Host") or f"{HOST}:{PORT}"
            # Direct desktop SAMP clients to the Python server port if proxied through Vite.
            if host_hdr.endswith(f":{PORT}"):
                base = f"http://{host_hdr}"
            else:
                base = f"http://{HOST}:{PORT}"
            return self._json(200, {"url": f"{base}/api/samp/{token}/{safe}"})
        if (self.headers.get("Content-Type") or "").split(";")[0].strip() != "application/json":
            return self._json(415, {"error": "send JSON"})
        n = min(int(self.headers.get("Content-Length") or 0), 4096)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "bad JSON"})
        if parts == ["api", "field"]:
            try:
                f = parse_field(body if isinstance(body, dict) else {})
            except ValueError as e:
                return self._json(400, {"error": str(e)})
            return self._json(200, self.jobs.submit(f))
        if len(parts) == 4 and parts[:2] == ["api", "job"] and ID_RE.match(parts[2]) and parts[3] == "cancel":
            return self._json(200, self.jobs.cancel(parts[2]))
        return self._json(404, {"error": "not found"})


def serve(host: str = HOST, port: int = PORT) -> None:
    LIVE.mkdir(parents=True, exist_ok=True)
    jobs = Jobs()
    Handler.jobs = jobs
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"SPHEREx Blink live server on http://{host}:{port} (Ctrl+C to stop)", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        jobs.shutdown()
        httpd.server_close()
