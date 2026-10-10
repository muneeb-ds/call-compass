"""Placeholder smoke tests proving the app imports and serves."""

from fastapi.testclient import TestClient

from callcompass.main import app


def test_app_importable() -> None:
    assert app.title == "CallCompass"


def test_ping() -> None:
    client = TestClient(app)
    response = client.get("/api/ping")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
