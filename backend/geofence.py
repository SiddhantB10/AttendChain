"""
Campus geofence for AttendChain.

Attendance can only be marked when the student's device reports a location inside a
circle around the campus. The check runs on the server, so a student cannot skip it by
editing the web page; the browser only supplies its GPS reading.

Configuration (.env):
    GEOFENCE_ENABLED              true / false               (default: true)
    CAMPUS_NAME                   label shown in the UI
    CAMPUS_LATITUDE               decimal degrees            (default: VESIT, Chembur)
    CAMPUS_LONGITUDE              decimal degrees
    CAMPUS_RADIUS_METERS          allowed distance           (default: 150)
    GEOFENCE_MAX_ACCURACY_METERS  reject fixes less precise than this (default: 100)
"""

import math
import os
from dataclasses import dataclass, asdict
from typing import Any, Dict, Optional

EARTH_RADIUS_M = 6371008.8

DEFAULT_CAMPUS_NAME = "VESIT Campus, Chembur"
DEFAULT_CAMPUS_LAT = 19.0458788
DEFAULT_CAMPUS_LNG = 72.8892847
DEFAULT_RADIUS_M = 150.0
DEFAULT_MAX_ACCURACY_M = 100.0


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in metres between two latitude/longitude points."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass
class GeofenceConfig:
    enabled: bool = True
    name: str = DEFAULT_CAMPUS_NAME
    latitude: float = DEFAULT_CAMPUS_LAT
    longitude: float = DEFAULT_CAMPUS_LNG
    radius_m: float = DEFAULT_RADIUS_M
    max_accuracy_m: float = DEFAULT_MAX_ACCURACY_M

    @classmethod
    def from_env(cls) -> "GeofenceConfig":
        enabled = os.getenv("GEOFENCE_ENABLED", "true").strip().lower() not in ("0", "false", "no", "off")
        return cls(
            enabled=enabled,
            name=os.getenv("CAMPUS_NAME", DEFAULT_CAMPUS_NAME).strip() or DEFAULT_CAMPUS_NAME,
            latitude=_env_float("CAMPUS_LATITUDE", DEFAULT_CAMPUS_LAT),
            longitude=_env_float("CAMPUS_LONGITUDE", DEFAULT_CAMPUS_LNG),
            radius_m=_env_float("CAMPUS_RADIUS_METERS", DEFAULT_RADIUS_M),
            max_accuracy_m=_env_float("GEOFENCE_MAX_ACCURACY_METERS", DEFAULT_MAX_ACCURACY_M),
        )

    def public_info(self) -> Dict[str, Any]:
        return asdict(self)

    def check(self, location: Optional[Any]) -> Dict[str, Any]:
        """
        Validates a client-reported location.

        Returns {"ok": True, "distance_m": ..., ...} when inside the campus circle, otherwise
        {"ok": False, "verdict": ..., "error": ..., "status": <http code>, ...}.
        """
        if not self.enabled:
            return {"ok": True, "enabled": False}

        if not isinstance(location, dict):
            return {
                "ok": False, "status": 400, "verdict": "location_required",
                "error": "Your location is required to mark attendance. Allow location access in your browser and try again.",
            }

        try:
            lat = float(location.get("latitude"))
            lng = float(location.get("longitude"))
        except (TypeError, ValueError):
            return {
                "ok": False, "status": 400, "verdict": "location_required",
                "error": "Location must include numeric latitude and longitude.",
            }

        if not (math.isfinite(lat) and math.isfinite(lng)) or not (-90 <= lat <= 90 and -180 <= lng <= 180):
            return {
                "ok": False, "status": 400, "verdict": "location_required",
                "error": "Location coordinates are out of range.",
            }

        accuracy = None
        raw_acc = location.get("accuracy")
        if raw_acc is not None:
            try:
                accuracy = float(raw_acc)
                if not math.isfinite(accuracy) or accuracy < 0:
                    accuracy = None
            except (TypeError, ValueError):
                accuracy = None

        distance = haversine_m(lat, lng, self.latitude, self.longitude)
        result = {
            "distance_m": round(distance, 1),
            "radius_m": self.radius_m,
            "accuracy_m": round(accuracy, 1) if accuracy is not None else None,
            "campus_name": self.name,
        }

        if accuracy is None:
            return {**result, "ok": False, "status": 400, "verdict": "location_inaccurate",
                    "error": "Your device did not report how precise its location is. Turn on GPS / precise location and try again."}

        if accuracy > self.max_accuracy_m:
            return {**result, "ok": False, "status": 422, "verdict": "location_inaccurate",
                    "error": (f"Your location is only accurate to about {round(accuracy)} m (needs {round(self.max_accuracy_m)} m or better). "
                              "Turn on GPS / precise location, move near a window or outdoors, and try again.")}

        if distance > self.radius_m:
            return {**result, "ok": False, "status": 403, "verdict": "outside_campus",
                    "error": (f"You are about {round(distance)} m from {self.name}. "
                              f"Attendance can only be marked within {round(self.radius_m)} m of campus.")}

        return {**result, "ok": True}
