"""The stage camera's framing, checked from the backend.

`frameFor` in `frontend/viewport.js` is pure, so it is run the same way
`test_frontend_tree.py` runs `layoutTree`: under node, against the real
`config/tree.json` served by `GET /api/tree`, over the *shipped* module.

Same harness shape as `tree_fixture.mjs` (`viewport_fixture.mjs`).
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from callcompass.tree import default_config_path

HARNESS = Path(__file__).resolve().parent / "viewport_fixture.mjs"

requires_node = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is needed to run the frontend viewport framing"
)

ASPECT = 16 / 9


def run_harness(
    config: Path, node_id: str, aspect: float, zoom: float | None = None
) -> dict[str, Any]:
    args = [str(config), node_id, str(aspect)]
    if zoom is not None:
        args.append(str(zoom))
    result = subprocess.run(
        ["node", str(HARNESS), *args], capture_output=True, check=True, text=True
    )
    parsed: dict[str, Any] = json.loads(result.stdout)
    return parsed


@pytest.fixture(scope="module")
def config() -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(default_config_path().read_text())
    return loaded


@requires_node
def test_a_centred_node_is_framed_around_its_own_x(config: dict[str, Any]) -> None:
    """`intent` is the root: level 0, one row above it (none) and one below."""
    frame = run_harness(default_config_path(), "intent", ASPECT)["frame"]

    # The root sits at x=869 in the current layout; its box's horizontal centre must
    # land at the frame's horizontal centre, not merely somewhere inside the frame.
    assert frame["x"] + frame["width"] / 2 == pytest.approx(869 + 168 / 2, abs=1)
    assert frame["width"] / frame["height"] == pytest.approx(ASPECT, rel=1e-6)


@requires_node
def test_a_node_at_the_left_edge_is_still_centred_in_its_own_frame(config: dict[str, Any]) -> None:
    """`tier_fit` is the leftmost node in the widest (level-2) row."""
    frame = run_harness(default_config_path(), "tier_fit", ASPECT)["frame"]

    assert frame["x"] + frame["width"] / 2 == pytest.approx(24 + 168 / 2, abs=1)
    # Framing a node near the edge pans the viewBox's origin left of 0 — it is not
    # clamped to the tree's own bounds, which is left to the manual pan/zoom story.
    assert frame["x"] < 0


@requires_node
def test_a_node_at_the_right_edge_is_still_centred_in_its_own_frame(config: dict[str, Any]) -> None:
    """`out_send_proposal` is the rightmost node in the widest (level-2) row."""
    frame = run_harness(default_config_path(), "out_send_proposal", ASPECT)["frame"]

    assert frame["x"] + frame["width"] / 2 == pytest.approx(1714 + 168 / 2, abs=1)


@requires_node
def test_frame_always_matches_the_requested_aspect(config: dict[str, Any]) -> None:
    for node_id in ("intent", "pricing_focus", "out_graceful_exit", "out_value_reframe"):
        frame = run_harness(default_config_path(), node_id, ASPECT)["frame"]
        assert frame["width"] / frame["height"] == pytest.approx(ASPECT, rel=1e-6)


@requires_node
def test_whole_tree_fits_when_a_small_tree_needs_no_panning(tmp_path: Path) -> None:
    """Two levels of two nodes each: the default 3-row window already covers it all."""
    small = {
        "tree_id": "small",
        "root": "a",
        "nodes": {
            "a": {
                "type": "branch",
                "label": "A",
                "options": [
                    {"tool_name": "x", "next": "b"},
                    {"tool_name": "y", "next": "c"},
                ],
            },
            "b": {"type": "leaf", "label": "B"},
            "c": {"type": "leaf", "label": "C"},
        },
    }
    path = tmp_path / "small.json"
    path.write_text(json.dumps(small))

    result = run_harness(path, "a", ASPECT)
    frame, layout = result["frame"], result["layout"]

    assert frame["width"] >= layout["width"] - 1e-9
    assert frame["height"] >= layout["height"] - 1e-9
    # Whole-tree framing is centred on the tree, not on whichever node triggered it.
    assert frame["x"] + frame["width"] / 2 == pytest.approx(layout["width"] / 2, abs=1)
    assert frame["y"] + frame["height"] / 2 == pytest.approx(layout["height"] / 2, abs=1)


@requires_node
def test_the_sample_tree_does_not_jitter_identically_across_adjacent_nodes(
    config: dict[str, Any],
) -> None:
    """The real (26-node) tree is wide enough that auto-pan earns its keep: framing the
    root and framing a level-2 leaf must not collapse to the same whole-tree frame."""
    root_frame = run_harness(default_config_path(), "intent", ASPECT)["frame"]
    leaf_frame = run_harness(default_config_path(), "tier_fit", ASPECT)["frame"]

    assert (root_frame["x"], root_frame["y"]) != (leaf_frame["x"], leaf_frame["y"])


@requires_node
def test_an_unknown_node_id_falls_back_to_the_whole_tree(config: dict[str, Any]) -> None:
    result = run_harness(default_config_path(), "not-a-real-node", ASPECT)
    frame, layout = result["frame"], result["layout"]

    assert frame["width"] >= layout["width"] - 1e-9
    assert frame["height"] >= layout["height"] - 1e-9


def test_frontend_viewport_module_has_no_hardcoded_node_ids() -> None:
    frontend = Path(__file__).resolve().parents[2] / "frontend"
    source = (frontend / "viewport.js").read_text()
    config = json.loads(default_config_path().read_text())

    for node_id in config["nodes"]:
        assert node_id not in source
