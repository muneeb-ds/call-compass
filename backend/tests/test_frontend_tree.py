"""The browser's tree layout, checked from the backend.

The drawing has to come from the config and nothing else (PRD AC-4/AC-10: re-point the
demo by editing JSON only). So the assertions here run the *shipped* `frontend/tree.js`
under node against the real `config/tree.json` served by `GET /api/tree`, and against
mutated copies of it — a layout that silently ignored an edited label, or that assumed
the sample tree's uniform-looking shape, fails here rather than on a projector.

Same harness shape as the encoder, timer, and playback tests (`tree_fixture.mjs`).
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

from .fakes import fake_engine

HARNESS = Path(__file__).resolve().parent / "tree_fixture.mjs"
FRONTEND = Path(__file__).resolve().parents[2] / "frontend"

requires_node = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is needed to run the frontend tree layout"
)


def run_harness(config: Path, *args: str) -> dict[str, Any]:
    result = subprocess.run(
        ["node", str(HARNESS), str(config), *args], capture_output=True, check=True, text=True
    )
    parsed: dict[str, Any] = json.loads(result.stdout)
    return parsed


@pytest.fixture(scope="module")
def config() -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(default_config_path().read_text())
    return loaded


@pytest.fixture(scope="module")
def layout() -> dict[str, Any]:
    if shutil.which("node") is None:
        pytest.skip("node is needed to run the frontend tree layout")
    return run_harness(default_config_path())


def node(layout: dict[str, Any], node_id: str) -> dict[str, Any]:
    (found,) = [n for n in layout["nodes"] if n["id"] == node_id]
    assert isinstance(found, dict)
    return found


@requires_node
def test_every_configured_node_is_drawn_exactly_once(
    layout: dict[str, Any], config: dict[str, Any]
) -> None:
    drawn = [n["id"] for n in layout["nodes"]]

    assert sorted(drawn) == sorted(config["nodes"])
    assert len(drawn) == len(set(drawn)), "a shared `next` must not draw its target twice"


@requires_node
def test_levels_run_top_to_bottom_from_the_root(layout: dict[str, Any]) -> None:
    assert node(layout, "intent")["level"] == 0
    assert node(layout, "product_interest")["level"] == 1
    assert node(layout, "signal_check")["level"] == 2
    assert node(layout, "rec_budget")["level"] == 3
    assert layout["levels"] == 4

    for n in layout["nodes"]:
        other = [m for m in layout["nodes"] if m["level"] == n["level"] + 1]
        assert all(m["y"] > n["y"] for m in other), "a deeper node must sit lower"


@requires_node
def test_the_non_uniform_short_circuit_leaf_sits_at_its_own_level(
    layout: dict[str, Any],
) -> None:
    """rec_graceful_exit is a level-2 leaf whose siblings' subtrees reach level 4."""
    exit_leaf = node(layout, "rec_graceful_exit")

    assert exit_leaf["leaf"] is True
    assert exit_leaf["level"] == node(layout, "product_interest")["level"]
    assert exit_leaf["x"] != node(layout, "product_interest")["x"]


@requires_node
def test_leaves_are_marked_so_they_can_be_drawn_differently(
    layout: dict[str, Any], config: dict[str, Any]
) -> None:
    for n in layout["nodes"]:
        assert n["leaf"] is (config["nodes"][n["id"]]["type"] == "leaf")


@requires_node
def test_labels_come_from_the_config(layout: dict[str, Any], config: dict[str, Any]) -> None:
    for n in layout["nodes"]:
        assert n["label"] == config["nodes"][n["id"]]["label"]
        # The wrapped lines are what actually gets drawn, so they must carry the label.
        assert " ".join(n["lines"]) == n["label"]


@requires_node
def test_one_edge_per_node_pair_carrying_the_options_that_share_it(
    layout: dict[str, Any],
) -> None:
    """Two level-1 options lead to product_interest; that is one edge, not two."""
    assert len(layout["edgeKeys"]) == len(set(layout["edgeKeys"]))

    (shared,) = [e for e in layout["edges"] if e["key"] == "intent->product_interest"]
    assert shared["options"] == ["pricing_question", "feature_question"]

    (exit_edge,) = [e for e in layout["edges"] if e["to"] == "rec_graceful_exit"]
    assert exit_edge["options"] == ["not_interested"]


@requires_node
def test_edges_connect_the_boxes_they_claim_to(layout: dict[str, Any]) -> None:
    for edge in layout["edges"]:
        parent, child = node(layout, edge["from"]), node(layout, edge["to"])
        assert edge["y1"] == parent["y"] + parent["height"]
        assert edge["y2"] == child["y"]
        assert edge["y2"] > edge["y1"], "an edge must point downward"
        assert edge["x1"] == pytest.approx(parent["x"] + parent["width"] / 2)


@requires_node
def test_siblings_do_not_overlap_and_everything_fits_the_viewbox(
    layout: dict[str, Any],
) -> None:
    for level in range(layout["levels"]):
        row = sorted((n for n in layout["nodes"] if n["level"] == level), key=lambda n: n["x"])
        for left, right in zip(row, row[1:], strict=False):
            assert left["x"] + left["width"] <= right["x"] + 1e-9

    for n in layout["nodes"]:
        assert n["x"] >= 0 and n["x"] + n["width"] <= layout["width"] + 1e-9
        assert n["y"] >= 0 and n["y"] + n["height"] <= layout["height"] + 1e-9


@requires_node
def test_editing_a_label_changes_the_drawing_with_no_code_edit(
    layout: dict[str, Any], config: dict[str, Any], tmp_path: Path
) -> None:
    edited = json.loads(json.dumps(config))
    edited["nodes"]["signal_check"]["label"] = "Renamed by the operator"
    path = tmp_path / "tree.json"
    path.write_text(json.dumps(edited))

    after = run_harness(path)

    assert node(after, "signal_check")["label"] == "Renamed by the operator"
    # Only the text changed: the geometry is a function of the graph's shape.
    assert [n["x"] for n in after["nodes"]] == [n["x"] for n in layout["nodes"]]
    assert (after["width"], after["height"]) == (layout["width"], layout["height"])


@requires_node
def test_layout_follows_a_restructured_tree(config: dict[str, Any], tmp_path: Path) -> None:
    """No hardcoded coordinates: a new level has to push the drawing taller."""
    edited = json.loads(json.dumps(config))
    edited["nodes"]["rec_budget"] = {
        "id": "rec_budget",
        "type": "branch",
        "label": "Budget follow-up",
        "level": 4,
        "prompt_hint": "Who holds the budget?",
        "options": [
            {
                "tool_name": "needs_champion",
                "description": "They need someone internal to carry it.",
                "argument": {"name": "who", "enum": ["manager", "finance"], "description": "Who."},
                "next": "rec_timing",
            }
        ],
    }
    path = tmp_path / "tree.json"
    path.write_text(json.dumps(edited))

    after = run_harness(path)

    assert node(after, "rec_budget")["leaf"] is False
    # rec_timing now has a second, deeper parent, so it drops below rec_budget.
    assert node(after, "rec_timing")["level"] == node(after, "rec_budget")["level"] + 1
    assert after["levels"] == 5
    assert "rec_budget->rec_timing" in after["edgeKeys"]


@requires_node
def test_long_labels_wrap_instead_of_overflowing(layout: dict[str, Any]) -> None:
    assert layout["wrap"]["short"] == ["Customer intent"]
    assert len(layout["wrap"]["long"]) == 3
    assert layout["wrap"]["long"][-1].endswith("…"), "an over-long label is truncated, not clipped"
    assert all(len(line) <= 21 for line in layout["wrap"]["long"])
    assert layout["wrap"]["empty"] == [""]


@requires_node
def test_layout_matches_the_tree_the_backend_serves(layout: dict[str, Any]) -> None:
    with TestClient(create_app(model_loader=fake_engine)) as client:
        served = client.get("/api/tree").json()

    assert sorted(n["id"] for n in layout["nodes"]) == sorted(served["nodes"])


@pytest.fixture(scope="module")
def drawn() -> dict[str, Any]:
    if shutil.which("node") is None:
        pytest.skip("node is needed to run the frontend tree view")
    found: dict[str, Any] = run_harness(default_config_path(), "--draw")["drawn"]
    return found


@requires_node
def test_every_node_is_drawn_dimmed_and_unvisited(drawn: dict[str, Any]) -> None:
    """The initial state the whole demo starts from: nothing visited yet."""
    assert {n["state"] for n in drawn["nodes"]} == {"idle"}
    assert {e["state"] for e in drawn["edges"]} == {"idle"}


@requires_node
def test_leaves_are_drawn_as_a_distinct_shape(drawn: dict[str, Any]) -> None:
    """Pills for recommendations, soft rectangles for branches."""
    radii = {n["kind"]: n["rx"] for n in drawn["nodes"]}

    assert radii["leaf"] > radii["branch"]
    assert {n["kind"] for n in drawn["nodes"]} == {"leaf", "branch"}


@requires_node
def test_drawing_labels_every_node_and_the_svg_itself(drawn: dict[str, Any]) -> None:
    assert all(n["lines"] and all(n["lines"]) for n in drawn["nodes"])
    assert drawn["ariaLabel"] == "Decision tree northbeam-saas-v1"
    # A viewBox rather than pixel sizes: the column scales the drawing.
    assert drawn["viewBox"].startswith("0 0 ")


@requires_node
def test_edges_are_drawn_behind_the_nodes_as_curves(drawn: dict[str, Any]) -> None:
    assert drawn["layers"] == ["tree-edges", "tree-nodes"]
    assert {e["d"] for e in drawn["edges"]} == {"MC"}


@requires_node
def test_rerendering_replaces_rather_than_accumulates(drawn: dict[str, Any]) -> None:
    assert drawn["nodeCountAfterRerender"] == len(drawn["nodes"])
    assert drawn["layersAfterRerender"] == 2


@requires_node
def test_reset_returns_every_node_to_dimmed(drawn: dict[str, Any]) -> None:
    """US-016 drives this between demo runs."""
    assert drawn["statesAfterReset"] == ["idle"]
    assert drawn["hasNodeLookup"] is True


def test_frontend_ships_the_tree_module_with_no_hardcoded_node_ids() -> None:
    """app.js imports it at runtime, and the layout must not know this tree."""
    source = (FRONTEND / "tree.js").read_text()
    config = json.loads(default_config_path().read_text())

    assert 'id="tree-canvas"' in (FRONTEND / "index.html").read_text()
    for node_id in config["nodes"]:
        assert node_id not in source
