"""The browser's recording clock and 30-second ceiling, checked from the backend.

`frontend/` has no JS test runner, so the pure parts of the timer are verified the
same way the encoder is (see `test_frontend_audio.py`): node runs the *shipped*
`timer.js` and `wav.js`, and the results are compared against the limit
`callcompass.audio` actually enforces.

The point is the ceiling. The UI's 30 s auto-stop and the backend's `MAX_SECONDS`
have to agree, or a recording the operator watched succeed comes back a 400.
"""

from __future__ import annotations

import base64
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from callcompass.audio import MAX_SECONDS, SAMPLE_RATE, decode_wav
from callcompass.main import create_app

from .fakes import fake_engine

HARNESS = Path(__file__).resolve().parent / "timing_fixture.mjs"

requires_node = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is needed to run the frontend timer"
)


def run_harness(*args: str) -> str:
    result = subprocess.run(
        ["node", str(HARNESS), *args], capture_output=True, check=True, text=True
    )
    return result.stdout


@pytest.fixture(scope="module")
def timing() -> dict[str, Any]:
    if shutil.which("node") is None:
        pytest.skip("node is needed to run the frontend timer")
    parsed: dict[str, Any] = json.loads(run_harness())
    return parsed


@requires_node
def test_ui_ceiling_matches_the_backend_limit(timing: dict[str, Any]) -> None:
    assert timing["maxSeconds"] == MAX_SECONDS
    assert timing["maxRecordingMs"] == MAX_SECONDS * 1000


@requires_node
def test_clock_formats_minutes_and_seconds(timing: dict[str, Any]) -> None:
    expected = {
        "0": "0:00",
        "1": "0:00",
        "999": "0:00",
        "1000": "0:01",
        "12000": "0:12",
        "59999": "0:59",
        "60000": "1:00",
        "90500": "1:30",
        "30000": "0:30",
    }

    assert timing["clock"] == expected


@requires_node
def test_readout_shows_elapsed_of_the_ceiling(timing: dict[str, Any]) -> None:
    """The PRD's example format, e.g. "0:12 / 0:30"."""
    assert timing["elapsed"]["12000"] == "0:12 / 0:30"
    assert timing["elapsed"]["0"] == "0:00 / 0:30"
    assert timing["elapsed"]["30000"] == "0:30 / 0:30"
    # A stop that lands a few hundred ms late must not display 0:30.4 worth of time.
    assert timing["overrun"] == "0:30 / 0:30"


@requires_node
@pytest.mark.parametrize("seconds", [1.0, MAX_SECONDS, MAX_SECONDS + 0.4, MAX_SECONDS + 5])
def test_auto_stopped_recording_is_never_too_long_for_the_backend(seconds: float) -> None:
    """Wall-clock auto-stop can overshoot; the clamp keeps the upload valid anyway."""
    decoded = decode_wav(base64.b64decode(run_harness(str(seconds))))

    assert decoded.duration_ms == min(round(seconds * 1000), MAX_SECONDS * 1000)
    assert decoded.sample_rate == SAMPLE_RATE


@requires_node
def test_overlong_recording_is_still_accepted_by_analyze() -> None:
    upload = ("utterance.wav", base64.b64decode(run_harness(str(MAX_SECONDS + 2))), "audio/wav")
    with TestClient(create_app(model_loader=fake_engine)) as client:
        response = client.post("/api/analyze", files={"audio": upload})

    assert response.status_code == 200, response.text


def test_frontend_ships_the_waveform_and_timer_modules() -> None:
    """Both are imported by app.js at runtime, so they have to be served files."""
    frontend = Path(__file__).resolve().parents[2] / "frontend"

    for name in ["waveform.js", "timer.js"]:
        assert (frontend / name).is_file()
