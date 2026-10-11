"""The status bar's position readout, checked over a real traversal from the backend.

Same harness shape as `test_frontend_outcome.py`: one traversal runs through
`POST /api/analyze` with a scripted fake model, the response body is captured
verbatim, and the *shipped* `sse.js` / `trace.js` / `analysis.js` / `position.js` are
replayed over it under node (`position_fixture.mjs`), against the real
`config/tree.json` layout — so `Depth D of T` is pinned against the tree's actual
shape, not a hand-picked number.
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

HARNESS = Path(__file__).resolve().parent / "position_fixture.mjs"

#: The sample tree's deepest route: intent -> pricing_focus -> tier_fit ->
#: objection_or_signal -> out_value_reframe. Five levels deep (T=5), four inferences.
HAPPY_SCRIPT = [
    picks("pricing_question", pricing_focus="plan_cost"),
    picks("plan_cost_question", cost_frame="per_seat"),
    picks("pro_tier", tier_signal="team_size"),
    picks("budget_objection", objection_strength="hard"),
]

requires_node = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is needed to run the position readout"
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
    """Replays `body` through the shipped position readout under node."""
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
    """Declined at the root: the readout freezes on the root, not off the tree."""
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
        pytest.skip("node is needed to run the position readout")
    return run_harness(happy_body, tmp_path)


@requires_node
def test_before_a_run_shows_the_root_at_depth_one_with_no_inference_count(
    happy: dict[str, Any],
) -> None:
    assert happy["beforeRun"] == "Customer intent · Depth 1 of 5"


@requires_node
def test_maxdepth_comes_from_the_layouts_own_levels(happy: dict[str, Any]) -> None:
    assert happy["maxDepth"] == 5


@requires_node
def test_the_frontier_advances_depth_and_inference_count_one_node_at_a_time(
    happy: dict[str, Any],
) -> None:
    assert happy["readings"][:5] == [
        "Customer intent · Depth 1 of 5 · inference 1",
        "Pricing concern · Depth 2 of 5 · inference 2",
        "Tier fit · Depth 3 of 5 · inference 3",
        "Objection or buying signal · Depth 4 of 5 · inference 4",
        "Budget objection · Depth 5 of 5 · inference 5",
    ]


@requires_node
def test_the_terminal_event_freezes_on_the_backends_authoritative_inference_count(
    happy: dict[str, Any],
) -> None:
    # The client's own running count reached 5 by activating the leaf as the frontier;
    # the backend's `completed.inference_count` (4, one per branch node actually
    # called) overrides it, because that figure — not the client's guess — is
    # authoritative.
    assert happy["readings"][-1] == "Budget objection · Depth 5 of 5 · inference 4"
    assert happy["afterRun"] == happy["readings"][-1]


@requires_node
def test_a_reset_returns_to_the_pre_run_root_statement(happy: dict[str, Any]) -> None:
    assert happy["afterReset"] == happy["beforeRun"]


@requires_node
def test_an_unplaced_run_freezes_on_the_node_it_stopped_at(
    unplaced_body: str, tmp_path: Path
) -> None:
    result = run_harness(unplaced_body, tmp_path)
    assert result["afterRun"] == "Customer intent · Depth 1 of 5 · inference 1"


@requires_node
def test_an_error_freezes_on_the_failing_node(error_body: str, tmp_path: Path) -> None:
    result = run_harness(error_body, tmp_path)
    assert result["afterRun"] == "Customer intent · Depth 1 of 5 · inference 1"


@requires_node
def test_formatposition_omits_the_inference_segment_when_no_count_is_given(
    happy: dict[str, Any],
) -> None:
    assert happy["formatNoCount"] == "Intent · Depth 1 of 5"


@requires_node
def test_formatposition_includes_the_inference_segment_when_a_count_is_given(
    happy: dict[str, Any],
) -> None:
    assert happy["formatWithCount"] == "Intent · Depth 1 of 5 · inference 3"
