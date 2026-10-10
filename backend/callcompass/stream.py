"""Server-sent-event framing for one traversal run.

This is the only module that knows the SSE wire format. It turns the lazy
`traverse()` generator into a stream of `text/event-stream` frames, forwarding each
step the moment its inference returns — the per-call timing is the thing the demo
exists to show, so nothing is buffered until the end.

`generate()` is synchronous CPU work, so the generator is pumped one `next()` at a
time in a worker thread (`asyncio.to_thread`) and the event loop stays free to write
each frame out. `InferenceEngine`'s lock keeps the inference itself single-flight.

Event order is fixed: `started`, one `step` per inference, then exactly one of
`completed` / `unplaced` / `error`, then `done`. `done` is always last, so a client
never has to time out to know the run is over.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator, Generator
from typing import Any

from .audio import DecodedAudio
from .model import InferenceEngine
from .traversal import Step, TraversalEvent, traverse
from .tree import Tree

logger = logging.getLogger(__name__)

#: Content type of the `/api/analyze` response.
SSE_MEDIA_TYPE = "text/event-stream"

#: Headers that stop an intermediary buffering the stream into one chunk, which would
#: defeat the point of streaming per-node results.
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def format_event(event: str, data: dict[str, Any]) -> str:
    """One SSE frame. `data` is compact single-line JSON, as the protocol requires."""
    payload = json.dumps(data, separators=(",", ":"))
    return f"event: {event}\ndata: {payload}\n\n"


def _advance(events: Generator[TraversalEvent, None, None]) -> TraversalEvent | None:
    """One step of the traversal, or None once it is exhausted.

    Called via `asyncio.to_thread`: this is where the blocking `generate()` happens.
    """
    return next(events, None)


def _error_payload(exc: Exception, node_id: str) -> dict[str, Any]:
    """The `error` event for a failure mid-traversal, naming where it happened."""
    detail = " ".join(str(exc).split()) or type(exc).__name__
    return {"message": f"Inference failed at node '{node_id}': {detail}", "node_id": node_id}


async def analyze_events(
    audio: DecodedAudio,
    tree: Tree,
    engine: InferenceEngine,
    *,
    request_started: float,
) -> AsyncIterator[str]:
    """Stream one traversal of `tree` over `audio` as SSE frames.

    `request_started` is a `time.perf_counter()` reading taken when the request
    arrived. Traversal only knows inference time, so end-to-end `total_latency_ms` is
    measured here and merged into the terminal payload.
    """
    yield format_event(
        "started",
        {
            "tree_id": tree.tree_id,
            "root": tree.root,
            "audio_duration_ms": audio.duration_ms,
        },
    )

    events = traverse(audio.samples, tree, engine)
    # Where the next inference will run, so a failure can name its node. A `Step` is
    # yielded only after its `generate()` succeeded, so the pending node is always the
    # root or the last step's `next_node_id`.
    node_id = tree.root
    error: dict[str, Any] | None = None

    try:
        try:
            while True:
                event = await asyncio.to_thread(_advance, events)
                if event is None:
                    break
                payload = event.model_dump()
                if isinstance(event, Step):
                    node_id = event.next_node_id
                else:
                    payload["total_latency_ms"] = round(
                        (time.perf_counter() - request_started) * 1000.0
                    )
                yield format_event(event.event, payload)
        finally:
            # Closes the underlying generator on every exit path, including a client
            # disconnect (which arrives here as GeneratorExit).
            events.close()
    except Exception as exc:
        logger.exception("Traversal failed at node '%s'", node_id)
        error = _error_payload(exc, node_id)

    # Deliberately after the try/finally rather than inside it: yielding while a
    # GeneratorExit is in flight would raise, leaving the client's connection hanging.
    if error is not None:
        yield format_event("error", error)
    yield format_event("done", {})
