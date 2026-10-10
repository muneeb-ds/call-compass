"""The browser's WAV encoder, checked against the real decoder.

`frontend/` has no JS test runner (no bundler, no node_modules, by design), so the
client-side capture pipeline is verified from here: node runs the *shipped*
`wav.js` and the *shipped* worklet resampler, and the bytes they produce are fed to
`decode_wav` and to `POST /api/analyze`.

That closes PRD risk R-5 from the one direction that matters — a wrong header or
sample rate must be a 400, and the encoder must never produce one.
"""

from __future__ import annotations

import base64
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from callcompass.audio import MAX_SECONDS, MIN_SECONDS, SAMPLE_RATE, decode_wav
from callcompass.main import create_app

from .fakes import fake_engine

HARNESS = Path(__file__).resolve().parent / "encode_fixture.mjs"

#: Hardware rates a browser may hand back when it ignores `{ sampleRate: 16000 }`.
SOURCE_RATES = [16_000, 44_100, 48_000, 8_000]

requires_node = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is needed to run the frontend encoder"
)


def encode(source_rate: int, seconds: float = 1.0, block_size: int = 128) -> bytes:
    """One WAV, produced by the frontend's own encoder running under node."""
    result = subprocess.run(
        ["node", str(HARNESS), str(source_rate), str(seconds), str(block_size)],
        capture_output=True,
        check=True,
        text=True,
    )
    return base64.b64decode(result.stdout)


@requires_node
@pytest.mark.parametrize("source_rate", SOURCE_RATES)
def test_encoder_output_is_accepted_by_the_decoder(source_rate: int) -> None:
    decoded = decode_wav(encode(source_rate))

    assert decoded.sample_rate == SAMPLE_RATE
    assert decoded.samples.dtype == np.float32
    assert decoded.samples.ndim == 1
    # One sample can remain pending in the resampler at the moment recording stops.
    assert abs(decoded.duration_ms - 1000) <= 1


@requires_node
@pytest.mark.parametrize("seconds", [MIN_SECONDS, 1.0, MAX_SECONDS])
def test_encoder_output_is_accepted_across_the_allowed_durations(seconds: float) -> None:
    """The duration bounds are the easiest way to produce an accidental 400."""
    decoded = decode_wav(encode(48_000, seconds))

    assert MIN_SECONDS * 1000 <= decoded.duration_ms <= MAX_SECONDS * 1000


@requires_node
def test_resampled_audio_preserves_the_signal() -> None:
    """A 220 Hz tone has to still be a 220 Hz tone, not aliased noise.

    A resampler that drops or duplicates samples still decodes fine and still
    produces a confident (wrong) answer from the model, so correct *bytes* are not
    enough — the dominant frequency is the thing to assert.
    """
    samples = decode_wav(encode(48_000)).samples
    spectrum = np.abs(np.fft.rfft(samples))
    peak_hz = float(np.fft.rfftfreq(len(samples), 1 / SAMPLE_RATE)[int(np.argmax(spectrum))])

    assert peak_hz == pytest.approx(220.0, abs=2.0)
    assert float(np.max(np.abs(samples))) == pytest.approx(0.5, abs=0.02)


@requires_node
@pytest.mark.parametrize("source_rate", SOURCE_RATES)
def test_analyze_accepts_the_browser_encoded_upload(source_rate: int) -> None:
    """The acceptance criterion itself: POSTing the encoded WAV is not a 400."""
    upload = ("utterance.wav", encode(source_rate), "audio/wav")
    with TestClient(create_app(model_loader=fake_engine)) as client:
        response = client.post("/api/analyze", files={"audio": upload})

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")


def test_frontend_ships_the_capture_modules() -> None:
    """The worklet is fetched by URL at runtime, so it has to be a served file."""
    frontend = Path(__file__).resolve().parents[2] / "frontend"

    for name in ["wav.js", "capture.js", "recorder-worklet.js", "app.js"]:
        assert (frontend / name).is_file()
