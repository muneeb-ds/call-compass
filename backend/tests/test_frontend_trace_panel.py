"""The trace rail and slide-over panel, checked over a real traversal from the backend.

Same harness shape as `test_frontend_analysis.py` / `test_frontend_outcome.py`: one
traversal runs through `POST /api/analyze` with a scripted fake model, the response
body is captured verbatim, and the *shipped* `sse.js` / `trace.js` / `analysis.js` /
`trace-panel.js` are replayed over it under node (`trace_panel_fixture.mjs`).
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

from .fakes import fake_engine, make_wav, picks

HARNESS = Path(__file__).resolve().parent / "trace_panel_fixture.mjs"

#: The sample tree's deepest route: intent -> pricing_focus -> tier_fit ->
#: objection_or_signal -> out_value_reframe. Four inferences, one per branch node.
HAPPY_SCRIPT = [
    picks("pricing_question", pricing_focus="plan_cost"),
    picks("plan_cost_question", cost_frame="per_seat"),
    picks("pro_tier", tier_signal="team_size"),
    picks("budget_objection", objection_strength="hard"),
]

requires_node = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is needed to run the trace rail/panel"
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


@pytest.fixture(scope="module")
def happy_body() -> str:
    return analyze(HAPPY_SCRIPT)


@pytest.fixture
def happy(happy_body: str, tmp_path: Path) -> dict[str, Any]:
    if shutil.which("node") is None:
        pytest.skip("node is needed to run the trace rail/panel")
    sse = tmp_path / "stream.sse"
    sse.write_text(happy_body)
    result = subprocess.run(
        ["node", str(HARNESS), str(default_config_path()), str(sse)],
        capture_output=True,
        check=True,
        text=True,
    )
    parsed: dict[str, Any] = json.loads(result.stdout)
    return parsed


@requires_node
def test_panel_starts_collapsed_with_no_chips(happy: dict[str, Any]) -> None:
    assert happy["initial"] == {
        "panelState": "collapsed",
        "toggleExpanded": "false",
        "chips": 0,
        "railTotal": "Total: —",
    }


@requires_node
def test_one_chip_per_step_with_index_and_latency(happy: dict[str, Any]) -> None:
    chips = happy["chips"]
    assert [chip["index"] for chip in chips] == ["0", "1", "2", "3"]
    assert [chip["label"] for chip in chips] == ["1", "2", "3", "4"]
    assert all(chip["latency"].endswith(" ms") for chip in chips)


@requires_node
def test_rail_total_matches_the_backends_own_figure(
    happy: dict[str, Any], happy_body: str
) -> None:
    (completed_line,) = [
        line for line in happy_body.split("\n\n") if line.startswith("event: completed")
    ]
    data = json.loads(completed_line.split("data: ", 1)[1])
    assert happy["railTotal"] == f"Total: {data['total_inference_ms']} ms"


@requires_node
def test_clicking_a_chip_reports_its_index(happy: dict[str, Any]) -> None:
    assert happy["selected"] == [0]


@requires_node
def test_toggle_opens_and_sets_aria_expanded(happy: dict[str, Any]) -> None:
    assert happy["afterToggleOpen"] == {"state": "open", "expanded": "true"}


@requires_node
def test_escape_closes_the_open_panel(happy: dict[str, Any]) -> None:
    assert happy["afterEscape"] == {"state": "collapsed", "expanded": "false"}


@requires_node
def test_toggle_reopens_after_escape(happy: dict[str, Any]) -> None:
    assert happy["reopened"] == {"state": "open", "expanded": "true"}


@requires_node
def test_reset_clears_the_rail_but_not_the_panels_open_state(happy: dict[str, Any]) -> None:
    after = happy["afterReset"]
    assert after["chips"] == 0
    assert after["railTotal"] == "Total: —"
    # The panel was left open by the toggle clicks above; a reset must not touch it.
    assert after["panelState"] == "open"
