"""Validating and decoding the uploaded WAV into the array `neudecide` expects.

This is the only module that knows the audio wire format. It is pure: no model, no
network, no filesystem. Every rejection raises `AudioError` with a single line that
names the *actual* value received, so the UI can show the operator what was wrong
rather than "invalid audio".

The browser (US-009) is responsible for producing 16 kHz mono 16-bit PCM; this module
deliberately does **not** resample or downmix. Silently fixing up bad audio would hide
exactly the client-side pipeline bugs the PRD calls out as risk R-5.
"""

from __future__ import annotations

import io
import wave
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

#: The only accepted format. `SAMPLE_RATE` must match `InferenceEngine.sample_rate`.
SAMPLE_RATE = 16_000
CHANNELS = 1
SAMPLE_WIDTH_BYTES = 2  # 16-bit PCM

MAX_BYTES = 2 * 1024 * 1024
MIN_SECONDS = 0.3
MAX_SECONDS = 30.0

#: int16 full scale. Dividing by this keeps decoded samples inside [-1, 1), which is
#: what `neudecide` requires of a float array.
_INT16_SCALE = 32768.0


class AudioError(ValueError):
    """Uploaded audio was rejected. The message is always one readable line.

    The HTTP layer maps this to a 400 with the message as `detail`.
    """


@dataclass(frozen=True)
class DecodedAudio:
    """One decoded utterance, ready to pass to `generate()` at every node."""

    #: Mono float32 samples in [-1, 1), shape `(samples,)`.
    samples: NDArray[np.float32]
    sample_rate: int
    duration_ms: int


def _channel_name(channels: int) -> str:
    """How many channels, in the words the PRD's example message uses."""
    if channels == 1:
        return "mono"
    if channels == 2:
        return "stereo"
    return f"{channels} channels"


def _open_wav(data: bytes) -> wave.Wave_read:
    """Parses the WAV container, or rejects the payload as not being WAV at all."""
    try:
        return wave.open(io.BytesIO(data), "rb")
    except (wave.Error, EOFError) as exc:
        detail = " ".join(str(exc).split()) or type(exc).__name__
        raise AudioError(
            "Audio must be a WAV file; received a payload that could not be read "
            f"as WAV ({detail})."
        ) from exc


def decode_wav(data: bytes) -> DecodedAudio:
    """Validates `data` as 16 kHz mono 16-bit PCM WAV and decodes it.

    Checks run cheapest-first — size, then container, then format, then duration — so a
    2 MB body is rejected without being parsed.

    Raises `AudioError` naming the offending value.
    """
    if not data:
        raise AudioError("Audio must not be empty; received 0 bytes.")
    if len(data) > MAX_BYTES:
        raise AudioError(
            f"Audio must be {MAX_BYTES / 1024 / 1024:.0f} MB or smaller; "
            f"received {len(data) / 1024 / 1024:.1f} MB."
        )

    with _open_wav(data) as wav:
        rate = wav.getframerate()
        channels = wav.getnchannels()
        width = wav.getsampwidth()
        frames = wav.getnframes()

        if rate != SAMPLE_RATE or channels != CHANNELS:
            raise AudioError(
                f"Audio must be {SAMPLE_RATE} Hz {_channel_name(CHANNELS)}; "
                f"received {rate} Hz {_channel_name(channels)}."
            )
        if width != SAMPLE_WIDTH_BYTES:
            raise AudioError(
                f"Audio must be {SAMPLE_WIDTH_BYTES * 8}-bit PCM; received {width * 8}-bit."
            )

        duration = frames / rate
        if duration > MAX_SECONDS:
            raise AudioError(
                f"Audio must be {MAX_SECONDS:.0f} seconds or shorter; "
                f"received {duration:.1f} seconds."
            )
        if duration < MIN_SECONDS:
            raise AudioError(
                f"Audio must be at least {MIN_SECONDS} seconds; received {duration:.2f} seconds."
            )

        payload = wav.readframes(frames)

    # `astype` copies, so the result does not alias the read-only `frombuffer` view.
    samples = np.frombuffer(payload, dtype="<i2").astype(np.float32) / _INT16_SCALE
    return DecodedAudio(
        samples=samples,
        sample_rate=rate,
        duration_ms=round(duration * 1000),
    )
