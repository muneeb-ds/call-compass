"""Decision-tree config schema, validation, and loading.

The sales flow lives entirely in a JSON file (`config/tree.json`) so the demo can be
re-pointed at a different product without a code change. This module is the only place
that knows the config's shape; everything downstream consumes the Pydantic models.

Validation failures raise `TreeConfigError` with a single-line message that names the
offending node id wherever one can be identified.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

#: Tool injected by the backend at inference time so the model can decline to choose.
#: It must never appear in a config file.
NONE_OF_THESE = "none_of_these"

#: Hard cap on traversal depth, used to bound cycle-free trees as well.
MAX_DEPTH = 10


class TreeConfigError(Exception):
    """A tree config is structurally invalid. Message is always a single line."""


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ArgumentSpec(_Strict):
    """The single argument a tool exposes. Always enum-constrained."""

    name: str = Field(min_length=1)
    # Enum-only by construction: an argument with no allowed values is rejected here,
    # which is what keeps the model from returning free-form text.
    enum: list[str] = Field(min_length=1)
    description: str = Field(min_length=1)


class Option(_Strict):
    """One branch a node can take, exposed to the model as a tool."""

    tool_name: str = Field(min_length=1)
    description: str = Field(min_length=1)
    argument: ArgumentSpec
    next: str = Field(min_length=1)

    @model_validator(mode="after")
    def _reject_injected_tool(self) -> Option:
        if self.tool_name == NONE_OF_THESE:
            raise ValueError(
                f"tool_name '{NONE_OF_THESE}' is injected by the backend and must not be configured"
            )
        return self


class _NodeBase(_Strict):
    id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    level: int = Field(ge=1)
    prompt_hint: str | None = None


class BranchNode(_NodeBase):
    """A node where the model picks one of several tools."""

    type: Literal["branch"]
    options: list[Option] = Field(min_length=1)

    @model_validator(mode="after")
    def _reject_duplicate_tool_names(self) -> BranchNode:
        # Raised as TreeConfigError rather than ValueError: this validator knows the node
        # id, so it can produce the final single-line message itself. Pydantic lets
        # non-ValueError exceptions propagate untouched.
        seen: set[str] = set()
        for option in self.options:
            if option.tool_name in seen:
                raise TreeConfigError(
                    f"node '{self.id}': duplicate tool_name '{option.tool_name}'"
                )
            seen.add(option.tool_name)
        return self


class LeafNode(_NodeBase):
    """A terminal node: the classification outcome a traversal landed on.

    It carries a `label` and nothing else. A leaf is deliberately *not* a place to
    put advice for the operator to read out — `extra="forbid"` on `_Strict` means a
    config still declaring either of the two fields removed from this schema in v2
    is a startup error.
    """

    type: Literal["leaf"]


Node = Annotated[BranchNode | LeafNode, Field(discriminator="type")]


class Tree(_Strict):
    """A validated decision tree."""

    tree_id: str = Field(min_length=1)
    version: str = Field(min_length=1)
    product: str = Field(min_length=1)
    root: str = Field(min_length=1)
    nodes: dict[str, Node] = Field(min_length=1)

    @model_validator(mode="after")
    def _validate_graph(self) -> Tree:
        for key, node in self.nodes.items():
            if node.id != key:
                raise TreeConfigError(
                    f"node '{key}': id '{node.id}' does not match its map key"
                )

        if self.root not in self.nodes:
            raise TreeConfigError(f"node '{self.root}': root id is not present in nodes")

        for node in self.nodes.values():
            if isinstance(node, BranchNode):
                for option in node.options:
                    if option.next not in self.nodes:
                        raise TreeConfigError(
                            f"node '{node.id}': option '{option.tool_name}' points to "
                            f"missing node '{option.next}'"
                        )

        self._reject_cycles()
        return self

    def _reject_cycles(self) -> None:
        """Depth-first search over every node, not just those reachable from root."""
        visiting: set[str] = set()
        done: set[str] = set()

        def walk(node_id: str) -> None:
            if node_id in done:
                return
            if node_id in visiting:
                raise TreeConfigError(f"node '{node_id}': cycle detected")
            visiting.add(node_id)
            node = self.nodes[node_id]
            if isinstance(node, BranchNode):
                for option in node.options:
                    walk(option.next)
            visiting.discard(node_id)
            done.add(node_id)

        for node_id in self.nodes:
            walk(node_id)

    @property
    def node_count(self) -> int:
        return len(self.nodes)

    def branch(self, node_id: str) -> BranchNode:
        """Fetch a node known to be a branch; raises if it is not."""
        node = self.nodes[node_id]
        if not isinstance(node, BranchNode):
            raise TreeConfigError(f"node '{node_id}': expected a branch node, got '{node.type}'")
        return node


def _no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """JSON object hook: a duplicate node id would otherwise be silently overwritten."""
    seen: set[str] = set()
    for key, _ in pairs:
        if key in seen:
            raise TreeConfigError(f"node '{key}': duplicate id in config")
        seen.add(key)
    return dict(pairs)


def _single_line(error: ValidationError) -> str:
    """Collapse a Pydantic error into one line, naming the offending node id if known."""
    first = error.errors()[0]
    loc = first["loc"]
    node_id = loc[1] if len(loc) > 1 and loc[0] == "nodes" else None
    field = ".".join(str(part) for part in (loc[2:] if node_id else loc))
    where = f"node '{node_id}'" if node_id else "tree config"
    detail = " ".join(str(first["msg"]).split())
    return f"{where}: {field + ': ' if field else ''}{detail}"


def parse_tree(raw: str) -> Tree:
    """Parse and validate a tree config from JSON text."""
    data = json.loads(raw, object_pairs_hook=_no_duplicate_keys)
    try:
        return Tree.model_validate(data)
    except ValidationError as exc:
        raise TreeConfigError(_single_line(exc)) from exc


def load_tree(path: str | Path) -> Tree:
    """Load and validate the tree config at `path`."""
    config_path = Path(path)
    try:
        raw = config_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise TreeConfigError(f"tree config at '{config_path}' could not be read: {exc}") from exc
    try:
        return parse_tree(raw)
    except json.JSONDecodeError as exc:
        raise TreeConfigError(f"tree config at '{config_path}' is not valid JSON: {exc}") from exc


def default_config_path() -> Path:
    """`config/tree.json` at the repo root, resolved relative to this file."""
    return Path(__file__).resolve().parents[2] / "config" / "tree.json"
