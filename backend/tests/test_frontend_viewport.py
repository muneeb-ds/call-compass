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


# --- Manual pan/zoom maths (US-024's second half: panBox/zoomBox/zoomBounds) --------

MANUAL_HARNESS = Path(__file__).resolve().parent / "viewport_manual_fixture.mjs"


def run_pan(box: dict[str, float], dx: float, dy: float) -> dict[str, float]:
    args = [str(box["x"]), str(box["y"]), str(box["width"]), str(box["height"]), str(dx), str(dy)]
    result = subprocess.run(
        ["node", str(MANUAL_HARNESS), "pan", *args], capture_output=True, check=True, text=True
    )
    parsed: dict[str, float] = json.loads(result.stdout)
    return parsed


def run_zoom(
    box: dict[str, float], factor: float, anchor_x: float, anchor_y: float, whole: dict[str, float]
) -> dict[str, Any]:
    args = [
        str(box["x"]),
        str(box["y"]),
        str(box["width"]),
        str(box["height"]),
        str(factor),
        str(anchor_x),
        str(anchor_y),
        str(whole["width"]),
        str(whole["height"]),
    ]
    result = subprocess.run(
        ["node", str(MANUAL_HARNESS), "zoom", *args], capture_output=True, check=True, text=True
    )
    parsed: dict[str, Any] = json.loads(result.stdout)
    return parsed


def run_bounds(whole: dict[str, float]) -> dict[str, float]:
    result = subprocess.run(
        ["node", str(MANUAL_HARNESS), "bounds", str(whole["width"]), str(whole["height"])],
        capture_output=True,
        check=True,
        text=True,
    )
    parsed: dict[str, float] = json.loads(result.stdout)
    return parsed


@requires_node
def test_pan_box_translates_without_changing_size() -> None:
    box = {"x": 100.0, "y": 50.0, "width": 400.0, "height": 200.0}
    panned = run_pan(box, 10.0, -5.0)

    assert panned == {"x": 110.0, "y": 45.0, "width": 400.0, "height": 200.0}


@requires_node
def test_zoom_in_keeps_the_anchor_point_at_the_same_fraction_of_the_box() -> None:
    """Zooming in around the box's own centre must leave the centre the centre."""
    box = {"x": 0.0, "y": 0.0, "width": 400.0, "height": 200.0}
    whole = {"width": 400.0, "height": 200.0}  # matches the box, so the clamp never bites
    result = run_zoom(box, 2.0, 200.0, 100.0, whole)
    zoomed = result["box"]

    assert zoomed["width"] == pytest.approx(200.0)
    assert zoomed["height"] == pytest.approx(100.0)
    assert zoomed["x"] + zoomed["width"] / 2 == pytest.approx(200.0)
    assert zoomed["y"] + zoomed["height"] / 2 == pytest.approx(100.0)


@requires_node
def test_zoom_in_can_be_clamped_to_the_minimum_width() -> None:
    """A huge zoom-in factor must not shrink the box below `zoomBounds`' floor."""
    box = {"x": 0.0, "y": 0.0, "width": 600.0, "height": 300.0}
    whole = {"width": 600.0, "height": 300.0}
    result = run_zoom(box, 1000.0, 300.0, 150.0, whole)

    assert result["box"]["width"] == pytest.approx(result["bounds"]["minWidth"])
    assert result["box"]["height"] == pytest.approx(result["bounds"]["minHeight"])


@requires_node
def test_zoom_out_cannot_exceed_the_whole_tree_fit() -> None:
    """Zooming out past the point where the whole tree already fits is a no-op past that bound."""
    box = {"x": 0.0, "y": 0.0, "width": 600.0, "height": 300.0}
    whole = {"width": 800.0, "height": 400.0}
    result = run_zoom(box, 0.01, 300.0, 150.0, whole)

    assert result["box"]["width"] == pytest.approx(result["bounds"]["maxWidth"])
    assert result["box"]["height"] == pytest.approx(result["bounds"]["maxHeight"])


@requires_node
def test_zoom_box_never_inverts_or_collapses_to_a_dot() -> None:
    whole = {"width": 1000.0, "height": 500.0}
    box = {"x": 0.0, "y": 0.0, "width": 1000.0, "height": 500.0}

    for factor in (1e6, 1e-6):
        result = run_zoom(box, factor, 500.0, 250.0, whole)
        assert result["box"]["width"] > 0
        assert result["box"]["height"] > 0


@requires_node
def test_zoom_bounds_scale_with_the_whole_tree_frame() -> None:
    small = run_bounds({"width": 600.0, "height": 300.0})
    large = run_bounds({"width": 1200.0, "height": 600.0})

    assert large["maxWidth"] == pytest.approx(small["maxWidth"] * 2)
    assert large["minWidth"] == pytest.approx(small["minWidth"] * 2)
