"""Reusable test doubles.

`FakeModel` satisfies `callcompass.model.SpeechToolModel`, so the whole app can boot
and traverse without downloading the real 43 MB ONNX bundle. It replays a scripted
list of responses, one per `generate()` call, and records what it was asked.
"""

from __future__ import annotations

from typing import Any

from callcompass.model import InferenceEngine, ToolCall, ToolSpec

#: What the real model returns when nothing in the tool list applies.
NONE_OF_THESE_CALL: list[ToolCall] = [{"name": "none_of_these", "arguments": {}}]


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
