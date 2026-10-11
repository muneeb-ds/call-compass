"""Tests for node-to-tools conversion.

The exact-shape assertions on `intent` and `objection_or_signal` are intentional: they pin the
schema the model is given, so an accidental change to the tool format fails loudly here
rather than silently degrading inference quality.
"""

from __future__ import annotations

from callcompass.tools import (
    NONE_OF_THESE_DESCRIPTION,
    node_to_tools,
    none_of_these_tool,
    option_to_tool,
)
from callcompass.tree import NONE_OF_THESE, BranchNode, Tree, default_config_path, load_tree


def sample_tree() -> Tree:
    return load_tree(default_config_path())


def test_root_node_tool_list_exact_shape() -> None:
    tools = node_to_tools(sample_tree().branch("intent"))

    assert tools == [
        {
            "name": "pricing_question",
            "description": (
                "The customer is asking about price, plans, billing, or what a tier costs."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pricing_focus": {
                        "type": "string",
                        "enum": ["plan_cost", "billing_terms", "discount"],
                        "description": "The specific pricing concern raised.",
                    }
                },
                "required": ["pricing_focus"],
            },
        },
        {
            "name": "feature_question",
            "description": (
                "The customer is asking what the product does or whether it supports something."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "feature_area": {
                        "type": "string",
                        "enum": ["dashboards", "integrations", "data_export"],
                        "description": "The capability the customer asked about.",
                    }
                },
                "required": ["feature_area"],
            },
        },
        {
            "name": "competitor_mention",
            "description": (
                "The customer names another vendor or an alternative tool they use or are weighing."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "mention_context": {
                        "type": "string",
                        "enum": ["currently_using", "comparing", "under_contract"],
                        "description": "How the other tool came up.",
                    }
                },
                "required": ["mention_context"],
            },
        },
        {
            "name": "existing_account",
            "description": (
                "The speaker is already a customer, talking about the account they have "
                "rather than buying a new one."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "account_topic": {
                        "type": "string",
                        "enum": ["more_seats", "renewal", "not_working"],
                        "description": "What they raised about their existing account.",
                    }
                },
                "required": ["account_topic"],
            },
        },
        {
            "name": "buying_signal",
            "description": (
                "The customer is moving forward: asking about next steps, trials, demos, "
                "or paperwork."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "readiness": {
                        "type": "string",
                        "enum": ["wants_trial", "wants_demo", "ready_to_buy"],
                        "description": "How ready they are to proceed.",
                    }
                },
                "required": ["readiness"],
            },
        },
        {
            "name": "not_interested",
            "description": (
                "The customer is declining, deflecting, or asking to be left alone."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "decline_tone": {
                        "type": "string",
                        "enum": ["firm", "soft", "defer_to_later"],
                        "description": "How firmly the customer is declining.",
                    }
                },
                "required": ["decline_tone"],
            },
        },
        {
            "name": NONE_OF_THESE,
            "description": NONE_OF_THESE_DESCRIPTION,
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    ]


def test_mid_tree_node_tool_list_exact_shape() -> None:
    tools = node_to_tools(sample_tree().branch("objection_or_signal"))

    assert [tool["name"] for tool in tools] == [
        "budget_objection",
        "timing_objection",
        "competitor_objection",
        "ready_to_proceed",
        NONE_OF_THESE,
    ]
    assert tools[0] == {
        "name": "budget_objection",
        "description": (
            "The customer says it is too expensive or that budget is not available."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "budget_blocker": {
                    "type": "string",
                    "enum": ["too_expensive", "no_budget_this_quarter", "needs_approval"],
                    "description": "The nature of the budget obstacle.",
                }
            },
            "required": ["budget_blocker"],
        },
    }
    assert tools[-1] == none_of_these_tool()


def test_none_of_these_present_for_every_branch_node() -> None:
    tree = sample_tree()
    branches = [node for node in tree.nodes.values() if isinstance(node, BranchNode)]
    assert branches, "sample tree must have branch nodes"

    for node in branches:
        tools = node_to_tools(node)
        names = [tool["name"] for tool in tools]
        assert names.count(NONE_OF_THESE) == 1, node.id
        # Always last, so the escape hatch reads as the fallback rather than an option.
        assert names[-1] == NONE_OF_THESE, node.id


def test_tool_list_covers_exactly_the_nodes_options() -> None:
    for node_id in ("intent", "pricing_focus", "tier_fit", "objection_or_signal"):
        node = sample_tree().branch(node_id)
        names = [tool["name"] for tool in node_to_tools(node)]
        assert names == [option.tool_name for option in node.options] + [NONE_OF_THESE]


def test_each_argument_enum_matches_its_option_exactly() -> None:
    tree = sample_tree()
    for node in tree.nodes.values():
        if not isinstance(node, BranchNode):
            continue
        for option in node.options:
            tool = option_to_tool(option)
            properties = tool["parameters"]["properties"]
            assert list(properties) == [option.argument.name]
            assert properties[option.argument.name]["enum"] == option.argument.enum
            assert tool["parameters"]["required"] == [option.argument.name]


def test_none_of_these_requires_no_arguments() -> None:
    tool = none_of_these_tool()
    assert tool["parameters"]["properties"] == {}
    assert tool["parameters"]["required"] == []


def test_conversion_is_pure() -> None:
    """Same node in, equal-but-independent lists out; mutating one must not leak."""
    node = sample_tree().branch("intent")
    first = node_to_tools(node)
    second = node_to_tools(node)
    assert first == second

    first[0]["parameters"]["properties"]["pricing_focus"]["enum"].append("mutated")
    assert node_to_tools(node) == second


def test_shape_is_understood_by_neudecides_own_grammar_helper() -> None:
    """Guards PRD R-6: our tool schema must parse the way the real package reads it.

    `tool_parameters` is what `neudecide` uses to build the decoding grammar, so if it
    cannot see our argument names the model could not emit them.
    """
    from neudecide.grammar import tool_parameters

    node = sample_tree().branch("intent")
    assert tool_parameters(node_to_tools(node)) == {
        "pricing_question": ["pricing_focus"],
        "feature_question": ["feature_area"],
        "competitor_mention": ["mention_context"],
        "existing_account": ["account_topic"],
        "buying_signal": ["readiness"],
        "not_interested": ["decline_tone"],
        NONE_OF_THESE: [],
    }


def test_enum_list_is_a_copy_of_the_config_list() -> None:
    node = sample_tree().branch("intent")
    option = node.options[0]
    tool = option_to_tool(option)
    tool["parameters"]["properties"][option.argument.name]["enum"].append("mutated")
    assert "mutated" not in option.argument.enum
