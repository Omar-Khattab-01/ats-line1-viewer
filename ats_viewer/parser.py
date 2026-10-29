"""Read Thales PredictionEventAll exports without changing source data.

Clock values are intentionally stored as offset-free strings. An operator supplied
clock difference is applied only when comparing predictions to filename captures.
Event IDs, direction codes, vehicle IDs, speed and cars keep their source meaning.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import datetime

FIELDS = ("id", "arr", "dep", "next", "dest", "stop", "serv", "dir", "speed", "cars")
STATIONS = {
    "TUN": "Tunney’s Pasture", "BAY": "Bayview", "PIM": "Pimisi",
    "LYO": "Lyon", "PAR": "Parliament", "RID": "Rideau", "UOT": "uOttawa",
    "LEE": "Lees", "HUR": "Hurdman", "TRE": "Tremblay", "STL": "St-Laurent",
    "CYR": "Cyrville", "BLA": "Blair",
}


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def children(element, name):
    return [item for item in element if local_name(item.tag) == name]


def values(element):
    result = {}
    for child in element:
        name = local_name(child.tag)
        text = child.text.strip() if child.text else ""
        if name in result:
            if not isinstance(result[name], list):
                result[name] = [result[name]]
            result[name].append(text)
        else:
            result[name] = text
    return result


def timestamp(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def capture_time(filename):
    match = re.search(r"(?:^|[/\\])tp_(\d{14})(?:[^0-9]|$)", filename, re.I)
    if match:
        try:
            return datetime.strptime(match[1], "%Y%m%d%H%M%S").isoformat()
        except ValueError:
            pass
    return None


def parse(data: bytes):
    if not data.strip():
        return {"status": "empty", "error": "Empty XML file", "platforms": [], "predictions": [], "events": [], "warnings": []}
    # Do not resolve declarations or external entities in untrusted exports.
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("XML DTD/entity declarations are not supported")
    root = ET.fromstring(data)
    if local_name(root.tag) != "PredictionEventAll":
        raise ValueError(f"Unsupported XML root: {local_name(root.tag)}; expected PredictionEventAll")
    platforms, predictions, events, warnings = [], [], [], []
    for element in root.iter():
        name = local_name(element.tag)
        if name == "platform":
            fields = values(element)
            platform = fields.get("platformId", "")
            if not platform or not isinstance(platform, str):
                warnings.append("A platform record has no single platformId")
                continue
            platforms.append({"platform": platform, "closed": fields.get("closed"), "held": fields.get("held")})
            for train in children(element, "train"):
                fields = values(train)
                item = {key: fields.get(key) for key in FIELDS}
                item.update(platform=platform, raw=fields)
                predictions.append(item)
                for key in ("arr", "dep"):
                    if item[key] and timestamp(item[key]) is None:
                        warnings.append(f"Invalid {key} timestamp at {platform}, train {item['id']}: {item[key]}")
                if not item["id"]:
                    warnings.append(f"Prediction at {platform} has no train ID")
                if any(isinstance(item[key], list) for key in FIELDS):
                    raise ValueError(f"Repeated scalar prediction field at {platform}")
        elif name == "Event":
            fields = values(element)
            info = children(element, "eventinfo")
            detail = values(info[0]) if info else {}
            item = {key: detail.get(key) for key in FIELDS}
            item.update(time=fields.get("timeStamp"), code=fields.get("eventId"),
                        platform=fields.get("locationId"), vehicles=detail.get("thalesVehicleId", []), raw=detail)
            if isinstance(item["vehicles"], str):
                item["vehicles"] = [item["vehicles"]]
            events.append(item)
    if not platforms:
        warnings.append("No platform records found in this snapshot")
    return {"status": "valid", "error": None, "platforms": platforms, "predictions": predictions, "events": events, "warnings": warnings}
