import json
import threading
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from spherex_blink import server


def test_parse_field_normalises_and_rejects_bad_input():
    f = server.parse_field({"ra": 370.0, "dec": -7.2, "fov": 99, "name": "x\x07y"})
    assert f == {"ra": 10.0, "dec": -7.2, "fov": 15.0, "quick": True, "name": "xy"}
    for bad in ({"ra": "nan", "dec": 0}, {"ra": "inf", "dec": 0}, {"ra": 1, "dec": 91}, {"dec": 0}, {"ra": "abc", "dec": 0}):
        with pytest.raises(ValueError):
            server.parse_field(bad)


def test_job_id_is_stable_and_hex():
    a = server.job_id(server.parse_field({"ra": 10, "dec": 5}))
    b = server.job_id(server.parse_field({"ra": 370, "dec": 5.000001}))
    assert a == b and server.ID_RE.match(a)


@pytest.fixture()
def running(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "LIVE", tmp_path)
    (tmp_path / ("a" * 16)).mkdir()
    (tmp_path / ("a" * 16) / "meta.json").write_text('{"id": "x"}')
    (tmp_path / "secret.txt").write_text("no")
    server.Handler.jobs = server.Jobs()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    monkeypatch.setattr(server, "ALLOWED_HOSTS", {f"127.0.0.1:{port}"})
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield port
    httpd.shutdown()
    server.Handler.jobs.shutdown()


def _get(port, path, host=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}")
    if host:
        req.add_header("Host", host)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def test_serves_allowlisted_bundle_files_only(running):
    assert _get(running, f"/api/bundle/{'a' * 16}/meta.json") == (200, b'{"id": "x"}')
    assert _get(running, f"/api/bundle/{'a' * 16}/../secret.txt")[0] == 404
    assert _get(running, "/api/bundle/..%2f..%2fsecret/meta.json")[0] == 404
    assert _get(running, f"/api/bundle/{'a' * 16}/secret.txt")[0] == 404


def test_rejects_other_hosts_and_get_job_starts(running):
    assert _get(running, "/api/health", host="evil.example:80")[0] == 403
    assert _get(running, "/api/health")[0] == 200
    assert _get(running, "/api/field?ra=1&dec=2")[0] == 404  # starting a job needs POST + JSON


def test_post_requires_json_and_valid_coordinates(running):
    def post(body, ctype="application/json"):
        req = urllib.request.Request(f"http://127.0.0.1:{running}/api/field", data=body, method="POST", headers={"Content-Type": ctype})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    assert post(b"ra=1", "application/x-www-form-urlencoded")[0] == 415
    assert post(b'{"ra": "nan", "dec": 0}')[0] == 400


def test_samp_staging_roundtrip_and_bounds(running):
    req = urllib.request.Request(
        f"http://127.0.0.1:{running}/api/samp",
        data=b"SIMPLE  =                    T",
        method="POST",
        headers={"Content-Type": "application/fits", "X-Filename": "barnard.fits"},
    )
    with urllib.request.urlopen(req) as r:
        assert r.status == 200
        url = json.loads(r.read())["url"]
    path = urllib.parse.urlparse(url).path
    assert _get(running, path) == (200, b"SIMPLE  =                    T")
    assert _get(running, "/api/samp/0000000000000000/nope.fits")[0] == 404
