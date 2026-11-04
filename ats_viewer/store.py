"""Single-file, disk-backed collections of raw snapshots and parsed ATS records."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import statistics
import threading
import zipfile
from contextlib import closing, contextmanager
from datetime import datetime, timedelta
from pathlib import Path

from .parser import STATIONS, capture_time, parse, timestamp
from .operations import EVENT_CODES, consist_label, estimate_positions, seconds

MAX_XML_BYTES = 32 * 1024 * 1024
SCHEMA = """
CREATE TABLE IF NOT EXISTS datasets(id TEXT PRIMARY KEY, path TEXT NOT NULL, updated TEXT);
CREATE TABLE IF NOT EXISTS snapshots(
 id INTEGER PRIMARY KEY, dataset TEXT NOT NULL, source_key TEXT NOT NULL,
 name TEXT NOT NULL, capture TEXT, sha TEXT NOT NULL, size INTEGER NOT NULL,
 status TEXT NOT NULL, error TEXT, warnings TEXT NOT NULL, raw BLOB NOT NULL,
 duplicate_of INTEGER, UNIQUE(dataset,source_key));
CREATE INDEX IF NOT EXISTS snapshot_dataset ON snapshots(dataset,capture,id);
CREATE TABLE IF NOT EXISTS platforms(
 snapshot INTEGER REFERENCES snapshots(id) ON DELETE CASCADE,
 platform TEXT, closed TEXT, held TEXT);
CREATE INDEX IF NOT EXISTS platform_snapshot ON platforms(snapshot);
CREATE TABLE IF NOT EXISTS predictions(
 row_id INTEGER PRIMARY KEY, snapshot INTEGER REFERENCES snapshots(id) ON DELETE CASCADE,
 platform TEXT, train_id TEXT, arr TEXT, dep TEXT, direction TEXT,
 destination TEXT, next_platform TEXT, stop TEXT, service TEXT, speed TEXT, cars TEXT, raw TEXT);
CREATE INDEX IF NOT EXISTS prediction_snapshot ON predictions(snapshot,platform,train_id);
CREATE INDEX IF NOT EXISTS prediction_train ON predictions(train_id,snapshot);
CREATE TABLE IF NOT EXISTS events(
 row_id INTEGER PRIMARY KEY, snapshot INTEGER REFERENCES snapshots(id) ON DELETE CASCADE,
 platform TEXT, train_id TEXT, time TEXT, code TEXT, vehicles TEXT, raw TEXT);
CREATE INDEX IF NOT EXISTS event_snapshot ON events(snapshot);
"""


def clean_path(value):
    value = str(value).strip()
    if len(value) > 1 and (value[0], value[-1]) in (("\"", "\""), ("'", "'"), ("“", "”"), ("‘", "’")):
        value = value[1:-1]
    if not value:
        raise ValueError("Enter the path to a folder of ATS XML files or ZIP archives")
    return Path(value).expanduser().resolve()


def json_value(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def rows(connection, sql, args=()):
    return [dict(row) for row in connection.execute(sql, args)]


def snapshot_folder(name):
    """Use the containing path, including the archive name for ZIP members."""
    return name.replace(" / ", "/").replace("\\", "/").rpartition("/")[0] or "."


def count_events(db, source_ids, args):
    return rows(db, f"""SELECT e.platform, e.code, count(*) AS count
        FROM events e JOIN ({source_ids}) s ON s.id=e.snapshot
        GROUP BY e.code, e.platform ORDER BY e.code, e.platform""", args)


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        with self.connect() as db:
            db.executescript(SCHEMA)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def datasets(self):
        with self.connect() as db:
            return rows(db, "SELECT * FROM datasets ORDER BY updated DESC")

    def identities(self, dataset):
        """Collection-wide consist lookup; ambiguous re-couplings stay ambiguous."""
        with self.connect() as db:
            events = rows(db, "SELECT e.train_id,e.vehicles FROM events e JOIN snapshots s ON s.id=e.snapshot WHERE s.dataset=? AND s.duplicate_of IS NULL ORDER BY e.row_id", (dataset,))
        pairs = {}
        for event in events:
            label = consist_label(json.loads(event["vehicles"]), event["train_id"])
            if label:
                pairs.setdefault(event["train_id"], set()).add(label)
        return {tid: {"variants": sorted(labels), "label": next(iter(labels)) if len(labels) == 1 else None,
                      "status": "event vehicle IDs" if len(labels) == 1 else "multiple consists in collection"}
                for tid, labels in pairs.items()}

    @staticmethod
    def label_row(row, identities):
        identity = identities.get(row.get("train_id"), {})
        own = consist_label(row.get("vehicles", []), row.get("train_id"))
        row["consist"] = own or identity.get("label") or ""
        row["identity_status"] = "this event" if own else identity.get("status", "vehicle pair unavailable")
        if "code" in row:
            definition = EVENT_CODES.get(row["code"], {})
            row["event_label"] = definition.get("label", "Unknown code")
            row["event_label_status"] = definition.get("status", "unknown")
        return row

    def ingest(self, value, progress=None):
        root = clean_path(value)
        if not root.exists():
            raise ValueError(f"Path does not exist: {root}")
        if not root.is_dir() and root.suffix.lower() not in (".xml", ".zip"):
            raise ValueError("Choose a folder, an XML snapshot, or a ZIP archive")
        dataset = hashlib.sha256(str(root).encode()).hexdigest()[:24]
        progress = progress if progress is not None else {}
        with self.lock, self.connect() as db:
            db.execute("INSERT OR IGNORE INTO datasets(id,path) VALUES(?,?)", (dataset, str(root)))
            db.commit()
            seen, scanned, changed = set(), 0, 0

            def save(key, name, data, read_error=None):
                nonlocal scanned, changed
                seen.add(key)
                scanned += 1
                digest = hashlib.sha256(data).hexdigest()
                old = db.execute("SELECT id,sha,error FROM snapshots WHERE dataset=? AND source_key=?", (dataset, key)).fetchone()
                progress.update(message=f"Reading {name}", scanned=scanned, changed=changed)
                if old and old["sha"] == digest and not read_error and not (old["error"] or "").startswith(("Source could not be read", "ZIP could not be read")):
                    return
                try:
                    if read_error:
                        raise ValueError(read_error)
                    parsed = parse(data)
                except Exception as exc:
                    parsed = {"status": "invalid", "error": str(exc), "warnings": [], "platforms": [], "predictions": [], "events": []}
                capture = capture_time(name)
                if not capture:
                    parsed["warnings"].append("No valid tp_YYYYMMDDHHMMSS filename timestamp; relative countdown unavailable")
                if old:
                    db.execute("DELETE FROM snapshots WHERE id=?", (old["id"],))
                cur = db.execute("INSERT INTO snapshots(dataset,source_key,name,capture,sha,size,status,error,warnings,raw) VALUES(?,?,?,?,?,?,?,?,?,?)",
                                 (dataset, key, name, capture, digest, len(data), parsed["status"], parsed["error"], json_value(parsed["warnings"]), data))
                sid = cur.lastrowid
                db.executemany("INSERT INTO platforms VALUES(?,?,?,?)", [(sid, p["platform"], p["closed"], p["held"]) for p in parsed["platforms"]])
                db.executemany("INSERT INTO predictions(snapshot,platform,train_id,arr,dep,direction,destination,next_platform,stop,service,speed,cars,raw) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                               [(sid, p["platform"], p["id"], p["arr"], p["dep"], p["dir"], p["dest"], p["next"], p["stop"], p["serv"], p["speed"], p["cars"], json_value(p["raw"])) for p in parsed["predictions"]])
                db.executemany("INSERT INTO events(snapshot,platform,train_id,time,code,vehicles,raw) VALUES(?,?,?,?,?,?,?)",
                               [(sid, e["platform"], e["id"], e["time"], e["code"], json_value(e["vehicles"]), json_value(e)) for e in parsed["events"]])
                db.commit()
                changed += 1

            paths = []
            if root.is_dir():
                def walk_error(error):
                    raise ValueError(f"Folder cannot be fully read: {error}")
                for directory, dirs, files in os.walk(root, onerror=walk_error, followlinks=False):
                    dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in ("__pycache__", "node_modules"))
                    paths.extend(Path(directory) / name for name in sorted(files)
                                 if Path(name).suffix.lower() in (".xml", ".zip") and not name.startswith("."))
            else:
                paths = [root]
            for path in paths:
                if path.is_symlink():
                    continue
                relative = str(path.relative_to(root)) if root.is_dir() else path.name
                if path.suffix.lower() == ".zip":
                    try:
                        with zipfile.ZipFile(path) as archive:
                            for number, info in enumerate(archive.infolist()):
                                if info.is_dir() or not info.filename.lower().endswith(".xml") or "__MACOSX/" in info.filename:
                                    continue
                                key, name = f"{relative}!{number}:{info.filename}", f"{relative} / {info.filename}"
                                try:
                                    if info.file_size > MAX_XML_BYTES:
                                        raise ValueError("XML member exceeds the 32 MiB per-snapshot limit")
                                    data = archive.read(info)  # CRC checked by zipfile; never extracted.
                                    save(key, name, data)
                                except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as exc:
                                    save(key, name, b"", f"Source could not be read: {exc}")
                    except (OSError, ValueError, zipfile.BadZipFile) as exc:
                        save(relative, relative, b"", f"ZIP could not be read: {exc}")
                else:
                    try:
                        if path.stat().st_size > MAX_XML_BYTES:
                            raise ValueError("XML exceeds the 32 MiB per-snapshot limit")
                        save(relative, relative, path.read_bytes())
                    except (OSError, ValueError) as exc:
                        save(relative, relative, b"", f"Source could not be read: {exc}")
            if not seen:
                raise ValueError("No XML snapshots were found. Subfolders and XML files inside ZIP archives are included.")
            old = rows(db, "SELECT id,source_key FROM snapshots WHERE dataset=?", (dataset,))
            removed = [row["id"] for row in old if row["source_key"] not in seen]
            db.executemany("DELETE FROM snapshots WHERE id=?", [(sid,) for sid in removed])
            db.execute("UPDATE snapshots SET duplicate_of=NULL WHERE dataset=?", (dataset,))
            # A repeated feed at a DIFFERENT capture time is a real observation.
            # Only identical content AND capture identity is a duplicate copy.
            canonical = {}
            for row in rows(db, "SELECT id,sha,capture,name FROM snapshots WHERE dataset=? AND status='valid' ORDER BY id", (dataset,)):
                key = (row["sha"], row["capture"] or row["name"].split(" / ")[-1])
                if key in canonical:
                    db.execute("UPDATE snapshots SET duplicate_of=? WHERE id=?", (canonical[key], row["id"]))
                else:
                    canonical[key] = row["id"]
            db.execute("UPDATE datasets SET updated=? WHERE id=?", (datetime.now().isoformat(timespec="seconds"), dataset))
            db.commit()
            progress.update(message="Collection ready", scanned=scanned, changed=changed, removed=len(removed))
        return {"dataset": dataset, "scanned": scanned, "changed": changed, "removed": len(removed)}

    def overview(self, dataset):
        with self.connect() as db:
            collection = db.execute("SELECT * FROM datasets WHERE id=?", (dataset,)).fetchone()
            if not collection:
                raise ValueError("Load a collection first")
            snaps = rows(db, "SELECT id,name,capture,status,error,warnings,size,sha,duplicate_of FROM snapshots WHERE dataset=? ORDER BY capture IS NULL,capture,name", (dataset,))
            for s in snaps:
                s["warnings"] = json.loads(s["warnings"])
                s["folder"] = snapshot_folder(s["name"])
            valid = [s for s in snaps if s["status"] == "valid" and s["duplicate_of"] is None]
            scope = "s.dataset=? AND s.duplicate_of IS NULL AND s.status='valid'"
            stats = db.execute(f"SELECT count(*) AS predictions,count(DISTINCT train_id) AS trains,count(DISTINCT platform) AS predicted_platforms FROM predictions p JOIN snapshots s ON s.id=p.snapshot WHERE {scope}", (dataset,)).fetchone()
            platforms = rows(db, f"SELECT p.platform,count(*) AS observations,sum(p.closed='true') AS closed,sum(p.held='true') AS held FROM platforms p JOIN snapshots s ON s.id=p.snapshot WHERE {scope} GROUP BY p.platform ORDER BY min(p.rowid)", (dataset,))
            trains = rows(db, f"SELECT p.train_id,count(*) AS predictions,count(DISTINCT p.snapshot) AS snapshots,min(s.capture) AS first_seen,max(s.capture) AS last_seen FROM predictions p JOIN snapshots s ON s.id=p.snapshot WHERE {scope} GROUP BY p.train_id ORDER BY length(p.train_id),p.train_id", (dataset,))
            event_counts = count_events(db, f"SELECT s.id FROM snapshots s WHERE {scope}", (dataset,))
        code_counts = {}
        for row in event_counts:
            code = row["code"]
            code_counts[code] = code_counts.get(code, 0) + row["count"]
        event_codes = [{"code": code, "count": count} for code, count in code_counts.items()]
        times = sorted(set(timestamp(s["capture"]) for s in valid if s["capture"]))
        intervals = [(b - a).total_seconds() for a, b in zip(times, times[1:])]
        median = statistics.median(intervals) if intervals else None
        threshold = max(60, (median or 20) * 3)
        gaps = [{"from": a.isoformat(), "to": b.isoformat(), "seconds": (b - a).total_seconds()} for a, b in zip(times, times[1:]) if (b-a).total_seconds() > threshold]
        identities = self.identities(dataset)
        for train in trains:
            self.label_row(train, identities)
        return {"collection": dict(collection), "identities": identities, "event_definitions": EVENT_CODES,
                "stats": {**dict(stats), "files": len(snaps), "valid": len(valid),
                "invalid": sum(s["status"] != "valid" for s in snaps), "duplicates": sum(s["duplicate_of"] is not None for s in snaps),
                "events": sum(code_counts.values()), "platforms": len(platforms), "median_interval": median, "gap_threshold": threshold,
                "first": times[0].isoformat() if times else None, "last": times[-1].isoformat() if times else None},
                "snapshots": snaps, "platforms": platforms, "trains": trains, "event_codes": event_codes, "event_counts": event_counts,
                "gaps": gaps, "station_names": STATIONS}

    def scoped_event_counts(self, dataset, *, folder=None, snapshot=None):
        """Count one file or count distinct snapshots within the chosen folder."""
        with self.connect() as db:
            readable = "dataset=? AND status='valid'"
            if snapshot is not None:
                return count_events(db, f"SELECT id FROM snapshots WHERE {readable} AND id=?", (dataset, snapshot))
            if folder is None:
                raise ValueError("Choose a folder or a file")
            db.create_function("snapshot_folder", 1, snapshot_folder, deterministic=True)
            return count_events(db, f"""SELECT min(id) AS id FROM snapshots
                WHERE {readable} AND snapshot_folder(name)=?
                GROUP BY coalesce(duplicate_of,id)""", (dataset, folder))

    def snapshot(self, dataset, sid, offset=240):
        with self.connect() as db:
            source = db.execute("SELECT id,name,capture,status,error,warnings,sha,size,duplicate_of FROM snapshots WHERE dataset=? AND id=?", (dataset, sid)).fetchone()
            if not source:
                raise ValueError("Snapshot not found in this collection")
            result = dict(source)
            result["warnings"] = json.loads(result["warnings"])
            result["platforms"] = rows(db, "SELECT * FROM platforms WHERE snapshot=? ORDER BY rowid", (sid,))
            result["predictions"] = rows(db, "SELECT * FROM predictions WHERE snapshot=? ORDER BY platform,arr,train_id", (sid,))
            result["events"] = rows(db, "SELECT * FROM events WHERE snapshot=? ORDER BY time,row_id", (sid,))
            received = rows(db, "SELECT e.*,s.capture AS received_capture,s.name AS source FROM events e JOIN snapshots s ON s.id=e.snapshot WHERE s.dataset=? AND s.duplicate_of IS NULL AND s.capture<=? ORDER BY s.capture,e.row_id", (dataset, result["capture"])) if result["capture"] else []
        capture = timestamp(result["capture"])
        reference = capture + timedelta(minutes=offset) if capture else None
        result["feed_reference"] = reference.isoformat() if reference else None
        identities = self.identities(dataset)
        for p in result["predictions"]:
            arrival, departure = timestamp(p["arr"]), timestamp(p["dep"])
            p["eta_seconds"] = self.seconds(arrival, reference)
            p["dwell_seconds"] = self.seconds(departure, arrival)
            p["raw"] = json.loads(p["raw"])
            self.label_row(p, identities)
        for e in result["events"]:
            e["vehicles"] = json.loads(e["vehicles"])
            e["raw"] = json.loads(e["raw"])
            self.label_row(e, identities)
        recent = {}
        for event in received:
            age = seconds(reference, timestamp(event["time"]))
            if age is None or age < 0:
                continue
            previous = recent.get(event["train_id"])
            if previous is None or timestamp(event["time"]) >= timestamp(previous["time"]):
                event = self.decode_row(event)
                recent[event["train_id"]] = self.label_row(event, identities)
        result["positions"] = estimate_positions(result["predictions"], recent, result["feed_reference"])
        for item in result["positions"]["trains"] + result["positions"]["unplaced"]:
            self.label_row(item, identities)
        return result

    @staticmethod
    def seconds(a, b):
        if a is None or b is None:
            return None
        try:
            return round((a-b).total_seconds(), 3)
        except TypeError:
            return None  # Mixed aware/naive clocks cannot be safely subtracted.

    def query_sql(self, dataset, kind="predictions", filters=None):
        filters = filters or {}
        if kind not in ("predictions", "events"):
            raise ValueError("Unknown table")
        where, args = ["s.dataset=?", "s.duplicate_of IS NULL"], [dataset]
        for key, column in (("train", "p.train_id"), ("platform", "p.platform"), ("snapshot", "p.snapshot")):
            if filters.get(key):
                where.append(f"{column}=?")
                args.append(filters[key])
        for key, operator in (("from", ">="), ("to", "<=")):
            if filters.get(key):
                value = timestamp(filters[key])
                if value is None:
                    raise ValueError("Capture filters must be valid date/time values")
                where.append(f"s.capture {operator} ?")
                args.append(value.isoformat())
        if filters.get("q"):
            matching = [tid for tid, info in self.identities(dataset).items() if info.get("label") and filters["q"].lower() in info["label"].lower()]
            identity_clause = f" OR p.train_id IN ({','.join('?' for _ in matching)})" if matching else ""
            where.append("(p.raw LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\' OR p.platform LIKE ? ESCAPE '\\'" + identity_clause + ")")
            escaped = filters["q"].replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            args.extend([f"%{escaped}%"] * 3)
            args.extend(matching)
        if filters.get("flag") and kind == "predictions":
            flag = filters["flag"]
            if flag == "nonstop": where.append("p.stop='false'")
            elif flag == "out": where.append("p.service='false'")
            elif flag == "missing": where.append("(p.arr IS NULL OR p.dep IS NULL OR p.destination IS NULL)")
        if kind == "events" and filters.get("code"):
            where.append("p.code=?")
            args.append(filters["code"])
        condition = " AND ".join(where)
        join = f"FROM {kind} p JOIN snapshots s ON p.snapshot=s.id WHERE {condition}"
        return join, args

    @staticmethod
    def decode_row(row):
        row = dict(row)
        row["raw"] = json.loads(row["raw"])
        if "vehicles" in row:
            row["vehicles"] = json.loads(row["vehicles"])
        return row

    def query(self, dataset, kind="predictions", filters=None, limit=100, offset=0):
        join, args = self.query_sql(dataset, kind, filters)
        with self.connect() as db:
            count = db.execute(f"SELECT count(*) {join}", args).fetchone()[0]
            result = rows(db, f"SELECT p.*,s.name AS source,s.capture {join} ORDER BY s.capture,p.row_id LIMIT ? OFFSET ?", [*args, limit, offset])
        identities = self.identities(dataset)
        return {"rows": [self.label_row(self.decode_row(row), identities) for row in result], "total": count, "limit": limit, "offset": offset}

    def export_rows(self, dataset, kind="predictions", filters=None):
        join, args = self.query_sql(dataset, kind, filters)
        identities = self.identities(dataset)
        with self.connect() as db:
            # One read transaction keeps the complete CSV consistent during rescans.
            cursor = db.execute(f"SELECT p.*,s.name AS source,s.capture {join} ORDER BY s.capture,p.row_id", args)
            while batch := cursor.fetchmany(1000):
                yield [self.label_row(self.decode_row(row), identities) for row in batch]

    def raw(self, dataset, sid):
        with self.connect() as db:
            row = db.execute("SELECT name,raw FROM snapshots WHERE dataset=? AND id=?", (dataset, sid)).fetchone()
            if not row:
                raise ValueError("Snapshot not found")
            return row["name"], row["raw"]

    def backup(self, destination):
        with self.connect() as source, closing(sqlite3.connect(destination)) as target:
            source.backup(target)
