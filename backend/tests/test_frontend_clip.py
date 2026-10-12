"""The audio-file source's clip rules, checked from the backend.

`frontend/` has no JS test runner, so the pure clip logic is verified the same way the
timer is (see `test_frontend_timing.py`): node runs the *shipped* `clip.js`, and the
results are compared against the limits `callcompass.audio` actually enforces and fed
to the real decoder and to `POST /api/analyze`.

The point is that a file of any length can be clipped, but only to something the
backend accepts: never past 30 s, never under its minimum.
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

from callcompass.audio import MAX_SECONDS, MIN_SECONDS, SAMPLE_RATE, decode_wav
from callcompass.main import create_app

from .fakes import fake_engine

HARNESS = Path(__file__).resolve().parent / "clip_fixture.mjs"

requires_node = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is needed to run the frontend clip rules"
)


@pytest.fixture(scope="module")
def clip() -> dict[str, Any]:
    if shutil.which("node") is None:
        pytest.skip("node is needed to run the frontend clip rules")
    result = subprocess.run(
        ["node", str(HARNESS)], capture_output=True, check=True, text=True
    )
    parsed: dict[str, Any] = json.loads(result.stdout)
    return parsed


def wav(clip: dict[str, Any], name: str) -> bytes:
    return base64.b64decode(clip["wavs"][name])


@requires_node
def test_clip_limits_match_the_backend(clip: dict[str, Any]) -> None:
    limits = clip["limits"]
    assert limits["maxSeconds"] == MAX_SECONDS
    assert limits["minSeconds"] == MIN_SECONDS
    assert limits["maxClipMs"] == MAX_SECONDS * 1000
    assert limits["minClipMs"] == MIN_SECONDS * 1000


@requires_node
def test_a_new_file_starts_with_as_much_as_allowed(clip: dict[str, Any]) -> None:
    rules = clip["rules"]
    assert rules["defaultLong"] == {"startMs": 0, "endMs": 30_000}
    assert rules["defaultShort"] == {"startMs": 0, "endMs": 12_000}
    assert rules["canClip"] == {"tooShort": False, "justEnough": True}


@requires_node
def test_the_end_can_shrink_the_clip_but_never_grow_it_past_30s(clip: dict[str, Any]) -> None:
    rules = clip["rules"]
    assert rules["endPastCeiling"] == {"startMs": 0, "endMs": 30_000}
    assert rules["endPastFile"] == {"startMs": 60_000, "endMs": 75_000}
    assert rules["endShrunk"] == {"startMs": 10_000, "endMs": 25_000}
    assert rules["endUnderMinimum"] == {"startMs": 10_000, "endMs": 10_300}


@requires_node
def test_the_start_can_shrink_the_clip_but_never_grow_it_past_30s(clip: dict[str, Any]) -> None:
    rules = clip["rules"]
    assert rules["startPastCeiling"] == {"startMs": 30_000, "endMs": 60_000}
    assert rules["startPastZero"] == {"startMs": 0, "endMs": 20_000}
    assert rules["startUnderMinimum"] == {"startMs": 59_700, "endMs": 60_000}


@requires_node
def test_moving_keeps_the_length_and_stays_inside_the_file(clip: dict[str, Any]) -> None:
    rules = clip["rules"]
    assert rules["moved"] == {"startMs": 25_000, "endMs": 55_000}
    assert rules["movedPastEnd"] == {"startMs": 45_000, "endMs": 75_000}
    assert rules["movedPastStart"] == {"startMs": 0, "endMs": 17_500}


@requires_node
def test_readouts(clip: dict[str, Any]) -> None:
    rules = clip["rules"]
    assert rules["time"] == ["0:00.0", "0:54.4", "1:15.0", "10:06.0"]
    assert rules["describe"] == "0:37.0 to 0:54.5, 17.5 s of 1:15.0"


@requires_node
def test_downmix_averages_channels_and_leaves_mono_alone(clip: dict[str, Any]) -> None:
    assert clip["rules"]["downmix"] == [0.5, 0.5, 0]
    assert clip["rules"]["mono"] is True


@requires_node
def test_a_slice_covers_exactly_the_clip(clip: dict[str, Any]) -> None:
    rules = clip["rules"]
    # Sample 16000 of the ramp: (16000 % 1000) / 1000 - 0.5.
    assert rules["sliceFirst"] == pytest.approx(-0.5)
    assert rules["sliceLength"] == SAMPLE_RATE
    assert rules["sliceAtFileEnd"] == SAMPLE_RATE
    assert rules["sliceFractional"] <= MAX_SECONDS * SAMPLE_RATE


@requires_node
def test_a_clip_is_the_same_recording_shape_a_microphone_take_is(clip: dict[str, Any]) -> None:
    fields = clip["rules"]["recordingFields"]
    assert fields["durationMs"] == 15_000
    assert fields["sampleRate"] == SAMPLE_RATE
    assert fields["segments"] == [{"startMs": 0, "endMs": 15_000}]
    # Playback plays the very bytes the analyzer is sent.
    assert fields["blobMatchesBytes"] is True
    assert fields["samplesMatchBytes"] is True


@requires_node
@pytest.mark.parametrize(
    ("name", "seconds"),
    [("fullCeiling", 30.0), ("fromMiddle", 30.0), ("fractional", 30.0), ("shortest", 0.3)],
)
def test_every_clip_decodes_within_the_backend_limits(
    clip: dict[str, Any], name: str, seconds: float
) -> None:
    decoded = decode_wav(wav(clip, name))
    assert decoded.sample_rate == SAMPLE_RATE
    assert len(decoded.samples) == round(seconds * SAMPLE_RATE)
    assert MIN_SECONDS * 1000 <= decoded.duration_ms <= MAX_SECONDS * 1000


@requires_node
def test_a_30s_clip_of_a_longer_file_is_accepted_by_analyze(clip: dict[str, Any]) -> None:
    with TestClient(create_app(model_loader=fake_engine)) as client:
        response = client.post(
            "/api/analyze",
            files={"audio": ("clip.wav", wav(clip, "fromMiddle"), "audio/wav")},
        )
    assert response.status_code == 200
