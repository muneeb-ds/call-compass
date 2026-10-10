"""Audio validation and WAV decode.

Fixtures are generated, not checked in: `make_wav` builds both the valid 1-second
16 kHz mono file and each deliberately-invalid variant.
"""

from __future__ import annotations

import numpy as np
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from callcompass.audio import (
    MAX_BYTES,
    MAX_SECONDS,
    SAMPLE_RATE,
    AudioError,
    decode_wav,
)
from callcompass.main import create_app

from .fakes import fake_engine, make_wav


def test_decodes_one_second_16k_mono() -> None:
    decoded = decode_wav(make_wav(1.0))

    assert decoded.sample_rate == SAMPLE_RATE
    assert decoded.duration_ms == 1000
    assert decoded.samples.shape == (SAMPLE_RATE,)
    assert decoded.samples.dtype == np.float32


def test_decoded_samples_are_in_model_range() -> None:
    """`neudecide` requires float audio already scaled into [-1, 1]."""
    samples = decode_wav(make_wav(1.0)).samples

    assert np.all(np.abs(samples) <= 1.0)
    assert np.abs(samples).max() > 0.1  # the tone actually survived the decode


def test_decoded_samples_are_writable() -> None:
    """A read-only `frombuffer` view would break anything that normalises in place."""
    samples = decode_wav(make_wav(0.5)).samples

    samples[0] = 0.0  # must not raise


def test_shortest_and_longest_accepted_durations() -> None:
    assert decode_wav(make_wav(0.3)).duration_ms == 300
    assert decode_wav(make_wav(MAX_SECONDS)).duration_ms == 30_000


def test_rejects_wrong_sample_rate() -> None:
    with pytest.raises(AudioError) as caught:
        decode_wav(make_wav(1.0, sample_rate=44_100))

    assert str(caught.value) == "Audio must be 16000 Hz mono; received 44100 Hz mono."


def test_rejects_stereo() -> None:
    with pytest.raises(AudioError) as caught:
        decode_wav(make_wav(1.0, channels=2))

    assert str(caught.value) == "Audio must be 16000 Hz mono; received 16000 Hz stereo."


def test_rejects_wrong_rate_and_channels_in_one_message() -> None:
    """The PRD's example message names both actual values at once."""
    with pytest.raises(AudioError) as caught:
        decode_wav(make_wav(1.0, sample_rate=44_100, channels=2))

    assert str(caught.value) == "Audio must be 16000 Hz mono; received 44100 Hz stereo."


def test_rejects_non_16_bit() -> None:
    with pytest.raises(AudioError) as caught:
        decode_wav(make_wav(1.0, sample_width=1))

    assert str(caught.value) == "Audio must be 16-bit PCM; received 8-bit."


def test_rejects_non_wav_payload() -> None:
    with pytest.raises(AudioError) as caught:
        decode_wav(b"\x00\x01" * 32_000)

    message = str(caught.value)
    assert message.startswith("Audio must be a WAV file;")
    assert "\n" not in message


def test_rejects_empty_body() -> None:
    with pytest.raises(AudioError) as caught:
        decode_wav(b"")

    assert str(caught.value) == "Audio must not be empty; received 0 bytes."


def test_rejects_too_long() -> None:
    with pytest.raises(AudioError) as caught:
        decode_wav(make_wav(31.0))

    assert str(caught.value) == "Audio must be 30 seconds or shorter; received 31.0 seconds."


def test_rejects_too_short() -> None:
    with pytest.raises(AudioError) as caught:
        decode_wav(make_wav(0.1))

    assert str(caught.value) == "Audio must be at least 0.3 seconds; received 0.10 seconds."


def test_rejects_oversized_body_before_parsing() -> None:
    """Size is checked first, so an oversized body never reaches the WAV parser."""
    with pytest.raises(AudioError) as caught:
        decode_wav(b"x" * (MAX_BYTES + 1))

    assert str(caught.value) == "Audio must be 2 MB or smaller; received 2.0 MB."


def _app_with_decode_route() -> FastAPI:
    """The real app plus one route that decodes its body, to exercise the 400 handler.

    US-007's `/api/analyze` is the production caller; this keeps the handler covered
    while the endpoint doesn't exist yet.
    """
    app = create_app(model_loader=fake_engine)

    @app.post("/test/decode")
    async def decode(request: Request) -> dict[str, int]:
        decoded = decode_wav(await request.body())
        return {"duration_ms": decoded.duration_ms}

    # `create_app` mounts the frontend at `/`, which matches every path. Starlette
    # resolves routes in order, so a route appended afterwards is shadowed (GET-only
    # mount -> 405). Push the mount back to last.
    mount = next(route for route in app.router.routes if getattr(route, "name", "") == "frontend")
    app.router.routes.remove(mount)
    app.router.routes.append(mount)

    return app


def test_audio_error_becomes_http_400_with_detail() -> None:
    with TestClient(_app_with_decode_route()) as client:
        response = client.post("/test/decode", content=make_wav(1.0, sample_rate=44_100))

    assert response.status_code == 400
    assert response.json() == {
        "detail": "Audio must be 16000 Hz mono; received 44100 Hz mono."
    }


def test_valid_audio_passes_through_the_route() -> None:
    with TestClient(_app_with_decode_route()) as client:
        response = client.post("/test/decode", content=make_wav(1.0))

    assert response.status_code == 200
    assert response.json() == {"duration_ms": 1000}
