"""Loading the NeuDecide model once, and serializing inference against it.

The model is a 43 MB ONNX bundle run on CPU. Construction is expensive (graph
download on first use, then three `onnxruntime` sessions), so it happens exactly once
per process — in the FastAPI lifespan handler — and the resulting `InferenceEngine`
is stored on `app.state`.

`neudecide.NeuDecide.generate()` is *not* safe to call concurrently (it lazily builds
`self._ll_tokenizer` on first constrained decode), so every call is funnelled through
one lock here. Callers run `generate()` in a thread executor; the lock means the
inference stays effectively single-flight, which is correct for a one-operator demo.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Protocol

import numpy as np

from .tree import NONE_OF_THESE

logger = logging.getLogger(__name__)

#: One tool definition in the shape `neudecide` expects (see `grammar.tool_parameters`).
ToolSpec = dict[str, Any]
#: One tool call returned by the model: `{"name": str, "arguments": {...}}`.
ToolCall = dict[str, Any]

DEFAULT_REPO = "neuphonic/neudecide"
DEFAULT_VARIANT = "q4"

#: Length of the silent buffer used for the startup warmup. Long enough to exercise
#: the audio encoder, short enough not to slow boot.
WARMUP_SECONDS = 0.5

#: Minimal tool list for the warmup call. Deliberately not built from the tree: warmup
#: only needs to force every ONNX graph through one real pass.
_WARMUP_TOOLS: list[ToolSpec] = [
    {
        "name": NONE_OF_THESE,
        "description": "Nothing in this list applies to what was said.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    }
]


class ModelLoadError(RuntimeError):
    """The model could not be loaded. The message is always a single readable line."""


class SpeechToolModel(Protocol):
    """The slice of `neudecide.NeuDecide` that CallCompass actually uses.

    Test fakes implement this; nothing else in the codebase should depend on the
    concrete `NeuDecide` class.
    """

    @property
    def sample_rate(self) -> int: ...

    def generate(self, audio: Any, tools: list[ToolSpec]) -> list[ToolCall]: ...


class InferenceEngine:
    """The single loaded model, plus the lock that keeps calls one-at-a-time."""

    def __init__(self, model: SpeechToolModel, load_ms: float, providers: list[str]) -> None:
        self._model = model
        self._lock = threading.Lock()
        self.load_ms = load_ms
        self.providers = providers

    @property
    def sample_rate(self) -> int:
        """Sample rate the model's audio encoder expects, in Hz (16000)."""
        return int(self._model.sample_rate)

    def generate(self, audio: Any, tools: list[ToolSpec]) -> list[ToolCall]:
        """One inference. Blocking CPU work — call from a thread executor."""
        with self._lock:
            return list(self._model.generate(audio, tools))

    def warmup(self) -> float:
        """Runs one inference on a silent buffer so the first real request isn't cold.

        Returns the warmup duration in ms.
        """
        silence = np.zeros(int(WARMUP_SECONDS * self.sample_rate), dtype=np.float32)
        started = time.perf_counter()
        self.generate(silence, _WARMUP_TOOLS)
        return (time.perf_counter() - started) * 1000.0


def _providers(model: SpeechToolModel) -> list[str]:
    """ONNX Runtime execution providers in use, read off the audio encoder session."""
    session = getattr(model, "audio_encoder", None)
    get_providers = getattr(session, "get_providers", None)
    if get_providers is None:
        return []
    return [str(p) for p in get_providers()]


def _construct(model_dir: str | None, repo: str, variant: str) -> SpeechToolModel:
    from neudecide import NeuDecide

    model: SpeechToolModel
    if model_dir:
        model = NeuDecide(Path(model_dir), variant=variant)
    else:
        model = NeuDecide.from_pretrained(repo, variant=variant, token=os.environ.get("HF_TOKEN"))
    return model


def _one_line(exc: Exception, limit: int = 240) -> str:
    """The exception message collapsed to one line, so it can't bury the hint after it.

    Hugging Face's `GatedRepoError` in particular spans several lines.
    """
    text = " ".join(str(exc).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _failure_message(exc: Exception, source: str) -> str:
    """A single line that says what to do about a failed load."""
    hint = (
        "Set HF_TOKEN to a token with access to the gated repo, or point "
        "CALLCOMPASS_MODEL_DIR at a local model directory."
        if "401" in str(exc) or "gated" in str(exc).lower()
        else "Set CALLCOMPASS_MODEL_DIR to a local model directory to load offline."
    )
    return (
        f"Could not load the NeuDecide model from {source}: "
        f"{type(exc).__name__}: {_one_line(exc)} -- {hint}"
    )


def load_engine() -> InferenceEngine:
    """Loads the model, logs load time and execution provider, and warms it up.

    Reads `CALLCOMPASS_MODEL_DIR` (a local model directory, skipping any download),
    `CALLCOMPASS_MODEL_REPO`, `CALLCOMPASS_MODEL_VARIANT`, and `HF_TOKEN`.

    Raises `ModelLoadError` with a single readable line if the model cannot be loaded
    or cannot complete the warmup inference, so the server fails fast at startup.
    """
    model_dir = os.environ.get("CALLCOMPASS_MODEL_DIR")
    repo = os.environ.get("CALLCOMPASS_MODEL_REPO", DEFAULT_REPO)
    variant = os.environ.get("CALLCOMPASS_MODEL_VARIANT", DEFAULT_VARIANT)
    source = model_dir or f"Hugging Face repo '{repo}'"

    started = time.perf_counter()
    try:
        model = _construct(model_dir, repo, variant)
    except Exception as exc:
        raise ModelLoadError(_failure_message(exc, source)) from exc
    load_ms = (time.perf_counter() - started) * 1000.0

    engine = InferenceEngine(model, load_ms, _providers(model))
    logger.info(
        "NeuDecide loaded from %s (variant %s) in %d ms; execution providers: %s",
        source,
        variant,
        round(load_ms),
        ", ".join(engine.providers) or "unknown",
    )

    try:
        warmup_ms = engine.warmup()
    except Exception as exc:
        raise ModelLoadError(
            f"NeuDecide loaded from {source} but the warmup inference failed: "
            f"{type(exc).__name__}: {_one_line(exc)}"
        ) from exc
    logger.info("Warmup inference completed in %d ms", round(warmup_ms))

    return engine
