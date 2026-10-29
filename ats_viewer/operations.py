"""Display identities and conservative, explicitly estimated track positions.

Track 1 is West (W platforms); Track 2 is East (E platforms).
Positions use only the selected snapshot and events already received by then.
Event codes identify arrival, approach, departure preparation, and departure.
"""
from __future__ import annotations

from .parser import STATIONS, timestamp

EVENT_CODES = {
    "100": {"label": "Arrived", "description": "Train Arrival", "status": "confirmed"},
    "101": {"label": "Arriving", "description": "Train Approach", "status": "confirmed"},
    "102": {"label": "Departing", "description": "Train Departing", "status": "confirmed"},
    "103": {"label": "Departed", "description": "Train Departed", "status": "confirmed"},
}
STATION_CODES = list(STATIONS)
TRACKS = {"W": 1, "E": 2}


def consist_label(vehicles, train_id=None):
    """Keep the ATS group ID first when present; retain original vehicle order in raw."""
    if isinstance(vehicles, str):
        vehicles = [vehicles]
    values = list(dict.fromkeys(str(v).strip() for v in vehicles if str(v).strip()))
    normalized = lambda v: str(int(v)) if v.isdigit() else v
    values = list(dict.fromkeys(normalized(v) for v in values))
    key = lambda v: (0, int(v)) if v.isdigit() else (1, v)
    values.sort(key=key)
    lead = normalized(str(train_id)) if train_id is not None else None
    if lead in values:
        values.remove(lead)
        values.insert(0, lead)
    return "-".join(v.zfill(2) if v.isdigit() else v for v in values)


def seconds(a, b):
    if a is None or b is None:
        return None
    try:
        return (a-b).total_seconds()
    except TypeError:
        return None


def platform_location(platform):
    if not isinstance(platform, str) or "-" not in platform:
        return None
    code, suffix = platform.split("-", 1)
    if code not in STATIONS or suffix not in TRACKS:
        return None
    return STATION_CODES.index(code), TRACKS[suffix]


def _name(platform):
    return STATIONS.get(str(platform).split("-")[0], str(platform))


def estimate_positions(predictions, recent_events, reference):
    """Return one marker per prediction group; never use future-received events.

    A point between stations requires a departure/arrival time bracket. Without
    that bracket an approach is a whole segment, not a guessed distance. At
    terminals a marker means proximity only; a crossover path is not invented.
    """
    now = timestamp(reference)
    groups = {}
    for p in predictions:
        groups.setdefault(p["train_id"], []).append(p)
    placed, unplaced = [], []
    for train_id, items in groups.items():
        base = {"train_id": train_id, "estimated": True}
        mapped = [p for p in items if platform_location(p["platform"])]
        if now is None or not mapped:
            unplaced.append({**base, "reason": "Capture clock unavailable" if now is None else "No core Line 1 platform prediction"})
            continue
        usable = []
        for p in mapped:
            arr, dep = timestamp(p.get("arr")), timestamp(p.get("dep"))
            to_arr, to_dep = seconds(arr, now), seconds(dep, now)
            if to_arr is not None:
                usable.append((p, to_arr, to_dep))
        if not usable:
            unplaced.append({**base, "reason": "Arrival timestamps cannot be aligned to the capture clock"})
            continue

        def marker(p, method, status, **extra):
            index, track = platform_location(p["platform"])
            return {**base, "position": index, "track": track, "platform": p["platform"],
                    "method": method, "status": status, "prediction_row": p.get("row_id"), **extra}

        dwell = [(p, a, d) for p, a, d in usable if a <= 0 and d is not None and d >= 0
                 and p.get("stop") != "false" and d-a <= 1200]
        if len({p["platform"] for p, _, _ in dwell}) == 1:
            p, _, _ = max(dwell, key=lambda item: item[1])
            placed.append(marker(p, "predicted_dwell", f"At / near {_name(p['platform'])} (predicted dwell)"))
            continue
        if len({p["platform"] for p, _, _ in dwell}) > 1:
            unplaced.append({**base, "reason": "Overlapping dwell predictions at different platforms"})
            continue

        future = sorted(((p, a, d) for p, a, d in usable if a > 0), key=lambda item: item[1])
        if not future:
            unplaced.append({**base, "reason": "No current dwell or future arrival in this snapshot"})
            continue
        target, until_arrival, _ = future[0]
        target_location = platform_location(target["platform"])
        # A bracket may come from current predictions or an already-received event.
        anchors = [p for p, a, d in usable if d is not None and d <= 0]
        event = recent_events.get(train_id)
        if event:
            age = seconds(now, timestamp(event.get("time")))
            detail = event.get("raw", {})
            if age is not None and 0 <= age <= 600 and platform_location(event.get("platform")):
                anchors.append({"platform": event["platform"], "dep": detail.get("dep"), "event": event})
        candidates = []
        for anchor in anchors:
            loc = platform_location(anchor.get("platform"))
            elapsed = seconds(now, timestamp(anchor.get("dep")))
            if loc and loc[1] == target_location[1] and abs(loc[0]-target_location[0]) == 1 and elapsed is not None and elapsed >= 0:
                duration = elapsed + until_arrival
                if 0 < duration <= 600:
                    candidates.append((elapsed, anchor, loc, elapsed/duration))
        if candidates:
            elapsed, anchor, loc, fraction = min(candidates, key=lambda item: item[0])
            start, end = loc[0], target_location[0]
            placed.append(marker(target, "time_interpolation", f"Between {_name(anchor['platform'])} and {_name(target['platform'])} (time estimate)",
                                 position=start+(end-start)*fraction, segment=[start, end],
                                 anchor_event=anchor.get("event"), fraction=round(fraction, 4)))
            continue

        # Restrict a prediction-only approach to a plausible near-term window.
        # No speed unit, GD direction mapping, or proportional distance is assumed.
        if until_arrival <= 300:
            next_loc = platform_location(target.get("next_platform"))
            i, track = target_location
            if next_loc and abs(next_loc[0]-i) == 1:
                previous = i-(next_loc[0]-i)
                if 0 <= previous < len(STATION_CODES):
                    placed.append(marker(target, "approach_segment", f"Approaching {_name(target['platform'])} (segment estimate; distance unknown)",
                                         segment=[previous, i], position=(previous+i)/2))
                    continue
            placed.append(marker(target, "prediction_proximity", f"Near {_name(target['platform'])} (prediction; approach track/path uncertain)"))
            continue
        unplaced.append({**base, "reason": "Next prediction is over five minutes away; insufficient location evidence"})
    return {"trains": placed, "unplaced": unplaced, "tracks": {"1": "W", "2": "E"},
            "notice": "Estimated from prediction timing and already-received events. Schematic distances are not geographic. No GPS or track-circuit positions are supplied."}
