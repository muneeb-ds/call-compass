"""The browser's playback control, checked from the backend.

Playback exists so the operator can hear what the model actually heard after a misfire
(PRD risk R-1). That is only true if it plays the *uploaded* bytes, so the assertion
that matters is a byte comparison between what the audio element was handed and what
`/api/analyze` is sent — plus that those bytes still decode as valid 16 kHz mono.

Same harness as the encoder and timer tests: node runs the shipped `playback.js` with
three stub DOM elements (`playback_fixture.mjs`).
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

from callcompass.audio import SAMPLE_RATE, decode_wav
from callcompass.main import create_app

from .fakes import fake_engine

HARNESS = Path(__file__).resolve().parent / "playback_fixture.mjs"

requires_node = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is needed to run the frontend playback control"
)


def run_harness(*args: str) -> dict[str, Any]:
    result = subprocess.run(
        ["node", str(HARNESS), *args], capture_output=True, check=True, text=True
    )
    parsed: dict[str, Any] = json.loads(result.stdout)
    return parsed


@pytest.fixture(scope="module")
def run() -> dict[str, Any]:
    if shutil.which("node") is None:
        pytest.skip("node is needed to run the frontend playback control")
    return run_harness()


def state(run: dict[str, Any], note: str) -> dict[str, Any]:
    (found,) = [s for s in run["states"] if s["note"] == note]
    assert isinstance(found, dict)
    return found


@requires_node
def test_playback_serves_the_same_bytes_as_the_upload(run: dict[str, Any]) -> None:
    """The whole point: not a second MediaRecorder blob, the identical WAV."""
    assert run["playedBase64"] == run["uploadedBase64"]
    assert run["blobType"] == "audio/wav"


@requires_node
def test_played_bytes_are_valid_audio_for_the_backend(run: dict[str, Any]) -> None:
    decoded = decode_wav(base64.b64decode(run["playedBase64"]))

    assert decoded.sample_rate == SAMPLE_RATE
    assert decoded.duration_ms == run["durationMs"]


@requires_node
def test_played_bytes_are_accepted_by_analyze(run: dict[str, Any]) -> None:
    upload = ("utterance.wav", base64.b64decode(run["playedBase64"]), "audio/wav")
    with TestClient(create_app(model_loader=fake_engine)) as client:
        response = client.post("/api/analyze", files={"audio": upload})

    assert response.status_code == 200, response.text


@requires_node
def test_control_starts_disabled_with_a_zeroed_readout(run: dict[str, Any]) -> None:
    """Disabled and grayed, never hidden — the affordance has to stay on screen."""
    initial = state(run, "initial")

    assert initial["disabled"] is True
    assert initial["label"] == "Play"
    assert initial["readout"] == "0:00 / 0:00"
    assert initial["hasSource"] is False


@requires_node
def test_pressing_play_before_a_recording_exists_does_nothing(run: dict[str, Any]) -> None:
    assert state(run, "toggled while empty") == state(run, "initial") | {
        "note": "toggled while empty"
    }


@requires_node
def test_loading_a_recording_enables_the_control(run: dict[str, Any]) -> None:
    loaded = state(run, "loaded")

    assert loaded["disabled"] is False
    assert loaded["label"] == "Play"
    assert loaded["hasSource"] is True
    assert loaded["readout"] == "0:00 / 0:01"


@requires_node
def test_toggle_runs_play_pause_and_reports_elapsed(run: dict[str, Any]) -> None:
    playing = state(run, "playing")
    assert playing["label"] == "Pause"
    assert playing["pressed"] == "true"
    assert playing["playing"] == "true"

    # 0:00 at 400 ms is correct for an m:ss readout; the state is what's being checked.
    assert state(run, "mid-playback")["label"] == "Pause"

    paused = state(run, "paused")
    assert paused["label"] == "Play"
    assert paused["pressed"] == "false"


@requires_node
def test_finishing_playback_returns_the_control_to_play(run: dict[str, Any]) -> None:
    """So a second press replays instead of appearing dead at the end of the file."""
    ended = state(run, "ended")

    assert ended["label"] == "Play"
    assert ended["readout"] == "0:00 / 0:01"
    assert ended["disabled"] is False


@requires_node
def test_clear_disables_the_control_and_releases_the_audio(run: dict[str, Any]) -> None:
    cleared = run["cleared"]

    assert cleared["disabled"] is True
    assert cleared["label"] == "Play"
    assert cleared["readout"] == "0:00 / 0:00"
    assert cleared["hasSource"] is False
    assert run["liveUrlsAfterClear"] == 0


@requires_node
def test_reloading_revokes_the_previous_object_url(run: dict[str, Any]) -> None:
    """Re-recording all demo long must not leak a blob per take."""
    assert run["staleUrlRevoked"] is True


def test_frontend_ships_the_playback_module() -> None:
    """app.js imports it at runtime, so it has to be a served file."""
    frontend = Path(__file__).resolve().parents[2] / "frontend"

    assert (frontend / "playback.js").is_file()
    assert 'id="play-button"' in (frontend / "index.html").read_text()
