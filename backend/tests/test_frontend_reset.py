"""The Reset button, checked over two consecutive real traversals.

Same harness shape as the other frontend tests: one traversal runs through
`POST /api/analyze` with a scripted fake model, the response body is captured
verbatim, and the *shipped* `reset.js` / `analysis.js` / `trace.js` / `result.js` are
driven over it under node (`reset_fixture.mjs`).

The assertions that matter here are sequential. "Reset clears the run" is easy to get
right for one run; what breaks a repeated demo is the *second* run stacking on the
first, and that is only observable by running, resetting, and running again — which is
exactly what the fixture does.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from callcompass.main import create_app
from callcompass.tree import default_config_path

from .fakes import NONE_OF_THESE_CALL, fake_engine, make_wav, picks

HARNESS = Path(__file__).resolve().parent / "reset_fixture.mjs"

#: The sample tree's deepest route: intent -> pricing_focus -> tier_fit ->
#: objection_or_signal -> out_value_reframe. Four inferences, one per branch node.
HAPPY_SCRIPT = [
    picks("pricing_question", pricing_focus="plan_cost"),
    picks("plan_cost_question", cost_frame="per_seat"),
    picks("pro_tier", tier_signal="team_size"),
    picks("budget_objection", objection_strength="hard"),
]

requires_node = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is needed to run the frontend reset control"
)


def analyze(script: list[list[dict[str, Any]]]) -> str:
    """One traversal's SSE response body, exactly as the browser would receive it.

    The fixture replays this same body for both of its runs, so one traversal is all
    that is needed — and it also makes "the second run is identical" assertable.
    """
    app = create_app(model_loader=lambda: fake_engine(script))
    with TestClient(app) as client:
        response = client.post(
            "/api/analyze", files={"audio": ("utterance.wav", make_wav(1.0), "audio/wav")}
        )
    assert response.status_code == 200, response.text
    return response.text


def run_harness(body: str, tmp_path: Path, *args: str) -> dict[str, Any]:
    """Drives the shipped Reset control through run / reset / run under node."""
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


@pytest.fixture
def cycle(happy_body: str, tmp_path: Path) -> dict[str, Any]:
    if shutil.which("node") is None:
        pytest.skip("node is needed to run the frontend reset control")
    return run_harness(happy_body, tmp_path)


@requires_node
def test_reset_is_disabled_until_a_run_has_finished(cycle: dict[str, Any]) -> None:
    assert cycle["initial"]["armed"] is False
    assert cycle["initial"]["disabled"] is True
    # Still disabled as `started` and every `step` arrive; live only once the terminal
    # event lands. The button is grayed, not hidden — the column keeps its shape.
    assert cycle["armedPerFrame"] == [
        ["started", False],
        ["step", False],
        ["step", False],
        ["step", False],
        ["step", False],
        ["completed", True],
        ["done", True],
    ]


@requires_node
def test_reset_is_enabled_after_an_unplaced_run_too(tmp_path: Path) -> None:
    result = run_harness(analyze([NONE_OF_THESE_CALL]), tmp_path)
    assert result["afterFirstRun"]["terminal"] == "unplaced"
    assert result["afterFirstRun"]["armed"] is True


@requires_node
def test_reset_clears_the_recording_and_playback_control(cycle: dict[str, Any]) -> None:
    """The capture half is torn down through `capture.reset()`, exactly once."""
    assert cycle["afterFirstRun"]["captureResets"] == 0
    assert cycle["afterReset"]["captureResets"] == 1


@requires_node
def test_reset_clears_the_trace_column_and_the_total(cycle: dict[str, Any]) -> None:
    assert len(cycle["afterFirstRun"]["cards"]) == 4
    assert cycle["afterFirstRun"]["total"].startswith("Total: ")
    assert cycle["afterReset"]["cards"] == []
    assert cycle["afterReset"]["total"] == "Total: —"


@requires_node
def test_reset_returns_the_tree_to_its_fully_dimmed_state(cycle: dict[str, Any]) -> None:
    """No reload: the same drawn nodes go back to idle, and the annotations go away."""
    assert cycle["afterFirstRun"]["nodeStates"] == ["idle", "visited"]
    assert cycle["afterFirstRun"]["annotated"] == 4
    assert cycle["afterReset"]["nodeStates"] == ["idle"]
    assert cycle["afterReset"]["edgeStates"] == ["idle"]
    assert cycle["afterReset"]["annotated"] == 0
    # The nodes are still *there* — the tree was never re-fetched or re-rendered.
    assert set(cycle["afterReset"]["nodes"]) == set(cycle["afterFirstRun"]["nodes"])


@requires_node
def test_reset_clears_the_result_card(cycle: dict[str, Any]) -> None:
    assert cycle["afterFirstRun"]["result"]["state"] == "completed"
    assert cycle["afterReset"]["result"]["state"] == "empty"
    assert cycle["afterReset"]["picks"] == []
    assert cycle["afterReset"]["terminal"] is None


@requires_node
def test_reset_disarms_itself_and_a_second_press_does_nothing(cycle: dict[str, Any]) -> None:
    assert cycle["pressed"] is True
    assert cycle["afterReset"]["armed"] is False
    assert cycle["pressedAgain"] is False
    assert cycle["afterSecondPress"] == cycle["afterReset"]


@requires_node
def test_two_consecutive_runs_do_not_accumulate(happy_body: str, tmp_path: Path) -> None:
    """The second run's trace, total and path are the second run's alone."""
    result = run_harness(happy_body, tmp_path)
    first, second = result["afterFirstRun"], result["afterSecondRun"]
    assert second["cards"] == first["cards"]
    assert [card["index"] for card in second["cards"]] == ["0", "1", "2", "3"]
    assert second["total"] == first["total"]
    assert second["picks"] == first["picks"]
    assert second["nodes"] == first["nodes"]
    assert second["annotated"] == first["annotated"]
    assert second["result"] == first["result"]
    assert second["armed"] is True


@requires_node
def test_a_run_without_an_intervening_reset_still_does_not_accumulate(
    happy_body: str, tmp_path: Path
) -> None:
    """`Analysis.run()` resets first, so forgetting to press Reset is not a trap."""
    result = run_harness(happy_body, tmp_path, "--reset-after=99")
    assert result["pressed"] is True  # the reset-after never fired at frame 99
    assert len(result["afterSecondRun"]["cards"]) == 4


@requires_node
def test_reset_cancels_an_in_flight_stream(happy_body: str, tmp_path: Path) -> None:
    """Pressing Reset mid-run aborts the fetch and leaves the UI in its empty state."""
    result = run_harness(happy_body, tmp_path, "--chunk=40", "--arm-first", "--reset-after=2")
    # Armed from the start, as it would be after an earlier run.
    assert result["initial"]["armed"] is True
    assert result["firstFailure"]["name"] == "AbortError"
    # The stream is released, and nothing the cancelled run had drawn is still up.
    after = result["afterFirstRun"]
    assert after["running"] is False
    assert after["nodeStates"] == ["idle"]
    assert after["cards"] == []
    assert after["total"] == "Total: —"
    assert after["result"]["state"] == "empty"
    assert after["captureResets"] == 1
    # A cancelled run is not a finished one, so Reset went back to disabled.
    assert after["armed"] is False


@requires_node
def test_a_full_run_still_works_after_a_cancelled_one(happy_body: str, tmp_path: Path) -> None:
    result = run_harness(happy_body, tmp_path, "--chunk=40", "--arm-first", "--reset-after=2")
    second = result["afterSecondRun"]
    assert second["terminal"] == "completed"
    assert len(second["cards"]) == 4
    assert second["result"]["state"] == "completed"
    assert second["armed"] is True
