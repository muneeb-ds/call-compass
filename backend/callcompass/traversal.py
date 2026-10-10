"""Walking the decision tree over a single audio buffer.

One recording, many inferences: the *same* audio is handed to `generate()` at every
node, with only that node's tool list changing. Each call answers one question about
the utterance, and its answer picks the next node.

`traverse()` is a generator so the SSE endpoint can forward each step the moment its
inference returns — the per-call timing is the thing the demo exists to show, so
nothing is buffered until the end. It performs no HTTP and no audio decoding, which
is what lets the whole traversal be tested against a scripted fake model.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Generator
from typing import Any, Literal

from pydantic import BaseModel

from .model import SpeechToolModel, ToolCall
from .tools import node_to_tools
from .tree import MAX_DEPTH, NONE_OF_THESE, BranchNode, LeafNode, Option, Tree

logger = logging.getLogger(__name__)

#: Why a traversal stopped without reaching a leaf. These are the only four values the
#: `unplaced` SSE event may carry.
StopReason = Literal["none_of_these", "empty_response", "unknown_tool", "depth_limit"]


class Step(BaseModel):
    """One `generate()` call and the branch it chose. Field names match the SSE payload."""

    event: Literal["step"] = "step"
    index: int
    node_id: str
    node_label: str
    tool_called: str
    arguments: dict[str, Any]
    latency_ms: int
    next_node_id: str


class Completed(BaseModel):
    """Traversal reached a leaf. `total_latency_ms` is added by the HTTP layer."""

    event: Literal["completed"] = "completed"
    leaf_node_id: str
    label: str
    recommendation: str
    rationale: str | None
    path: list[str]
    inference_count: int
    total_inference_ms: int


class Unplaced(BaseModel):
    """Traversal stopped before a leaf. `total_latency_ms` is added by the HTTP layer."""

    event: Literal["unplaced"] = "unplaced"
    stopped_at_node_id: str
    stopped_at_label: str
    reason: StopReason
    path: list[str]
    inference_count: int
    total_inference_ms: int


#: What `traverse()` yields: zero or more steps, then exactly one terminal event.
TraversalEvent = Step | Completed | Unplaced


def _find_option(node: BranchNode, tool_name: str) -> Option | None:
    """The option a returned tool name selects, or None if the model invented one."""
    for option in node.options:
        if option.tool_name == tool_name:
            return option
    return None


def _arguments(call: ToolCall, option: Option, node_id: str) -> dict[str, Any]:
    """The returned arguments, copied, with out-of-enum values logged.

    `neudecide` grammar-constrains argument *names* but not values (see
    `backend/CLAUDE.md`), so a value outside the declared enum is possible. It is not
    treated as a traversal failure: the branch taken is decided by the tool name
    alone, and the argument is descriptive detail shown in the trace. Dropping an
    otherwise-valid answer over a stray value would lose a step the operator can
    still read, so the value is passed through and the mismatch is logged instead.
    """
    arguments = dict(call.get("arguments") or {})
    value = arguments.get(option.argument.name)
    if value is not None and value not in option.argument.enum:
        logger.warning(
            "node '%s': tool '%s' returned %s=%r, which is not in the declared enum %s",
            node_id,
            option.tool_name,
            option.argument.name,
            value,
            option.argument.enum,
        )
    return arguments


def _unplaced(
    node: BranchNode,
    reason: StopReason,
    path: list[str],
    inference_count: int,
    total_inference_ms: float,
) -> Unplaced:
    """The terminal event for a traversal that stopped on `node` without a leaf."""
    return Unplaced(
        stopped_at_node_id=node.id,
        stopped_at_label=node.label,
        reason=reason,
        path=list(path),
        inference_count=inference_count,
        total_inference_ms=round(total_inference_ms),
    )


def traverse(
    audio: Any,
    tree: Tree,
    model: SpeechToolModel,
    max_steps: int = MAX_DEPTH,
) -> Generator[TraversalEvent, None, None]:
    """Walk `tree` from its root, one inference per branch node, over one buffer.

    Yields a `Step` per `generate()` call, then exactly one terminal event. `audio` is
    passed through untouched at every node — never re-recorded and never sliced.

    `latency_ms` on each step times only the `generate()` call. `max_steps` is the
    hard cap that keeps a mis-specified tree from running away; the default is the
    cap, and it is only a parameter so tests can reach it on the sample tree.
    """
    node_id = tree.root
    path = [node_id]
    total_inference_ms = 0.0
    inference_count = 0

    while True:
        node = tree.nodes[node_id]

        if isinstance(node, LeafNode):
            yield Completed(
                leaf_node_id=node.id,
                label=node.label,
                recommendation=node.recommendation,
                rationale=node.rationale,
                path=list(path),
                inference_count=inference_count,
                total_inference_ms=round(total_inference_ms),
            )
            return

        if inference_count >= max_steps:
            yield _unplaced(node, "depth_limit", path, inference_count, total_inference_ms)
            return

        started = time.perf_counter()
        calls = model.generate(audio, node_to_tools(node))
        latency_ms = (time.perf_counter() - started) * 1000.0
        total_inference_ms += latency_ms
        inference_count += 1

        if not calls:
            yield _unplaced(node, "empty_response", path, inference_count, total_inference_ms)
            return

        call = calls[0]
        tool_called = str(call.get("name", ""))
        if tool_called == NONE_OF_THESE:
            yield _unplaced(node, "none_of_these", path, inference_count, total_inference_ms)
            return

        option = _find_option(node, tool_called)
        if option is None:
            logger.warning("node '%s': model returned unknown tool '%s'", node.id, tool_called)
            yield _unplaced(node, "unknown_tool", path, inference_count, total_inference_ms)
            return

        yield Step(
            index=inference_count - 1,
            node_id=node.id,
            node_label=node.label,
            tool_called=tool_called,
            arguments=_arguments(call, option, node.id),
            latency_ms=round(latency_ms),
            next_node_id=option.next,
        )

        node_id = option.next
        path.append(node_id)
