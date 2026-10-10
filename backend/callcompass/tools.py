"""Converting one branch node into the tool list handed to `model.generate()`.

This module is deliberately tiny and pure: no model, no network, no filesystem. The
`neudecide` tool-schema shape is an external assumption (PRD R-6), so keeping the
conversion here means an upstream API change is a single-file edit.

The model only ever sees the options of the node currently being evaluated, plus the
backend-injected `none_of_these` escape tool.
"""

from __future__ import annotations

from .model import ToolSpec
from .tree import NONE_OF_THESE, BranchNode, Option

#: Description the model sees for the injected escape tool. Phrased as an explicit
#: permission to decline so a weak guess is less attractive than no answer (PRD R-3).
NONE_OF_THESE_DESCRIPTION = (
    "None of the other options describe what the customer said. "
    "Choose this when nothing above applies."
)


def none_of_these_tool() -> ToolSpec:
    """The synthetic escape tool. Takes no arguments, so it is always callable."""
    return {
        "name": NONE_OF_THESE,
        "description": NONE_OF_THESE_DESCRIPTION,
        "parameters": {"type": "object", "properties": {}, "required": []},
    }


def option_to_tool(option: Option) -> ToolSpec:
    """One configured option as a tool with a single enum-constrained argument.

    Note the enum is advisory at the grammar level — `neudecide` builds its decoding
    grammar from parameter *names* only — so callers must still check that the value
    the model returns is a member of `option.argument.enum`.
    """
    argument = option.argument
    return {
        "name": option.tool_name,
        "description": option.description,
        "parameters": {
            "type": "object",
            "properties": {
                argument.name: {
                    "type": "string",
                    "enum": list(argument.enum),
                    "description": argument.description,
                }
            },
            "required": [argument.name],
        },
    }


def node_to_tools(node: BranchNode) -> list[ToolSpec]:
    """The full tool list for one branch node: its options, then `none_of_these`.

    Pure function — the same node always yields the same list.
    """
    return [option_to_tool(option) for option in node.options] + [none_of_these_tool()]
