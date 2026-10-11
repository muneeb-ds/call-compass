"""Traversal engine tests, driven entirely by a scripted fake model.

Every case runs against the real `config/tree.json`, so these also guard the shape of
the sample tree the demo script depends on.
"""

from __future__ import annotations

import numpy as np
import pytest

from callcompass.model import ToolCall
from callcompass.traversal import Completed, Step, TraversalEvent, Unplaced, traverse
from callcompass.tree import MAX_DEPTH, Tree, default_config_path, load_tree

from .fakes import EMPTY_RESPONSE, NONE_OF_THESE_CALL, FakeModel, picks

AUDIO = np.zeros(16000, dtype=np.float32)


@pytest.fixture(scope="module")
def tree() -> Tree:
    return load_tree(default_config_path())


Run = tuple[list[TraversalEvent], FakeModel]


def run(tree: Tree, script: list[list[ToolCall]], **kwargs: int) -> Run:
    """Traverse with a scripted model, returning the events and the model it used."""
    model = FakeModel(script)
    events = list(traverse(AUDIO, tree, model, **kwargs))
    return events, model


def steps(events: list[TraversalEvent]) -> list[Step]:
    return [event for event in events if isinstance(event, Step)]


#: The deepest route the sample tree offers: four inferences, one per branch node.
#: intent -> pricing_focus -> tier_fit -> objection_or_signal -> out_value_reframe.
HAPPY_PATH = [
    picks("pricing_question", pricing_focus="plan_cost"),
    picks("plan_cost_question", cost_frame="per_seat"),
    picks("pro_tier", growth_signal="scaling_team"),
    picks("budget_objection", budget_blocker="too_expensive"),
]


def test_happy_path_reaches_a_leaf(tree: Tree) -> None:
    events, _ = run(tree, HAPPY_PATH)

    assert [event.event for event in events] == ["step", "step", "step", "step", "completed"]

    assert [(step.node_id, step.tool_called, step.next_node_id) for step in steps(events)] == [
        ("intent", "pricing_question", "pricing_focus"),
        ("pricing_focus", "plan_cost_question", "tier_fit"),
        ("tier_fit", "pro_tier", "objection_or_signal"),
        ("objection_or_signal", "budget_objection", "out_value_reframe"),
    ]
    assert [step.index for step in steps(events)] == [0, 1, 2, 3]
    assert steps(events)[0].node_label == "Customer intent"
    assert steps(events)[2].arguments == {"growth_signal": "scaling_team"}

    completed = events[-1]
    assert isinstance(completed, Completed)
    assert completed.leaf_node_id == "out_value_reframe"
    assert completed.label == "Budget objection"
    assert completed.path == [
        "intent",
        "pricing_focus",
        "tier_fit",
        "objection_or_signal",
        "out_value_reframe",
    ]
    assert completed.inference_count == 4


def test_same_audio_buffer_is_passed_at_every_node(tree: Tree) -> None:
    _, model = run(tree, HAPPY_PATH)

    assert len(model.calls) == 4
    for audio, _tools in model.calls:
        assert audio is AUDIO


def test_each_node_sees_only_its_own_tools(tree: Tree) -> None:
    _, model = run(tree, HAPPY_PATH)

    names = [[tool["name"] for tool in tools] for _audio, tools in model.calls]
    assert names[0] == [
        "pricing_question",
        "feature_question",
        "competitor_mention",
        "existing_account",
        "buying_signal",
        "not_interested",
        "none_of_these",
    ]
    assert names[2] == ["starter_tier", "pro_tier", "enterprise_tier", "none_of_these"]
    assert all("none_of_these" in group for group in names)


def test_level_two_short_circuit_via_not_interested(tree: Tree) -> None:
    """`not_interested` reaches a leaf after a single inference (non-uniform depth)."""
    events, model = run(tree, [picks("not_interested", decline_tone="firm")])

    assert [event.event for event in events] == ["step", "completed"]
    completed = events[-1]
    assert isinstance(completed, Completed)
    assert completed.leaf_node_id == "out_graceful_exit"
    assert completed.path == ["intent", "out_graceful_exit"]
    assert completed.inference_count == 1
    assert len(model.calls) == 1


def test_none_of_these_at_level_one_is_unplaced(tree: Tree) -> None:
    events, _ = run(tree, [NONE_OF_THESE_CALL])

    assert [event.event for event in events] == ["unplaced"]
    unplaced = events[0]
    assert isinstance(unplaced, Unplaced)
    assert unplaced.reason == "none_of_these"
    assert unplaced.stopped_at_node_id == "intent"
    assert unplaced.stopped_at_label == "Customer intent"
    assert unplaced.path == ["intent"]
    assert unplaced.inference_count == 1


def test_empty_response_mid_tree_is_unplaced(tree: Tree) -> None:
    events, _ = run(
        tree, [picks("pricing_question", pricing_focus="plan_cost"), EMPTY_RESPONSE]
    )

    assert [event.event for event in events] == ["step", "unplaced"]
    unplaced = events[-1]
    assert isinstance(unplaced, Unplaced)
    assert unplaced.reason == "empty_response"
    assert unplaced.stopped_at_node_id == "pricing_focus"
    assert unplaced.path == ["intent", "pricing_focus"]
    assert unplaced.inference_count == 2


def test_unknown_tool_name_is_unplaced(tree: Tree) -> None:
    events, _ = run(tree, [picks("hallucinated_tool", whatever="x")])

    assert [event.event for event in events] == ["unplaced"]
    unplaced = events[0]
    assert isinstance(unplaced, Unplaced)
    assert unplaced.reason == "unknown_tool"
    assert unplaced.stopped_at_node_id == "intent"


def test_a_tool_from_another_node_counts_as_unknown(tree: Tree) -> None:
    """Options are per node: the root must not accept a deeper node's tool."""
    events, _ = run(tree, [picks("budget_objection", budget_blocker="too_expensive")])

    unplaced = events[0]
    assert isinstance(unplaced, Unplaced)
    assert unplaced.reason == "unknown_tool"


def test_depth_limit_stops_traversal(tree: Tree) -> None:
    events, model = run(tree, HAPPY_PATH, max_steps=2)

    assert [event.event for event in events] == ["step", "step", "unplaced"]
    unplaced = events[-1]
    assert isinstance(unplaced, Unplaced)
    assert unplaced.reason == "depth_limit"
    assert unplaced.stopped_at_node_id == "tier_fit"
    assert unplaced.inference_count == 2
    # The capped call is never made.
    assert len(model.calls) == 2


def test_default_depth_cap_is_ten(tree: Tree) -> None:
    assert MAX_DEPTH == 10


def test_out_of_enum_argument_value_is_passed_through(tree: Tree) -> None:
    """The enum is advisory at the grammar level; the tool name still decides the branch."""
    events, _ = run(tree, [picks("not_interested", decline_tone="sarcastic")])

    assert [event.event for event in events] == ["step", "completed"]
    assert steps(events)[0].arguments == {"decline_tone": "sarcastic"}


def test_missing_arguments_still_traverse(tree: Tree) -> None:
    events, _ = run(tree, [[{"name": "not_interested"}]])

    assert steps(events)[0].arguments == {}
    assert events[-1].event == "completed"


def test_latency_is_recorded_per_step_and_summed(tree: Tree) -> None:
    events, _ = run(tree, HAPPY_PATH)

    completed = events[-1]
    assert isinstance(completed, Completed)
    for step in steps(events):
        assert isinstance(step.latency_ms, int)
        assert step.latency_ms >= 0
    assert completed.total_inference_ms >= 0
    assert completed.total_inference_ms >= max(step.latency_ms for step in steps(events))


def test_traverse_is_lazy(tree: Tree) -> None:
    """A generator, so US-007 can stream each step as its inference returns."""
    model = FakeModel(list(HAPPY_PATH))
    events = traverse(AUDIO, tree, model)

    assert model.calls == []
    first = next(events)
    assert isinstance(first, Step)
    assert len(model.calls) == 1
