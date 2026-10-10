"""Tests for the tree config schema, validation, and loader."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from callcompass.tree import (
    NONE_OF_THESE,
    BranchNode,
    LeafNode,
    TreeConfigError,
    default_config_path,
    load_tree,
    parse_tree,
)


def _valid_config() -> dict[str, Any]:
    """A minimal valid tree: one branch root with two options, one branch and one leaf."""
    return {
        "tree_id": "test-v1",
        "version": "1.0.0",
        "product": "Test product",
        "root": "intent",
        "nodes": {
            "intent": {
                "id": "intent",
                "type": "branch",
                "label": "Customer intent",
                "level": 1,
                "prompt_hint": "What is the customer doing?",
                "options": [
                    {
                        "tool_name": "pricing_question",
                        "description": "Asking about price.",
                        "argument": {
                            "name": "pricing_focus",
                            "enum": ["plan_cost", "discount"],
                            "description": "The pricing concern.",
                        },
                        "next": "signal",
                    },
                    {
                        "tool_name": "not_interested",
                        "description": "Declining.",
                        "argument": {
                            "name": "decline_tone",
                            "enum": ["firm", "soft"],
                            "description": "How firmly.",
                        },
                        "next": "rec_exit",
                    },
                ],
            },
            "signal": {
                "id": "signal",
                "type": "branch",
                "label": "Objection",
                "level": 2,
                "options": [
                    {
                        "tool_name": "budget_objection",
                        "description": "Too expensive.",
                        "argument": {
                            "name": "budget_blocker",
                            "enum": ["too_expensive"],
                            "description": "The obstacle.",
                        },
                        "next": "rec_budget",
                    }
                ],
            },
            "rec_budget": {
                "id": "rec_budget",
                "type": "leaf",
                "label": "Reframe on value",
                "level": 3,
                "recommendation": "Move from price to cost-of-delay.",
                "rationale": "Budget objections are about unproven value.",
            },
            "rec_exit": {
                "id": "rec_exit",
                "type": "leaf",
                "label": "Exit cleanly",
                "level": 2,
                "recommendation": "Thank them and close without pressure.",
            },
        },
    }


def _parse(config: dict[str, Any]) -> Any:
    return parse_tree(json.dumps(config))


# --- valid tree ------------------------------------------------------------------


def test_valid_tree_parses() -> None:
    tree = _parse(_valid_config())

    assert tree.tree_id == "test-v1"
    assert tree.root == "intent"
    assert tree.node_count == 4

    root = tree.branch("intent")
    assert isinstance(root, BranchNode)
    assert [option.tool_name for option in root.options] == [
        "pricing_question",
        "not_interested",
    ]
    assert root.options[0].argument.enum == ["plan_cost", "discount"]

    exit_leaf = tree.nodes["rec_exit"]
    assert isinstance(exit_leaf, LeafNode)
    assert exit_leaf.rationale is None  # rationale is optional


def test_non_uniform_depth_is_allowed() -> None:
    """A level-2 leaf alongside a level-3 subtree is valid, not a validation error."""
    tree = _parse(_valid_config())

    assert tree.nodes["rec_exit"].level == 2
    assert tree.nodes["rec_budget"].level == 3


def test_branch_helper_rejects_a_leaf() -> None:
    tree = _parse(_valid_config())

    with pytest.raises(TreeConfigError, match="expected a branch node"):
        tree.branch("rec_exit")


# --- invalid trees ---------------------------------------------------------------


def test_rejects_missing_next_pointer() -> None:
    config = _valid_config()
    config["nodes"]["signal"]["options"][0]["next"] = "rec_nonexistent"

    with pytest.raises(TreeConfigError) as excinfo:
        _parse(config)

    message = str(excinfo.value)
    assert "\n" not in message
    assert "signal" in message
    assert "rec_nonexistent" in message


def test_rejects_duplicate_node_id() -> None:
    # Duplicate keys must be caught during JSON decoding; a dict would silently dedupe.
    raw = json.dumps(_valid_config())
    duplicate = '"signal": {"id": "signal", "type": "leaf", "label": "Dup", "level": 9,'
    duplicate += ' "recommendation": "Dup."}, "signal":'
    raw = raw.replace('"signal":', duplicate, 1)

    with pytest.raises(TreeConfigError) as excinfo:
        parse_tree(raw)

    assert "signal" in str(excinfo.value)
    assert "duplicate" in str(excinfo.value)


def test_rejects_cycle() -> None:
    config = _valid_config()
    config["nodes"]["signal"]["options"][0]["next"] = "intent"

    with pytest.raises(TreeConfigError) as excinfo:
        _parse(config)

    assert "cycle" in str(excinfo.value)
    assert "\n" not in str(excinfo.value)


def test_rejects_branch_with_zero_options() -> None:
    config = _valid_config()
    config["nodes"]["signal"]["options"] = []

    with pytest.raises(TreeConfigError) as excinfo:
        _parse(config)

    message = str(excinfo.value)
    assert "signal" in message
    assert "\n" not in message


def test_rejects_id_mismatching_map_key() -> None:
    config = _valid_config()
    config["nodes"]["signal"]["id"] = "signal_check"

    with pytest.raises(TreeConfigError, match="does not match its map key"):
        _parse(config)


def test_rejects_root_absent_from_nodes() -> None:
    config = _valid_config()
    config["root"] = "no_such_node"

    with pytest.raises(TreeConfigError, match="no_such_node"):
        _parse(config)


def test_rejects_leaf_without_recommendation() -> None:
    config = _valid_config()
    del config["nodes"]["rec_exit"]["recommendation"]

    with pytest.raises(TreeConfigError) as excinfo:
        _parse(config)

    assert "rec_exit" in str(excinfo.value)


def test_rejects_duplicate_tool_name_within_one_node() -> None:
    config = _valid_config()
    options = config["nodes"]["intent"]["options"]
    options[1]["tool_name"] = options[0]["tool_name"]

    with pytest.raises(TreeConfigError, match="duplicate tool_name"):
        _parse(config)


def test_rejects_argument_with_empty_enum() -> None:
    config = _valid_config()
    config["nodes"]["signal"]["options"][0]["argument"]["enum"] = []

    with pytest.raises(TreeConfigError) as excinfo:
        _parse(config)

    assert "signal" in str(excinfo.value)


def test_rejects_argument_with_no_enum_field() -> None:
    config = _valid_config()
    del config["nodes"]["signal"]["options"][0]["argument"]["enum"]

    with pytest.raises(TreeConfigError) as excinfo:
        _parse(config)

    assert "signal" in str(excinfo.value)


def test_rejects_configured_none_of_these_tool() -> None:
    config = _valid_config()
    config["nodes"]["signal"]["options"][0]["tool_name"] = NONE_OF_THESE

    with pytest.raises(TreeConfigError) as excinfo:
        _parse(config)

    assert NONE_OF_THESE in str(excinfo.value)
    assert "signal" in str(excinfo.value)


# --- loader --------------------------------------------------------------------


def test_load_tree_rejects_malformed_json(tmp_path: Path) -> None:
    path = tmp_path / "tree.json"
    path.write_text("{not json", encoding="utf-8")

    with pytest.raises(TreeConfigError, match="not valid JSON"):
        load_tree(path)


def test_load_tree_reports_a_missing_file(tmp_path: Path) -> None:
    with pytest.raises(TreeConfigError, match="could not be read"):
        load_tree(tmp_path / "absent.json")


# --- the shipped sample tree ---------------------------------------------------


def test_sample_tree_loads_and_matches_the_prd() -> None:
    tree = load_tree(default_config_path())

    assert tree.tree_id == "northbeam-saas-v1"
    assert tree.root == "intent"
    assert tree.node_count == 8

    # The level-2 short-circuit leaf: not_interested skips straight to a recommendation.
    graceful_exit = tree.nodes["rec_graceful_exit"]
    assert isinstance(graceful_exit, LeafNode)
    assert graceful_exit.level == 2

    intent = tree.branch("intent")
    not_interested = next(o for o in intent.options if o.tool_name == "not_interested")
    assert not_interested.next == "rec_graceful_exit"

    assert [o.tool_name for o in tree.branch("signal_check").options] == [
        "budget_objection",
        "timing_objection",
        "competitor_objection",
        "buying_signal",
    ]


def test_sample_tree_has_no_configured_none_of_these() -> None:
    tree = load_tree(default_config_path())

    for node in tree.nodes.values():
        if isinstance(node, BranchNode):
            assert all(option.tool_name != NONE_OF_THESE for option in node.options)
