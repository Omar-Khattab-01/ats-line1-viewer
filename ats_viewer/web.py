from __future__ import annotations

import csv
import hmac
import io
import json
import mimetypes
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .store import Store

ASSETS = Path(__file__).parent / "web_assets"


def excel_safe(value):
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False)
    text = str(value)
    return "'" + text if text.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")) else text


class App:
    def __init__(self, store, initial_path=""):
        self.store = store
        self.initial_path = initial_path
        self.token = secrets.token_urlsafe(32)
        self.job = {"status": "idle"}
        self.lock = threading.Lock()

    def load(self, path):
        with self.lock:
            if self.job["status"] == "running":
                raise ValueError("An import is already running")
            job = {"status": "running", "message": "Discovering XML snapshots and ZIP archives", "scanned": 0, "changed": 0}
            self.job = job

        def run():
            try:
                result = self.store.ingest(path, job)
                job.update(result, status="complete")
            except Exception as exc:
                job.update(status="failed", error=str(exc))
        threading.Thread(target=run, daemon=True).start()
        return dict(job)


def handler_for(app):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            if args and str(args[1] if len(args) > 1 else "") != "200":
                super().log_message(fmt, *args)

        def authorized(self, query):
            token = self.headers.get("X-ATS-Token") or query.get("token", [""])[0]
            return hmac.compare_digest(token, app.token)

        def valid_host(self):
            return self.headers.get("Host", "") in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}")

        def send(self, data, mime="application/json; charset=utf-8", status=200, filename=None):
            if not isinstance(data, bytes):
                data = json.dumps(data, ensure_ascii=False).encode() if mime.startswith("application/json") else str(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'")
            if filename:
                self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            try:
                parsed = urlparse(self.path)
                query = parse_qs(parsed.query, keep_blank_values=True)
                path = parsed.path
                if not self.valid_host():
                    return self.send({"error": "Invalid local host"}, status=403)
                if path.startswith("/api/"):
                    if not self.authorized(query):
                        return self.send({"error": "Reload the local viewer to reconnect"}, status=403)
                    return self.api_get(path, query)
                if path == "/":
                    return self.send((ASSETS / "index.html").read_text(encoding="utf-8").replace("__TOKEN__", app.token), "text/html; charset=utf-8")
                if path in ("/app.js", "/app.css", "/favicon.svg"):
                    mime = {"/app.js": "text/javascript", "/app.css": "text/css", "/favicon.svg": "image/svg+xml"}[path]
                    return self.send((ASSETS / path[1:]).read_bytes(), mime + "; charset=utf-8")
                self.send({"error": "Not found"}, status=404)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except (ValueError, sqlite3.Error, OSError) as exc:
                self.send({"error": str(exc)}, status=400)

        def api_get(self, path, query):
            get = lambda key, default="": query.get(key, [default])[0]
            dataset = get("dataset")
            if path == "/api/session":
                return self.send({"datasets": app.store.datasets(), "initial_path": app.initial_path, "database": str(app.store.path)})
            if path == "/api/job":
                return self.send(dict(app.job))
            if path == "/api/overview":
                return self.send(app.store.overview(dataset))
            if path == "/api/snapshot":
                offset = float(get("clock", "240"))
                if not -1440 <= offset <= 1440:
                    raise ValueError("Clock difference must be between -1440 and 1440 minutes")
                return self.send(app.store.snapshot(dataset, int(get("id")), offset))
            if path == "/api/rows":
                return self.send(app.store.query(dataset, get("kind", "predictions"), {k: get(k) for k in ("train", "platform", "snapshot", "from", "to", "q", "flag", "code")},
                                                 max(1, min(1000, int(get("limit", "100")))), max(0, int(get("offset", "0")))))
            if path == "/api/raw":
                name, raw = app.store.raw(dataset, int(get("id")))
                filename = name.replace("\\", "/").split("/")[-1].strip()
                safe = "".join(c for c in filename if c.isalnum() or c in "._-") or "snapshot.xml"
                return self.send(raw, "text/plain; charset=utf-8", filename=safe if get("download") else None)
            if path == "/api/export":
                kind = get("kind", "predictions")
                filters = {k: get(k) for k in ("train", "platform", "snapshot", "from", "to", "q", "flag", "code")}
                # Validate and start the first page before sending HTTP headers.
                batches = app.store.export_rows(dataset, kind, filters)
                first = next(batches, [])
                fields = (["capture", "platform", "consist", "train_id", "identity_status", "arr", "dep", "destination", "next_platform", "direction", "stop", "service", "speed", "cars", "source", "raw"]
                          if kind == "predictions" else ["capture", "time", "code", "event_label", "event_label_status", "platform", "consist", "train_id", "vehicles", "source", "raw"])
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Disposition", f'attachment; filename="ats-{kind}.csv"')
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(b"\xef\xbb\xbf")
                buffer = io.StringIO(newline="")
                writer = csv.DictWriter(buffer, fields, extrasaction="ignore")
                writer.writeheader()
                def write_batch(batch):
                    for row in batch:
                        writer.writerow({k: excel_safe(row.get(k)) for k in fields})
                    self.wfile.write(buffer.getvalue().encode())
                    buffer.seek(0)
                    buffer.truncate(0)
                try:
                    write_batch(first)
                    for batch in batches:
                        write_batch(batch)
                finally:
                    batches.close()
                return
            if path == "/api/database":
                with tempfile.TemporaryDirectory(prefix="ats-backup-") as folder:
                    backup = Path(folder) / "ats-workspace.sqlite"
                    app.store.backup(backup)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/vnd.sqlite3")
                    self.send_header("Content-Disposition", 'attachment; filename="ats-workspace.sqlite"')
                    self.send_header("Content-Length", str(backup.stat().st_size))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    with backup.open("rb") as stream:
                        while chunk := stream.read(1024 * 1024):
                            self.wfile.write(chunk)
                return
            self.send({"error": "Not found"}, status=404)

        def do_POST(self):
            try:
                if not self.valid_host() or not self.authorized({}):
                    return self.send({"error": "Invalid local session; reload the viewer"}, status=403)
                origin = self.headers.get("Origin")
                if origin and origin not in (f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"):
                    return self.send({"error": "Invalid origin"}, status=403)
                length = int(self.headers.get("Content-Length", "0"))
                if length > 16384 or length < 0:
                    raise ValueError("Request is too large")
                body = json.loads(self.rfile.read(length) or b"{}")
                if self.path == "/api/load":
                    return self.send(app.load(body.get("path", "")))
                if self.path == "/api/pick":
                    kind = body.get("kind", "folder")
                    if kind not in ("folder", "zip"):
                        raise ValueError("Unsupported picker")
                    result = subprocess.run([sys.executable, "-m", "ats_viewer.picker", kind], capture_output=True, text=True, timeout=120)
                    if result.returncode:
                        raise ValueError("The native picker is unavailable. Paste the folder or ZIP path into the path field.")
                    return self.send(json.loads(result.stdout))
                self.send({"error": "Not found"}, status=404)
            except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
                self.send({"error": str(exc)}, status=400)
    return Handler


def serve(database, port=8766, open_browser=False, initial_path=""):
    app = App(Store(database), initial_path)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), handler_for(app))
    except OSError as exc:
        raise SystemExit(f"Cannot start on port {port}: {exc}. Choose another port with --port 8767.")
    server.daemon_threads = True
    url = f"http://127.0.0.1:{server.server_port}"
    print(f"ATS · Line 1 viewer: {url}\nLocal database: {app.store.path}\nPress Ctrl+C to stop.", flush=True)
    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nViewer stopped. The local database is saved.")
    finally:
        server.server_close()
