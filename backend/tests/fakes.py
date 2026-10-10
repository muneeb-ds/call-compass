"""Reusable test doubles.

`FakeModel` satisfies `callcompass.model.SpeechToolModel`, so the whole app can boot
and traverse without downloading the real 43 MB ONNX bundle. It replays a scripted
list of responses, one per `generate()` call, and records what it was asked.
"""

from __future__ import annotations

import io
import math
import wave
from typing import Any

from callcompass.model import InferenceEngine, ToolCall, ToolSpec

#: What the real model returns when nothing in the tool list applies.
NONE_OF_THESE_CALL: list[ToolCall] = [{"name": "none_of_these", "arguments": {}}]

#: An empty model response — a normal `generate()` result, not an error.
EMPTY_RESPONSE: list[ToolCall] = []


def picks(tool_name: str, **arguments: str) -> list[ToolCall]:
    """One scripted `generate()` response choosing `tool_name`.

    Keeps a traversal script readable: `[picks("pricing_question", pricing_focus="plan_cost")]`.
    """
    return [{"name": tool_name, "arguments": dict(arguments)}]


class FakeModel:
    """A scripted stand-in for `neudecide.NeuDecide`.

    `script` is one response per `generate()` call, in order. Each response is a list
    of tool calls — `[]` models an empty model response. Once the script runs out,
    every further call returns `[]`.
    """

    sample_rate = 16000

    def __init__(self, script: list[list[ToolCall]] | None = None) -> None:
        self.script = list(script or [])
        #: One `(audio, tools)` pair per call, in call order.
        self.calls: list[tuple[Any, list[ToolSpec]]] = []

    def generate(self, audio: Any, tools: list[ToolSpec]) -> list[ToolCall]:
        self.calls.append((audio, tools))
        if not self.script:
            return []
        return self.script.pop(0)


def fake_engine(
    script: list[list[ToolCall]] | None = None, load_ms: float = 12.0
) -> InferenceEngine:
    """An `InferenceEngine` wrapping a `FakeModel`, ready to hand to `create_app`."""
    return InferenceEngine(FakeModel(script), load_ms=load_ms, providers=["CPUExecutionProvider"])


def make_wav(
    seconds: float = 1.0,
    *,
    sample_rate: int = 16_000,
    channels: int = 1,
    sample_width: int = 2,
    freq: float = 220.0,
) -> bytes:
    """A WAV fixture: a quiet sine tone, valid 16 kHz mono 16-bit PCM by default.

    The keyword arguments exist so a test can build a deliberately *invalid* file
    (wrong rate, stereo, 8-bit) without hand-assembling a RIFF header.
    """
    frames = int(seconds * sample_rate)
    peak = float(2 ** (sample_width * 8 - 1) - 1) * 0.5
    payload = bytearray()
    for i in range(frames):
        value = int(peak * math.sin(2 * math.pi * freq * i / sample_rate))
        if sample_width == 1:
            # 8-bit WAV is unsigned, centred on 128.
            sample = bytes([128 + value])
        else:
            sample = value.to_bytes(sample_width, "little", signed=True)
        payload += sample * channels

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(sample_width)
        wav.setframerate(sample_rate)
        wav.writeframes(bytes(payload))
    return buffer.getvalue()
