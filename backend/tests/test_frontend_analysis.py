"""The browser's live highlighting and trace panel, checked from the backend.

The UI's job here is to be a faithful reading of the SSE stream, so the assertions
feed it the **real** bytes: each test runs one traversal through `POST /api/analyze`
with a scripted fake model, captures the response body verbatim, and replays it into
the *shipped* `sse.js` / `trace.js` / `analysis.js` under node
(`analysis_fixture.mjs`). A renamed event field or a payload the UI misreads fails
here rather than on a projector.

The body is replayed in chunks, including one character at a time, because an SSE
frame boundary can land anywhere in a network read.

Same harness shape as the encoder, timer, playback, and tree tests.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any, get_args

import pytest
from fastapi.testclient import TestClient

from callcompass.main import create_app
from callcompass.traversal import StopReason
from callcompass.tree import default_config_path

from .fakes import EMPTY_RESPONSE, NONE_OF_THESE_CALL, fake_engine, make_wav, picks

HARNESS = Path(__file__).resolve().parent / "analysis_fixture.mjs"

#: The sample tree's deepest route: intent -> pricing_focus -> tier_fit ->
#: objection_or_signal -> out_value_reframe. Four inferences, one per branch node.
HAPPY_SCRIPT = [
    picks("pricing_question", pricing_focus="plan_cost"),
    picks("plan_cost_question", cost_frame="per_seat"),
    picks("pro_tier", tier_signal="team_size"),
    picks("budget_objection", objection_strength="hard"),
]

requires_node = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is needed to run the frontend SSE reader"
)


def analyze(script: list[list[dict[str, Any]]]) -> str:
    """One real traversal's SSE response body, exactly as the browser would receive it."""
    app = create_app(model_loader=lambda: fake_engine(script))
    with TestClient(app) as client:
        response = client.post(
            "/api/analyze", files={"audio": ("utterance.wav", make_wav(1.0), "audio/wav")}
        )
    assert response.status_code == 200, response.text
    return response.text


def run_harness(body: str, tmp_path: Path, *args: str) -> dict[str, Any]:
    """Replays `body` through the shipped frontend modules under node."""
    sse = tmp_path / "stream.sse"
    sse.write_text(body)
    result = subprocess.run(
        ["node", str(HARNESS), str(default_config_path()), str(sse), *args],
        capture_output=True,
        check=True,
        text=True,
    )
    parsed: dict[str, Any] = json.loads(result.stdout)
    return parsed


@pytest.fixture(scope="module")
def happy_body() -> str:
    return analyze(HAPPY_SCRIPT)


@pytest.fixture(scope="module")
def unplaced_body() -> str:
    """Declined at the root: zero steps, so the panel must still show a total."""
    return analyze([NONE_OF_THESE_CALL])


@pytest.fixture
def happy(happy_body: str, tmp_path: Path) -> dict[str, Any]:
    if shutil.which("node") is None:
        pytest.skip("node is needed to run the frontend SSE reader")
    return run_harness(happy_body, tmp_path)


@requires_node
def test_posts_the_wav_as_multipart(happy: dict[str, Any]) -> None:
    assert happy["requests"] == [
        {"url": "/api/analyze", "method": "POST", "audioBytes": 3, "audioType": "audio/wav"}
    ]


@requires_node
def test_reads_every_event_in_arrival_order(happy: dict[str, Any]) -> None:
    assert [name for name, _ in happy["frames"]] == [
        "started",
        "step",
        "step",
        "step",
        "step",
        "completed",
        "done",
    ]


@requires_node
def test_lights_each_step_node_and_the_edges_between_them(happy: dict[str, Any]) -> None:
    # The leaf has no step of its own: it lights on `completed`, last, along with the
    # edge into it.
    visited = {node for node, state in happy["nodes"].items() if state == "visited"}
    assert visited == {
        "intent",
        "pricing_focus",
        "tier_fit",
        "objection_or_signal",
        "out_value_reframe",
    }
    # Every other node in the 26-node tree is untouched.
    assert set(happy["nodes"].values()) == {"visited", "idle"}

    lit = {key for key, state in happy["edges"].items() if state == "visited"}
    assert lit == {
        "intent->pricing_focus",
        "pricing_focus->tier_fit",
        "tier_fit->objection_or_signal",
        "objection_or_signal->out_value_reframe",
    }


@requires_node
def test_lit_node_shows_option_argument_and_latency(happy: dict[str, Any]) -> None:
    option, argument, latency = happy["details"]["intent"]
    assert option == "Pricing question"
    assert argument == "pricing_focus: plan_cost"
    assert latency.endswith(" ms")
    # Only the visited nodes carry detail; everything else is still blank.
    annotated = {node for node, lines in happy["details"].items() if lines}
    assert annotated == {"intent", "pricing_focus", "tier_fit", "objection_or_signal"}


@requires_node
def test_one_trace_card_per_step_with_the_prd_shape(happy: dict[str, Any]) -> None:
    cards = happy["cards"]
    assert [card["index"] for card in cards] == ["0", "1", "2", "3"]
    assert [card["node"] for card in cards] == [
        "Customer intent",
        "Pricing concern",
        "Tier fit",
        "Objection or buying signal",
    ]
    assert [card["option"] for card in cards] == [
        "Pricing question",
        "Plan cost question",
        "Pro tier",
        "Budget objection",
    ]
    assert [card["args"] for card in cards] == [
        ["pricing_focus: plan_cost"],
        ["cost_frame: per_seat"],
        ["tier_signal: team_size"],
        ["objection_strength: hard"],
    ]
    # The latency badge is monospace and right-aligned by `.step-latency`.
    assert all(card["latency"].endswith(" ms") for card in cards)
    assert all(card["latencyClass"] == "step-latency mono" for card in cards)


@requires_node
def test_running_total_matches_the_backends_own_figure(
    happy: dict[str, Any], happy_body: str
) -> None:
    (completed,) = [data for name, data in happy["frames"] if name == "completed"]
    assert happy["total"] == f"Total: {completed['total_inference_ms']} ms"


@requires_node
def test_total_updates_per_step(happy_body: str, tmp_path: Path) -> None:
    """Truncating the stream mid-run must still leave a total for the steps so far."""
    frames = happy_body.split("\n\n")
    partial = "\n\n".join(frames[:3]) + "\n\n"  # started + two steps
    result = run_harness(partial, tmp_path)
    assert [name for name, _ in result["frames"]] == ["started", "step", "step"]
    latencies = [data["latency_ms"] for name, data in result["frames"] if name == "step"]
    assert result["total"] == f"Total: {sum(latencies)} ms"
    assert len(result["cards"]) == 2


@requires_node
def test_terminal_event_is_reported_once(happy: dict[str, Any]) -> None:
    assert happy["terminal"] == "completed"
    assert happy["terminalEvent"] == "completed"
    assert happy["error"] is None
    assert happy["failure"] is None
    # No stream is left in flight, and the response was released.
    assert happy["running"] is False
    assert happy["cancelled"] is True


@requires_node
@pytest.mark.parametrize("chunk", [1, 7, 64])
def test_frame_boundaries_may_land_anywhere_in_a_chunk(
    happy_body: str, tmp_path: Path, chunk: int, happy: dict[str, Any]
) -> None:
    chopped = run_harness(happy_body, tmp_path, f"--chunk={chunk}")
    assert chopped["frames"] == happy["frames"]
    assert chopped["total"] == happy["total"]
    assert chopped["cards"] == happy["cards"]


@requires_node
def test_decoder_handles_one_character_at_a_time(happy: dict[str, Any]) -> None:
    assert happy["decoder"] == [
        "started",
        "step",
        "step",
        "step",
        "step",
        "completed",
        "done",
    ]


@requires_node
def test_comments_and_crlf_framing_are_not_events(happy: dict[str, Any]) -> None:
    assert happy["comments"] == ["done"]
    assert happy["noData"] is None


@requires_node
def test_unplaced_marks_the_stopping_node_without_lighting_it(
    unplaced_body: str, tmp_path: Path
) -> None:
    result = run_harness(unplaced_body, tmp_path)
    assert [name for name, _ in result["frames"]] == ["started", "unplaced", "done"]
    assert result["nodes"]["intent"] == "warning"
    assert set(result["nodes"].values()) == {"warning", "idle"}
    assert result["cards"] == []
    # A run that declined at the root still spent inference time, so a total shows.
    (unplaced,) = [data for name, data in result["frames"] if name == "unplaced"]
    assert result["total"] == f"Total: {unplaced['total_inference_ms']} ms"


@requires_node
def test_unplaced_mid_tree_keeps_earlier_nodes_lit(tmp_path: Path) -> None:
    body = analyze([HAPPY_SCRIPT[0], EMPTY_RESPONSE])
    result = run_harness(body, tmp_path)
    assert result["nodes"]["intent"] == "visited"
    assert result["nodes"]["pricing_focus"] == "warning"
    assert result["edges"]["intent->pricing_focus"] == "visited"
    assert len(result["cards"]) == 1


@pytest.fixture(scope="module")
def error_body() -> str:
    """An inference that raised at the root: `started`, `error`, `done`."""
    app = create_app(model_loader=lambda: fake_engine(fail_on_call=1))
    with TestClient(app) as client:
        response = client.post(
            "/api/analyze", files={"audio": ("utterance.wav", make_wav(1.0), "audio/wav")}
        )
    assert response.status_code == 200, response.text
    return response.text


@requires_node
def test_error_event_leaves_a_recoverable_state(error_body: str, tmp_path: Path) -> None:
    result = run_harness(error_body, tmp_path)
    assert [name for name, _ in result["frames"]] == ["started", "error", "done"]
    assert "intent" in result["error"]["message"]
    assert result["failure"] is None
    assert result["running"] is False


@requires_node
def test_rejected_audio_surfaces_the_backends_detail(happy_body: str, tmp_path: Path) -> None:
    result = run_harness(happy_body, tmp_path, "--status=400")
    assert result["failure"]["isAnalyzeError"] is True
    assert result["failure"]["message"] == (
        "Audio must be 16000 Hz mono; received 44100 Hz stereo."
    )
    assert result["frames"] == []


@requires_node
def test_aborting_mid_stream_raises_an_abort_error(happy_body: str, tmp_path: Path) -> None:
    result = run_harness(happy_body, tmp_path, "--chunk=40", "--abort-after=2")
    assert result["failure"]["name"] == "AbortError"
    assert result["running"] is False


@requires_node
def test_reset_returns_the_whole_ui_to_its_initial_state(happy: dict[str, Any]) -> None:
    after = happy["afterReset"]
    assert after["nodes"] == ["idle"]
    assert after["edges"] == ["idle"]
    assert after["details"] is True
    assert after["cards"] == 0
    assert after["total"] == "Total: —"


@requires_node
def test_step_detail_formats_the_latency_as_an_integer(happy: dict[str, Any]) -> None:
    assert happy["stepDetail"] == ["Pricing question", "pricing_focus: plan_cost", "143 ms"]


@requires_node
def test_completed_result_is_labelled_with_the_leaf_it_reached(happy: dict[str, Any]) -> None:
    (completed,) = [data for name, data in happy["frames"] if name == "completed"]
    card = happy["result"]
    assert card["state"] == "completed"
    assert card["label"] == completed["label"]


@requires_node
def test_result_card_breadcrumb_names_the_chosen_options(happy: dict[str, Any]) -> None:
    # Option labels, not node labels: the breadcrumb reads as the conversation.
    assert happy["picks"] == [
        "pricing_question",
        "plan_cost_question",
        "pro_tier",
        "budget_objection",
    ]
    assert happy["result"]["path"] == (
        "Pricing question → Plan cost question → Pro tier → Budget objection"
    )


@requires_node
def test_result_card_shows_end_to_end_latency_in_monospace(happy: dict[str, Any]) -> None:
    (completed,) = [data for name, data in happy["frames"] if name == "completed"]
    # End-to-end, i.e. the request clock — not the trace column's inference-only total.
    assert happy["result"]["latency"] == f"{completed['total_latency_ms']} ms end to end"
    assert happy["result"]["latencyClass"] == "result-latency mono"
    assert completed["total_latency_ms"] >= completed["total_inference_ms"]


@requires_node
def test_result_card_renders_only_after_the_terminal_event(happy: dict[str, Any]) -> None:
    assert happy["resultEmpty"]["state"] == "empty"
    assert happy["resultEmpty"]["text"].startswith("The recommendation appears here")
    # Empty through `started` and every `step`; a card only once `completed` arrives.
    assert happy["resultStates"] == [
        ["started", "empty"],
        ["step", "empty"],
        ["step", "empty"],
        ["step", "empty"],
        ["step", "empty"],
        ["completed", "completed"],
        ["done", "completed"],
    ]


@requires_node
def test_unplaced_card_names_the_node_and_the_reason(
    unplaced_body: str, tmp_path: Path
) -> None:
    result = run_harness(unplaced_body, tmp_path)
    (unplaced,) = [data for name, data in result["frames"] if name == "unplaced"]
    card = result["result"]
    assert card["state"] == "unplaced"
    assert card["label"] == "Couldn't place this"
    # The node it stopped on, by its label, and the reason in plain language.
    assert unplaced["stopped_at_label"] in card["reason"]
    assert unplaced["reason"] == "none_of_these"
    assert "none of these options" in card["reason"]
    assert card["latency"] == f"{unplaced['total_latency_ms']} ms end to end"


@requires_node
def test_unplaced_run_shows_no_recommendation(unplaced_body: str, tmp_path: Path) -> None:
    """The model declined; inventing a next-best line here is the dishonesty to avoid."""
    result = run_harness(unplaced_body, tmp_path)
    assert result["result"]["recommendation"] is None
    assert result["result"]["rationale"] is None
    # Declined at the root, so no option was ever chosen either.
    assert result["result"]["path"] is None
    assert result["picks"] == []


@requires_node
def test_unplaced_card_keeps_the_breadcrumb_reached_so_far(tmp_path: Path) -> None:
    result = run_harness(analyze([HAPPY_SCRIPT[0], EMPTY_RESPONSE]), tmp_path)
    card = result["result"]
    assert card["state"] == "unplaced"
    assert card["path"] == "Pricing question"
    assert "Pricing concern" in card["reason"]
    assert "no answer" in card["reason"]
    assert card["recommendation"] is None


@requires_node
def test_unplaced_card_reports_an_unrecognized_tool(tmp_path: Path) -> None:
    result = run_harness(analyze([picks("not_a_real_option")]), tmp_path)
    (unplaced,) = [data for name, data in result["frames"] if name == "unplaced"]
    assert unplaced["reason"] == "unknown_tool"
    assert "does not offer" in result["result"]["reason"]


@requires_node
def test_every_backend_stop_reason_has_plain_language(happy: dict[str, Any]) -> None:
    """The four reasons the UI explains are exactly the four the backend can send."""
    assert set(happy["stopReasons"]) == set(get_args(StopReason))
    for reason, sentence in happy["reasonText"].items():
        assert sentence.startswith("Stopped at “Pricing concern”: ")
        assert reason != "something_new" or "something_new" in sentence
    # An unknown code still reads as a sentence rather than "undefined".
    assert "undefined" not in happy["reasonText"]["something_new"]


@requires_node
def test_error_event_renders_a_recoverable_card(error_body: str, tmp_path: Path) -> None:
    """`error` is a finished run, so it ends in a readable card — not a hung spinner."""
    result = run_harness(error_body, tmp_path)
    card = result["result"]
    assert card["state"] == "error"
    assert card["label"] == "Run failed"
    assert card["reason"] == result["error"]["message"]
    assert card["recommendation"] is None
    # No end-to-end figure: an `error` event carries no total.
    assert card["latency"] is None
    assert result["afterReset"]["result"]["state"] == "empty"


@requires_node
def test_reset_clears_the_result_card_and_the_breadcrumb(happy: dict[str, Any]) -> None:
    after = happy["afterReset"]
    assert after["picks"] == []
    assert after["result"]["state"] == "empty"
    assert after["result"]["text"].startswith("The recommendation appears here")


@requires_node
def test_breadcrumb_and_latency_formatting(happy: dict[str, Any]) -> None:
    assert happy["breadcrumb"] == {
        "three": "Pricing question → Pro tier → Budget objection",
        "one": "Not interested",
        "none": "",
    }
    assert happy["endToEnd"] == "498 ms end to end"
