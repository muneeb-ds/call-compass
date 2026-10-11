"""The outcome strip, checked over a real traversal from the backend.

Same harness shape as `test_frontend_analysis.py`: one traversal runs through
`POST /api/analyze` with a scripted fake model, the response body is captured
verbatim, and the *shipped* `sse.js` / `trace.js` / `analysis.js` / `outcome.js` are
replayed over it under node (`outcome_fixture.mjs`). This mirrors the result-card
tests `result.js` carried before it was deleted in favour of the dock's single-line
strip.
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

from .fakes import EMPTY_RESPONSE, NONE_OF_THESE_CALL, fake_engine, make_wav, parse_sse, picks

HARNESS = Path(__file__).resolve().parent / "outcome_fixture.mjs"

#: The sample tree's deepest route: intent -> pricing_focus -> tier_fit ->
#: objection_or_signal -> out_value_reframe. Four inferences, one per branch node.
HAPPY_SCRIPT = [
    picks("pricing_question", pricing_focus="plan_cost"),
    picks("plan_cost_question", cost_frame="per_seat"),
    picks("pro_tier", tier_signal="team_size"),
    picks("budget_objection", objection_strength="hard"),
]

requires_node = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is needed to run the outcome strip"
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


def run_harness(body: str, tmp_path: Path) -> dict[str, Any]:
    """Replays `body` through the shipped outcome strip under node."""
    sse = tmp_path / "stream.sse"
    sse.write_text(body)
    result = subprocess.run(
        ["node", str(HARNESS), str(default_config_path()), str(sse)],
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
    """Declined at the root: zero steps, so a total still shows."""
    return analyze([NONE_OF_THESE_CALL])


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


@pytest.fixture
def happy(happy_body: str, tmp_path: Path) -> dict[str, Any]:
    if shutil.which("node") is None:
        pytest.skip("node is needed to run the outcome strip")
    return run_harness(happy_body, tmp_path)


@requires_node
def test_strip_is_absent_before_the_first_terminal_event(happy: dict[str, Any]) -> None:
    assert happy["stripEmpty"] == {"state": None, "children": 0}
    # Absent through `started` and every `step`; drawn only once `completed` arrives.
    assert happy["stripStates"] == [
        ["started", None],
        ["step", None],
        ["step", None],
        ["step", None],
        ["step", None],
        ["completed", "completed"],
        ["done", "completed"],
    ]


@requires_node
def test_completed_strip_is_labelled_with_the_leaf_it_reached(
    happy: dict[str, Any], happy_body: str
) -> None:
    (completed,) = [data for name, data in parse_sse(happy_body) if name == "completed"]
    strip = happy["strip"]
    assert strip["state"] == "completed"
    assert strip["label"] == completed["label"]


@requires_node
def test_completed_strip_breadcrumb_names_the_chosen_options(happy: dict[str, Any]) -> None:
    # Option labels, not node labels: the breadcrumb reads as the conversation.
    assert happy["picks"] == [
        "pricing_question",
        "plan_cost_question",
        "pro_tier",
        "budget_objection",
    ]
    assert happy["strip"]["path"] == (
        "Pricing question → Plan cost question → Pro tier → Budget objection"
    )


@requires_node
def test_completed_strip_shows_the_inference_count_and_end_to_end_latency(
    happy: dict[str, Any],
) -> None:
    strip = happy["strip"]
    assert strip["count"] == "4 inferences"
    assert strip["latency"].endswith(" ms end to end")


@requires_node
def test_reset_clears_the_strip_and_the_breadcrumb(happy: dict[str, Any]) -> None:
    assert happy["afterReset"] == {"state": None, "children": 0}


@requires_node
def test_unplaced_strip_names_the_node_and_the_reason(
    unplaced_body: str, tmp_path: Path
) -> None:
    result = run_harness(unplaced_body, tmp_path)
    strip = result["strip"]
    assert strip["state"] == "unplaced"
    # No leaf label at all - the model declined, so there is no outcome to name.
    assert strip["label"] == "Couldn't place this"
    assert "none of these options" in strip["reason"]
    assert strip["latency"].endswith(" ms end to end")
    # Declined at the root, so no option was ever chosen.
    assert strip["path"] is None
    assert result["picks"] == []


@requires_node
def test_unplaced_strip_keeps_the_breadcrumb_reached_so_far(tmp_path: Path) -> None:
    result = run_harness(analyze([HAPPY_SCRIPT[0], EMPTY_RESPONSE]), tmp_path)
    strip = result["strip"]
    assert strip["state"] == "unplaced"
    assert strip["path"] == "Pricing question"
    assert "Pricing concern" in strip["reason"]
    assert "no answer" in strip["reason"]


@requires_node
def test_unplaced_strip_reports_an_unrecognized_tool(tmp_path: Path) -> None:
    result = run_harness(analyze([picks("not_a_real_option")]), tmp_path)
    assert "does not offer" in result["strip"]["reason"]


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
def test_error_strip_is_a_recoverable_end_state(error_body: str, tmp_path: Path) -> None:
    """`error` is a finished run, so it ends in a readable strip - not a hung spinner."""
    result = run_harness(error_body, tmp_path)
    strip = result["strip"]
    assert strip["state"] == "error"
    assert strip["label"] == "Run failed"
    assert strip["reason"] == result["error"]["message"]
    # No end-to-end figure: an `error` event carries no total.
    assert strip["latency"] is None
    assert result["afterReset"] == {"state": None, "children": 0}


@requires_node
def test_breadcrumb_and_latency_formatting(happy: dict[str, Any]) -> None:
    assert happy["breadcrumb"] == {
        "three": "Pricing question → Pro tier → Budget objection",
        "one": "Not interested",
        "none": "",
    }
    assert happy["endToEnd"] == "498 ms end to end"
    assert happy["inferenceCount"] == {"one": "1 inference", "many": "4 inferences"}
