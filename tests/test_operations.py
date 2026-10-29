import unittest

from ats_viewer.operations import EVENT_CODES, consist_label, estimate_positions


def prediction(platform, arrival, departure=None, next_platform=None, tid="6"):
    return {"train_id": tid, "platform": platform, "arr": arrival, "dep": departure,
            "next_platform": next_platform, "stop": "true", "row_id": 1}


class OperationsTests(unittest.TestCase):
    def test_coupled_label_padding_and_stable_order(self):
        self.assertEqual(consist_label(["6", "40"], "6"), "06-40")
        self.assertEqual(consist_label(["40", "6"], "6"), "06-40")
        self.assertEqual(consist_label(["063", "58", "63"], "58"), "58-63")
        self.assertEqual(consist_label([], "6"), "")

    def test_confirmed_event_dictionary(self):
        self.assertEqual({k: v["label"] for k, v in EVENT_CODES.items()}, {
            "100": "Arrived", "101": "Arriving", "102": "Departing", "103": "Departed"})
        self.assertEqual(EVENT_CODES["100"]["description"], "Train Arrival")
        self.assertEqual(EVENT_CODES["101"]["description"], "Train Approach")
        self.assertTrue(all(v["status"] == "confirmed" for v in EVENT_CODES.values()))

    def test_dwell_and_confirmed_track_mapping(self):
        data = estimate_positions([prediction("LEE-W", "2026-10-20T03:59:30", "2026-10-20T04:00:30")], {}, "2026-10-20T04:00:00")
        self.assertEqual(data["trains"][0]["track"], 1)
        self.assertEqual(data["trains"][0]["position"], 7)
        self.assertEqual(data["trains"][0]["method"], "predicted_dwell")

    def test_interpolation_needs_time_bracket_on_same_track(self):
        predictions = [prediction("TUN-E", "2026-10-20T03:58:00", "2026-10-20T03:59:00", "BAY-E"),
                       prediction("BAY-E", "2026-10-20T04:01:00", "2026-10-20T04:01:30", "PIM-E")]
        result = estimate_positions(predictions, {}, "2026-10-20T04:00:00")["trains"][0]
        self.assertEqual(result["track"], 2)
        self.assertEqual(result["position"], .5)
        self.assertEqual(result["method"], "time_interpolation")
        predictions[0]["platform"] = "TUN-W"
        result = estimate_positions(predictions, {}, "2026-10-20T04:00:00")["trains"][0]
        self.assertEqual(result["method"], "approach_segment")

    def test_approach_marks_whole_segment_instead_of_precise_distance(self):
        result = estimate_positions([prediction("STL-E", "2026-10-20T04:01:00", None, "CYR-E")], {}, "2026-10-20T04:00:00")["trains"][0]
        self.assertEqual(result["method"], "approach_segment")
        self.assertEqual(result["segment"], [9, 10])
        self.assertIn("distance unknown", result["status"])

    def test_terminal_path_is_not_invented(self):
        result = estimate_positions([prediction("TUN-W", "2026-10-20T04:01:00", None, "BAY-E")], {}, "2026-10-20T04:00:00")["trains"][0]
        self.assertEqual(result["method"], "prediction_proximity")
        self.assertIn("uncertain", result["status"])
        self.assertNotIn("segment", result)

    def test_missing_unknown_or_distant_evidence_stays_unplaced(self):
        for predictions, reference in [
            ([prediction("XXX-E", "2026-10-20T04:01:00")], "2026-10-20T04:00:00"),
            ([prediction("STL-E", "2026-10-20T04:30:00")], "2026-10-20T04:00:00"),
            ([prediction("STL-E", "2026-10-20T04:01:00")], None),
        ]:
            result = estimate_positions(predictions, {}, reference)
            self.assertEqual(result["trains"], [])
            self.assertEqual(len(result["unplaced"]), 1)

    def test_empty_snapshot_never_reuses_old_train_markers(self):
        result = estimate_positions([], {"6": {"time": "2026-10-20T03:59:00", "platform": "LEE-E"}}, "2026-10-20T04:00:00")
        self.assertEqual(result["trains"], [])

    def test_future_or_stale_event_is_not_a_position_anchor(self):
        predictions = [prediction("BAY-E", "2026-10-20T04:01:00", None, "PIM-E")]
        for event_time in ["2026-10-20T04:00:10", "2026-10-20T03:40:00"]:
            recent = {"6": {"time": event_time, "platform": "TUN-E", "raw": {"dep": "2026-10-20T03:59:00"}}}
            result = estimate_positions(predictions, recent, "2026-10-20T04:00:00")["trains"][0]
            self.assertEqual(result["method"], "approach_segment")

    def test_conflicting_dwell_predictions_remain_unplaced(self):
        predictions = [prediction("LEE-E", "2026-10-20T03:59:30", "2026-10-20T04:00:30"),
                       prediction("HUR-E", "2026-10-20T03:59:30", "2026-10-20T04:00:30")]
        result = estimate_positions(predictions, {}, "2026-10-20T04:00:00")
        self.assertEqual(result["trains"], [])
        self.assertIn("Overlapping", result["unplaced"][0]["reason"])
