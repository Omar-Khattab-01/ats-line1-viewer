"""Run with: python -m unittest discover -s tests -v"""
import csv
import hashlib
import io
import json
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest import mock
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from http.server import ThreadingHTTPServer

from ats_viewer.parser import capture_time, parse
from ats_viewer.store import Store, clean_path
from ats_viewer.web import App, excel_safe, handler_for


def fixture(train="17", arrival="2026-10-20T04:01:30.150", count=1):
    record = f"""<x:train><x:id>{train}</x:id><x:arr>{arrival}</x:arr><x:dep>2026-10-20T04:02:00.150</x:dep><x:next>BAY-E</x:next><x:dest>BLA-W</x:dest><x:stop>true</x:stop><x:serv>true</x:serv><x:dir>GD1</x:dir><x:speed>62</x:speed><x:cars>8</x:cars></x:train>"""
    return f"""<?xml version="1.0" encoding="UTF-8"?><PredictionEventAll xmlns:x="http://p2p.thalesgroup.com/wsdl/status/xsd"><x:PassengerPredictionAll><x:PredictionInfoList><x:platform><x:platformId>TUN-W</x:platformId><x:closed>false</x:closed><x:held>true</x:held>{record * count}</x:platform><x:platform><x:platformId>UNKNOWN-E</x:platformId><x:closed>false</x:closed><x:held>false</x:held></x:platform></x:PredictionInfoList></x:PassengerPredictionAll><eventAll><eventList><x:Event><x:timeStamp>2026-10-20T04:00:05.250</x:timeStamp><x:eventId>101</x:eventId><x:locationId>TUN-W</x:locationId><x:eventinfo><x:id>{train}</x:id><x:thalesVehicleId>39</x:thalesVehicleId><x:thalesVehicleId>27</x:thalesVehicleId></x:eventinfo></x:Event></eventList></eventAll></PredictionEventAll>""".encode()


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "input"
        self.source.mkdir()
        self.store = Store(self.root / "workspace.sqlite")

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name="tp_20261020000000.xml", data=None):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(fixture() if data is None else data)
        return path

    def load(self):
        return self.store.ingest(str(self.source))["dataset"]

    def test_preserves_raw_bytes_and_every_prediction_field(self):
        source = self.write()
        before = hashlib.sha256(source.read_bytes()).hexdigest()
        dataset = self.load()
        overview = self.store.overview(dataset)
        sid = overview["snapshots"][0]["id"]
        detail = self.store.snapshot(dataset, sid)
        row = detail["predictions"][0]
        self.assertEqual(row["raw"], parse(fixture())["predictions"][0]["raw"])
        self.assertEqual(self.store.raw(dataset, sid)[1], source.read_bytes())
        self.assertEqual(detail["events"][0]["vehicles"], ["39", "27"])
        self.assertEqual(row["eta_seconds"], 90.15)
        self.assertEqual(row["dwell_seconds"], 30)
        self.assertEqual(detail["platforms"][0]["held"], "true")
        self.assertEqual(before, hashlib.sha256(source.read_bytes()).hexdigest())

    def test_explicit_clock_alignment_and_missing_time(self):
        self.write()
        self.write("unrecognized.xml")
        dataset = self.load()
        snaps = self.store.overview(dataset)["snapshots"]
        self.assertEqual(self.store.snapshot(dataset, snaps[0]["id"], 0)["predictions"][0]["eta_seconds"], 14490.15)
        unknown = self.store.snapshot(dataset, snaps[1]["id"])
        self.assertIsNone(unknown["predictions"][0]["eta_seconds"])
        self.assertTrue(unknown["warnings"])

    def test_empty_invalid_and_missing_fields_are_visible(self):
        self.write(data=b"")
        self.write("tp_20261020000020.xml", b"<broken>")
        self.write("tp_20261020000040.xml", fixture().replace(b"<x:dep>2026-10-20T04:02:00.150</x:dep>", b""))
        dataset = self.load()
        overview = self.store.overview(dataset)
        self.assertEqual(overview["stats"]["files"], 3)
        self.assertEqual(overview["stats"]["invalid"], 2)
        self.assertEqual(overview["stats"]["valid"], 1)
        self.assertEqual(self.store.query(dataset, filters={"flag": "missing"})["total"], 1)

    def test_zip_and_folder_duplicates_but_later_capture_counts(self):
        self.write()
        self.write("nested/tp_20261020000020.xml")
        archive = self.source / "capture.zip"
        with zipfile.ZipFile(archive, "w") as z:
            z.writestr("20261020/tp_20261020000000.xml", fixture())
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        dataset = self.load()
        stats = self.store.overview(dataset)["stats"]
        self.assertEqual((stats["files"], stats["duplicates"], stats["valid"], stats["predictions"]), (3, 1, 2, 2))
        self.assertEqual(self.store.query(dataset)["total"], 2)
        self.assertEqual(digest, hashlib.sha256(archive.read_bytes()).hexdigest())

    def test_incremental_refresh_updates_removes_and_recovers(self):
        first = self.write()
        self.write("tp_20261020000020.xml", b"")
        dataset = self.load()
        self.assertEqual(self.store.ingest(self.source)["changed"], 0)
        first.unlink()
        self.write("tp_20261020000020.xml", fixture("58"))
        result = self.store.ingest(self.source)
        self.assertEqual((result["changed"], result["removed"]), (1, 1))
        self.assertEqual(self.store.query(dataset)["rows"][0]["train_id"], "58")
        self.assertEqual(self.store.overview(dataset)["stats"]["invalid"], 0)

    def test_rescan_recanonicalizes_duplicate_after_original_removed(self):
        first = self.write()
        self.write("copy/tp_20261020000000.xml")
        dataset = self.load()
        first.unlink()
        self.store.ingest(self.source)
        self.assertEqual(self.store.query(dataset)["total"], 1)
        self.assertEqual(self.store.overview(dataset)["stats"]["duplicates"], 0)

    def test_filters_pagination_and_literal_search(self):
        self.write(data=fixture(count=1100))
        dataset = self.load()
        page = self.store.query(dataset, limit=100, offset=1000)
        self.assertEqual((page["total"], len(page["rows"])), (1100, 100))
        self.assertEqual(self.store.query(dataset, filters={"train": "' OR 1=1 --"})["total"], 0)
        self.assertEqual(self.store.query(dataset, filters={"q": "%"})["total"], 0)
        self.assertEqual(self.store.query(dataset, filters={"from": "2026-10-20T00:00", "to": "2026-10-20T00:00"})["total"], 1100)

    def test_gap_detection_and_unknown_platform_preserved(self):
        self.write()
        self.write("tp_20261020000020.xml")
        self.write("tp_20261020000040.xml")
        self.write("tp_20261020000500.xml")
        overview = self.store.overview(self.load())
        self.assertEqual(overview["stats"]["median_interval"], 20)
        self.assertEqual(overview["gaps"][0]["seconds"], 260)
        self.assertIn("UNKNOWN-E", [p["platform"] for p in overview["platforms"]])

    def test_database_backup_contains_raw_and_can_reopen(self):
        self.write()
        dataset = self.load()
        dest = self.root / "download.sqlite"
        self.store.backup(dest)
        restored = Store(dest)
        self.assertEqual(restored.overview(dataset)["stats"]["predictions"], 1)
        self.assertEqual(restored.raw(dataset, restored.overview(dataset)["snapshots"][0]["id"])[1], fixture())
        with sqlite3.connect(dest) as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_multiple_collections_are_isolated(self):
        self.write()
        first = self.load()
        other = self.root / "other"
        other.mkdir()
        (other / "tp_20261020000000.xml").write_bytes(fixture("58"))
        second = self.store.ingest(other)["dataset"]
        self.assertNotEqual(first, second)
        self.assertEqual(self.store.query(first)["rows"][0]["train_id"], "17")
        self.assertEqual(self.store.query(second)["rows"][0]["train_id"], "58")

    def test_namespace_independence_and_unsafe_xml(self):
        changed_prefix = fixture().replace(b"xmlns:x=", b"xmlns:z=").replace(b"<x:", b"<z:").replace(b"</x:", b"</z:")
        self.assertEqual(parse(changed_prefix)["predictions"][0]["id"], "17")
        with self.assertRaises(ValueError):
            parse(b'<!DOCTYPE x [<!ENTITY y "test">]><PredictionEventAll/>')
        self.assertIsNone(capture_time("tp_20261399999999.xml"))
        self.assertEqual(clean_path(f'“{self.source}”'), self.source.resolve())
        self.assertEqual(excel_safe("=1+2"), "'=1+2")

    def test_consists_show_in_queries_search_and_exports(self):
        self.write(data=fixture("6").replace(b"<x:thalesVehicleId>39", b"<x:thalesVehicleId>40").replace(b"<x:thalesVehicleId>27", b"<x:thalesVehicleId>6"))
        dataset = self.load()
        overview = self.store.overview(dataset)
        self.assertEqual(overview["trains"][0]["consist"], "06-40")
        self.assertEqual(self.store.query(dataset, filters={"q": "06-40"})["total"], 1)
        self.assertEqual(next(self.store.export_rows(dataset))[0]["consist"], "06-40")

    def test_recoupled_groups_do_not_get_a_single_invented_pair(self):
        self.write(data=fixture("6"))
        self.write("tp_20261020000100.xml", fixture("6").replace(b"<x:thalesVehicleId>39", b"<x:thalesVehicleId>40"))
        dataset = self.load()
        self.assertIsNone(self.store.identities(dataset)["6"]["label"])
        self.assertEqual(self.store.query(dataset)["rows"][0]["consist"], "")
        self.assertTrue(self.store.query(dataset, "events")["rows"][0]["consist"])

    def test_map_event_anchor_cannot_use_later_received_events(self):
        # The second capture contains an old event with a useful departure time.
        # That event must not influence playback of the first capture.
        first = fixture("6", "2026-10-20T04:01:00").replace(b"TUN-W", b"BAY-E").replace(b"<x:next>BAY-E", b"<x:next>PIM-E")
        first = first[:first.index(b"<eventAll>")]+b"</PredictionEventAll>"
        self.write(data=first)
        later = fixture("6").replace(b"2026-10-20T04:00:05.250", b"2026-10-20T03:59:30").replace(b"TUN-W", b"TUN-E")
        later = later.replace(b"<x:eventinfo><x:id>6</x:id>", b"<x:eventinfo><x:id>6</x:id><x:dep>2026-10-20T03:59:00</x:dep>")
        self.write("tp_20261020000200.xml", later)
        dataset = self.load()
        sid = self.store.overview(dataset)["snapshots"][0]["id"]
        self.assertEqual(self.store.snapshot(dataset, sid)["positions"]["trains"][0]["method"], "approach_segment")


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        (cls.root / "tp_20261020000000.xml").write_bytes(fixture(count=1101))
        cls.store = Store(cls.root / "cache" / "workspace.sqlite")
        cls.dataset = cls.store.ingest(cls.root)["dataset"]
        cls.app = App(cls.store)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(cls.app))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, path, authorized=True, body=None, headers=None):
        h = {"X-ATS-Token": self.app.token} if authorized else {}
        h.update(headers or {})
        data = json.dumps(body).encode() if body is not None else None
        return urllib.request.urlopen(urllib.request.Request(self.url+path, data=data, headers=h), timeout=10)

    def test_page_api_snapshot_and_raw_source(self):
        page = self.request("/").read().decode()
        self.assertIn(self.app.token, page)
        self.assertNotIn("__TOKEN__", page)
        overview = json.load(self.request(f"/api/overview?dataset={self.dataset}"))
        sid = overview["snapshots"][0]["id"]
        detail = json.load(self.request(f"/api/snapshot?dataset={self.dataset}&id={sid}&clock=240"))
        self.assertEqual(len(detail["predictions"]), 1101)
        self.assertEqual(self.request(f"/api/raw?dataset={self.dataset}&id={sid}").read(), fixture(count=1101))

    def test_windows_default_encoding_does_not_corrupt_page(self):
        def windows_read_text(path, encoding=None, errors=None):
            return path.read_bytes().decode(encoding or "cp1252", errors or "strict")
        with mock.patch.object(Path, "read_text", windows_read_text):
            response = self.request("/")
            page = response.read().decode("utf-8")
        self.assertIn("Line 1 · ATS explorer", page)
        self.assertNotIn("â€", page)
        for path in ("/app.js", "/app.css"):
            response = self.request(path)
            self.assertIn("charset=utf-8", response.headers["Content-Type"])

    def test_session_token_host_and_origin_guards(self):
        for path, authorized, body, headers in [
            ("/api/session", False, None, {}),
            ("/api/session", True, None, {"Host": "attacker.example"}),
            ("/api/load", True, {"path": str(self.root)}, {"Origin": "https://attacker.example"}),
        ]:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.request(path, authorized, body, headers)
            self.assertEqual(caught.exception.code, 403)

    def test_csv_stream_exports_all_rows_across_pages(self):
        data = self.request(f"/api/export?dataset={self.dataset}&kind=predictions&train=17").read().decode("utf-8-sig")
        records = list(csv.DictReader(io.StringIO(data)))
        self.assertEqual(len(records), 1101)
        self.assertEqual(records[-1]["arr"], "2026-10-20T04:01:30.150")
        self.assertEqual(json.loads(records[0]["raw"])["id"], "17")

    def test_confirmed_event_definitions_reach_api_and_csv(self):
        result = json.load(self.request(f"/api/rows?dataset={self.dataset}&kind=events&code=101"))
        self.assertEqual(result["rows"][0]["event_label"], "Arriving")
        self.assertEqual(result["rows"][0]["event_label_status"], "confirmed")
        data = self.request(f"/api/export?dataset={self.dataset}&kind=events&code=101").read().decode("utf-8-sig")
        event = next(csv.DictReader(io.StringIO(data)))
        self.assertEqual(event["code"], "101")
        self.assertEqual(event["event_label"], "Arriving")
        self.assertEqual(event["event_label_status"], "confirmed")
        self.assertEqual(json.loads(event["raw"])["code"], "101")

    def test_background_import_reports_failure_and_recovers(self):
        self.request("/api/load", body={"path": str(self.root / "missing")}).close()
        for _ in range(100):
            job = json.load(self.request("/api/job"))
            if job["status"] != "running": break
            time.sleep(.01)
        self.assertEqual(job["status"], "failed")
        self.assertIn("does not exist", job["error"])
        self.assertEqual(json.load(self.request(f"/api/overview?dataset={self.dataset}"))["stats"]["predictions"], 1101)


if __name__ == "__main__":
    unittest.main()
