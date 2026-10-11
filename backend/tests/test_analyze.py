"""HTTP surface of the traversal: `POST /api/analyze` SSE and `GET /api/tree`.

These run the real app (`create_app`) over a real decoded WAV, with only the model
faked, so the multipart parsing, the audio 400, the SSE framing and the event order
are all exercised end to end.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time

import pytest
from fastapi.testclient import TestClient

from callcompass.audio import decode_wav
from callcompass.main import create_app
from callcompass.model import InferenceEngine, ToolCall, ToolSpec
from callcompass.stream import analyze_events
from callcompass.tree import default_config_path, load_tree

from .fakes import (
    EMPTY_RESPONSE,
    NONE_OF_THESE_CALL,
    FakeModel,
    fake_engine,
    make_wav,
    parse_sse,
    picks,
)

Frames = list[tuple[str, dict[str, object]]]

HAPPY_PATH = [
    picks("pricing_question", pricing_focus="plan_cost"),
    picks("plan_cost_question", cost_frame="per_seat"),
    picks("pro_tier", growth_signal="scaling_team"),
    picks("budget_objection", budget_blocker="too_expensive"),
]


def engine_with(script: list[list[ToolCall]]) -> tuple[InferenceEngine, FakeModel]:
    """An engine plus a handle on its fake model, for asserting on the calls made."""
    model = FakeModel(script)
    engine = InferenceEngine(model, load_ms=12.0, providers=["CPUExecutionProvider"])
    return engine, model


def analyze(
    script: list[list[ToolCall]] | None = None,
    *,
    wav: bytes | None = None,
    fail_on_call: int | None = None,
) -> tuple[int, str, Frames]:
    """POST one WAV to `/api/analyze`, returning status, content type and SSE frames.

    Frames are empty for a non-stream (4xx) response, whose body is JSON instead.
    """
    engine = fake_engine(script, fail_on_call=fail_on_call)
    upload = ("utterance.wav", wav if wav is not None else make_wav(1.0), "audio/wav")
    with TestClient(create_app(model_loader=lambda: engine)) as client:
        response = client.post("/api/analyze", files={"audio": upload})
    content_type = response.headers["content-type"]
    frames = parse_sse(response.text) if content_type.startswith("text/event-stream") else []
    return response.status_code, content_type, frames


def test_happy_path_emits_started_steps_completed_done() -> None:
    status, content_type, frames = analyze(HAPPY_PATH)

    assert status == 200
    assert content_type.startswith("text/event-stream")
    assert [name for name, _ in frames] == [
        "started",
        "step",
        "step",
        "step",
        "step",
        "completed",
        "done",
    ]


def test_started_payload_describes_the_run() -> None:
    _, _, frames = analyze(HAPPY_PATH)

    assert frames[0][1] == {
        "tree_id": "northbeam-saas-v2",
        "root": "intent",
        "audio_duration_ms": 1000,
    }


def test_step_payloads_match_the_documented_schema() -> None:
    _, _, frames = analyze(HAPPY_PATH)
    steps = [data for name, data in frames if name == "step"]

    first = steps[0]
    assert set(first) == {
        "event",
        "index",
        "node_id",
        "node_label",
        "tool_called",
        "arguments",
        "latency_ms",
        "next_node_id",
    }
    assert first["index"] == 0
    assert first["node_id"] == "intent"
    assert first["node_label"] == "Customer intent"
    assert first["tool_called"] == "pricing_question"
    assert first["arguments"] == {"pricing_focus": "plan_cost"}
    assert isinstance(first["latency_ms"], int)
    assert first["next_node_id"] == "pricing_focus"

    assert [data["index"] for data in steps] == [0, 1, 2, 3]
    assert [data["next_node_id"] for data in steps] == [
        "pricing_focus",
        "tier_fit",
        "objection_or_signal",
        "out_value_reframe",
    ]


def test_completed_payload_carries_the_outcome_and_both_totals() -> None:
    _, _, frames = analyze(HAPPY_PATH)
    name, data = frames[-2]

    assert name == "completed"
    assert set(data) == {
        "event",
        "leaf_node_id",
        "label",
        "path",
        "inference_count",
        "total_inference_ms",
        "total_latency_ms",
    }
    assert data["leaf_node_id"] == "out_value_reframe"
    assert data["label"] == "Budget objection"
    assert data["path"] == [
        "intent",
        "pricing_focus",
        "tier_fit",
        "objection_or_signal",
        "out_value_reframe",
    ]
    assert data["inference_count"] == 4
    assert isinstance(data["total_inference_ms"], int)
    assert isinstance(data["total_latency_ms"], int)


def test_unplaced_payload_names_where_and_why_it_stopped() -> None:
    script = [picks("pricing_question", pricing_focus="plan_cost"), NONE_OF_THESE_CALL]
    status, _, frames = analyze(script)

    assert status == 200
    assert [name for name, _ in frames] == ["started", "step", "unplaced", "done"]

    data = frames[-2][1]
    assert set(data) == {
        "event",
        "stopped_at_node_id",
        "stopped_at_label",
        "reason",
        "path",
        "inference_count",
        "total_inference_ms",
        "total_latency_ms",
    }
    assert data["stopped_at_node_id"] == "pricing_focus"
    assert data["stopped_at_label"] == "Pricing concern"
    assert data["reason"] == "none_of_these"
    assert data["path"] == ["intent", "pricing_focus"]
    assert data["inference_count"] == 2
    assert isinstance(data["total_latency_ms"], int)


@pytest.mark.parametrize("script", [HAPPY_PATH, [EMPTY_RESPONSE], [NONE_OF_THESE_CALL]])
def test_done_is_always_the_final_event(script: list[list[ToolCall]]) -> None:
    _, _, frames = analyze(script)
    assert frames[-1] == ("done", {})


def test_mid_stream_failure_emits_error_then_done() -> None:
    status, _, frames = analyze(HAPPY_PATH, fail_on_call=2)

    assert status == 200
    assert [name for name, _ in frames] == ["started", "step", "error", "done"]

    data = frames[-2][1]
    assert set(data) == {"message", "node_id"}
    assert data["node_id"] == "pricing_focus"
    assert "pricing_focus" in str(data["message"])


@pytest.mark.parametrize(
    ("wav", "expected"),
    [
        (make_wav(1.0, sample_rate=44100, channels=2), "44100 Hz stereo"),
        (make_wav(0.1), "0.3"),
        (b"this is not a wav file at all", "WAV"),
    ],
)
def test_rejected_audio_is_a_400_naming_the_actual_value(wav: bytes, expected: str) -> None:
    """Rejection is JSON, not a stream — the 400 lands before any event is written."""
    engine, model = engine_with(HAPPY_PATH)
    with TestClient(create_app(model_loader=lambda: engine)) as client:
        response = client.post("/api/analyze", files={"audio": ("bad.wav", wav, "audio/wav")})

    assert response.status_code == 400
    assert response.headers["content-type"].startswith("application/json")
    assert expected in response.json()["detail"]
    assert model.calls == []  # rejected audio never reaches the model


def test_same_audio_is_passed_at_every_node() -> None:
    engine, model = engine_with(HAPPY_PATH)
    with TestClient(create_app(model_loader=lambda: engine)) as client:
        client.post("/api/analyze", files={"audio": ("u.wav", make_wav(1.0), "audio/wav")})

    assert len(model.calls) == 4
    first = model.calls[0][0]
    assert all(audio is first for audio, _ in model.calls)


def test_inference_runs_off_the_event_loop_thread() -> None:
    """`generate()` is blocking CPU work, so it must never run on the loop thread."""

    class ThreadRecordingModel(FakeModel):
        def __init__(self, script: list[list[ToolCall]]) -> None:
            super().__init__(script)
            self.threads: list[int] = []

        def generate(self, audio: object, tools: list[ToolSpec]) -> list[ToolCall]:
            self.threads.append(threading.get_ident())
            return super().generate(audio, tools)

    model = ThreadRecordingModel(HAPPY_PATH)
    engine = InferenceEngine(model, load_ms=1.0, providers=["CPUExecutionProvider"])
    audio = decode_wav(make_wav(1.0))
    tree = load_tree(default_config_path())

    async def run() -> int:
        events = analyze_events(audio, tree, engine, request_started=time.perf_counter())
        async for _ in events:
            pass
        return threading.get_ident()

    loop_thread = asyncio.run(run())

    assert len(model.threads) == 4
    assert loop_thread not in model.threads


def test_get_tree_returns_the_config_verbatim() -> None:
    with TestClient(create_app(model_loader=fake_engine)) as client:
        response = client.get("/api/tree")

    assert response.status_code == 200
    assert response.json() == json.loads(default_config_path().read_text())
