"""
Tests for the campus geofence: attendance only from within the campus radius.
"""

import os
import sys
import tempfile
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import create_app
from backend.database.db import Database
from backend.chain.mock_chain import MockChainAdapter
from backend.ai.face_engine import MockFaceEngine
from backend.geofence import GeofenceConfig, haversine_m

ADMIN_TOKEN = "test-secret-token"
AUTH = {"X-Admin-Token": ADMIN_TOKEN}

CAMPUS_LAT, CAMPUS_LNG = 19.0458788, 72.8892847   # VESIT, Chembur
METERS_PER_DEG_LAT = 111_195.0


def point_north(meters: float, accuracy: float = 15.0) -> dict:
    """A location `meters` due north of the campus centre."""
    return {"latitude": CAMPUS_LAT + meters / METERS_PER_DEG_LAT, "longitude": CAMPUS_LNG, "accuracy": accuracy}


@pytest.fixture
def ctx():
    os.environ["ADMIN_TOKEN"] = ADMIN_TOKEN
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    geofence = GeofenceConfig(enabled=True, latitude=CAMPUS_LAT, longitude=CAMPUS_LNG,
                              radius_m=150, max_accuracy_m=100)
    app = create_app(chain_adapter=MockChainAdapter(), face_engine=MockFaceEngine(),
                     db=Database(db_path), geofence=geofence)
    app.config["TESTING"] = True
    with app.test_client() as client:
        assert client.post("/api/students", headers=AUTH,
                           json={"roll_no": "CS101", "name": "Alice", "frames": ["f"] * 6}).status_code == 201
        res = client.post("/api/sessions", headers=AUTH, json={"subject": "CS301", "duration_seconds": 600})
        yield client, res.get_json()["session"]["session_id"]
    try:
        os.remove(db_path)
    except OSError:
        pass


def mark(client, session_id, location):
    body = {"session_id": session_id, "frames": ["f"] * 10}
    if location is not None:
        body["location"] = location
    return client.post("/api/attendance/mark", json=body)


def test_haversine_matches_known_distance():
    # 0.001 degrees of latitude is ~111 m everywhere
    assert abs(haversine_m(CAMPUS_LAT, CAMPUS_LNG, CAMPUS_LAT + 0.001, CAMPUS_LNG) - 111.2) < 0.5


def test_inside_campus_is_accepted(ctx):
    client, sid = ctx
    res = mark(client, sid, point_north(40))
    assert res.status_code == 200
    assert res.get_json()["record"]["distance_m"] == pytest.approx(40, abs=1)


def test_just_inside_boundary_is_accepted(ctx):
    client, sid = ctx
    assert mark(client, sid, point_north(148)).status_code == 200


def test_just_outside_boundary_is_rejected(ctx):
    client, sid = ctx
    res = mark(client, sid, point_north(152))
    assert res.status_code == 403
    assert res.get_json()["verdict"] == "outside_campus"


def test_far_away_is_rejected_and_nothing_recorded(ctx):
    client, sid = ctx
    res = mark(client, sid, point_north(5000))
    assert res.status_code == 403
    data = res.get_json()
    assert data["verdict"] == "outside_campus"
    assert data["distance_m"] == pytest.approx(5000, rel=0.01)
    # Rejected attempt must not consume the session: marking from campus afterwards still works
    assert mark(client, sid, point_north(10)).status_code == 200


def test_missing_location_is_rejected(ctx):
    client, sid = ctx
    res = mark(client, sid, None)
    assert res.status_code == 400
    assert res.get_json()["verdict"] == "location_required"


@pytest.mark.parametrize("bad", [
    {"latitude": "abc", "longitude": 72.8, "accuracy": 10},
    {"latitude": 95, "longitude": 72.8, "accuracy": 10},
    {"longitude": 72.8, "accuracy": 10},
    "19.04,72.88",
])
def test_malformed_location_is_rejected(ctx, bad):
    client, sid = ctx
    res = mark(client, sid, bad)
    assert res.status_code == 400
    assert res.get_json()["verdict"] == "location_required"


def test_imprecise_location_is_rejected(ctx):
    client, sid = ctx
    res = mark(client, sid, point_north(20, accuracy=800))
    assert res.status_code == 422
    assert res.get_json()["verdict"] == "location_inaccurate"


def test_missing_accuracy_is_rejected(ctx):
    client, sid = ctx
    loc = point_north(20)
    del loc["accuracy"]
    assert mark(client, sid, loc).get_json()["verdict"] == "location_inaccurate"


def test_geofence_endpoint_reports_campus(ctx):
    client, _ = ctx
    gf = client.get("/api/campus/geofence").get_json()["geofence"]
    assert gf["enabled"] is True
    assert gf["latitude"] == CAMPUS_LAT and gf["longitude"] == CAMPUS_LNG
    assert gf["radius_m"] == 150


def test_config_reads_env(monkeypatch):
    monkeypatch.setenv("CAMPUS_LATITUDE", "12.5")
    monkeypatch.setenv("CAMPUS_LONGITUDE", "77.25")
    monkeypatch.setenv("CAMPUS_RADIUS_METERS", "200")
    monkeypatch.setenv("GEOFENCE_ENABLED", "false")
    cfg = GeofenceConfig.from_env()
    assert (cfg.latitude, cfg.longitude, cfg.radius_m, cfg.enabled) == (12.5, 77.25, 200.0, False)


def test_disabled_geofence_allows_any_location():
    cfg = GeofenceConfig(enabled=False)
    assert cfg.check(None)["ok"] is True
