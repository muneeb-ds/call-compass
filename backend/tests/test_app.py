"""App startup, lifespan wiring, and the /api/health endpoint."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from callcompass.main import app, create_app, default_frontend_dir
from callcompass.model import InferenceEngine, ModelLoadError, load_engine
from callcompass.tree import TreeConfigError, default_config_path

from .fakes import FakeModel, fake_engine


def test_app_importable() -> None:
    assert app.title == "CallCompass"


def test_health_reports_model_and_tree() -> None:
    engine = fake_engine(load_ms=412.4)
    with TestClient(create_app(model_loader=lambda: engine)) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "model_loaded": True,
        "model_load_ms": 412,
        "tree_id": "northbeam-saas-v2",
        "node_count": 26,
    }


def test_model_is_loaded_once_not_per_request() -> None:
    loads = 0

    def loader() -> InferenceEngine:
        nonlocal loads
        loads += 1
        return fake_engine()

    with TestClient(create_app(model_loader=loader)) as client:
        for _ in range(3):
            assert client.get("/api/health").status_code == 200

    assert loads == 1


def test_engine_and_tree_live_on_app_state() -> None:
    engine = fake_engine()
    application = create_app(model_loader=lambda: engine)
    with TestClient(application):
        assert application.state.engine is engine
        assert application.state.tree.tree_id == "northbeam-saas-v2"


def test_invalid_tree_fails_startup_with_single_line_error(tmp_path: Path) -> None:
    config = json.loads(default_config_path().read_text())
    config["nodes"]["intent"]["options"][0]["next"] = "no_such_node"
    bad = tmp_path / "tree.json"
    bad.write_text(json.dumps(config))

    application = create_app(model_loader=fake_engine, tree_path=bad)
    with pytest.raises(TreeConfigError) as excinfo:
        with TestClient(application):
            pass

    message = str(excinfo.value)
    assert "\n" not in message
    assert "no_such_node" in message


def test_model_load_failure_fails_startup() -> None:
    def loader() -> InferenceEngine:
        raise ModelLoadError("Could not load the NeuDecide model from somewhere: boom.")

    with pytest.raises(ModelLoadError, match="Could not load"):
        with TestClient(create_app(model_loader=loader)):
            pass


def test_warmup_runs_one_inference_on_silent_audio() -> None:
    model = FakeModel()
    engine = InferenceEngine(model, load_ms=1.0, providers=["CPUExecutionProvider"])

    warmup_ms = engine.warmup()

    assert warmup_ms >= 0
    assert len(model.calls) == 1
    audio, tools = model.calls[0]
    assert audio.shape == (8000,)  # 0.5 s at 16 kHz
    assert not audio.any()  # silence
    assert [tool["name"] for tool in tools] == ["none_of_these"]


def test_load_engine_reports_a_readable_single_line_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A bad CALLCOMPASS_MODEL_DIR exercises the real load path without a download."""
    monkeypatch.setenv("CALLCOMPASS_MODEL_DIR", str(tmp_path))

    with pytest.raises(ModelLoadError) as excinfo:
        load_engine()

    message = str(excinfo.value)
    assert "\n" not in message
    assert str(tmp_path) in message
    assert "CALLCOMPASS_MODEL_DIR" in message


def test_engine_exposes_sample_rate_and_providers() -> None:
    engine = fake_engine()
    assert engine.sample_rate == 16000
    assert engine.providers == ["CPUExecutionProvider"]


def test_root_serves_the_frontend_shell() -> None:
    with TestClient(create_app(model_loader=fake_engine)) as client:
        response = client.get("/")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    body = response.text
    # The status bar, the tree stage, and the capture/trace/result surfaces it floats
    # over, plus the no-build-step ES module entry.
    for marker in (
        "health-dot",
        "health-status",
        "tree-canvas",
        "record-button",
        "trace-list",
        "result-slot",
    ):
        assert marker in body
    assert 'type="module"' in body


def test_frontend_assets_are_served() -> None:
    with TestClient(create_app(model_loader=fake_engine)) as client:
        for path, content_type in (
            ("/styles.css", "text/css"),
            ("/app.js", "javascript"),
            ("/tree.js", "javascript"),
            ("/sse.js", "javascript"),
            ("/trace.js", "javascript"),
            ("/analysis.js", "javascript"),
            ("/result.js", "javascript"),
            ("/reset.js", "javascript"),
        ):
            response = client.get(path)
            assert response.status_code == 200, path
            assert content_type in response.headers["content-type"], path


def test_static_mount_does_not_shadow_the_api() -> None:
    """The mount sits at `/`, so guard the ordering that keeps `/api/*` reachable."""
    with TestClient(create_app(model_loader=fake_engine)) as client:
        assert client.get("/api/health").json()["status"] == "ok"
        assert client.get("/api/tree").json()["tree_id"] == "northbeam-saas-v2"


def test_frontend_dir_contains_the_shell() -> None:
    frontend = default_frontend_dir()
    assert (frontend / "index.html").is_file()
    assert (frontend / "styles.css").is_file()
    assert (frontend / "app.js").is_file()
