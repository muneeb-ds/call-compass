"""FastAPI application entrypoint.

Run with: uvicorn callcompass.main:app --reload

The tree config and the model are loaded once, in the lifespan handler, and held on
`app.state`. Nothing is constructed per request. `create_app()` takes both as injectable
dependencies so tests can boot the real app without downloading a 43 MB model.
"""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .audio import AudioError, decode_wav
from .model import InferenceEngine, load_engine
from .stream import SSE_HEADERS, SSE_MEDIA_TYPE, analyze_events
from .tree import Tree, default_config_path, load_tree

logger = logging.getLogger(__name__)

#: Builds the loaded model. Swapped for a fake in tests.
ModelLoader = Callable[[], InferenceEngine]


def default_frontend_dir() -> Path:
    """`frontend/` at the repo root, resolved relative to this file."""
    return Path(__file__).resolve().parents[2] / "frontend"


class HealthResponse(BaseModel):
    """Payload of `GET /api/health`. Field names and types are fixed by the PRD."""

    status: str
    model_loaded: bool
    model_load_ms: int
    tree_id: str
    node_count: int


def create_app(
    *,
    model_loader: ModelLoader | None = None,
    tree_path: str | Path | None = None,
    frontend_dir: str | Path | None = None,
) -> FastAPI:
    """Builds the app. Startup order is tree-then-model: config errors are cheap and
    should surface before the expensive model load."""
    loader = model_loader if model_loader is not None else load_engine
    config_path = tree_path if tree_path is not None else default_config_path()
    static_dir = Path(frontend_dir if frontend_dir is not None else default_frontend_dir())

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Both calls raise with a single-line message; letting them propagate is what
        # makes the server fail fast rather than serve a half-ready demo.
        tree = load_tree(config_path)
        logger.info(
            "Loaded tree '%s' version %s with %d nodes from %s",
            tree.tree_id,
            tree.version,
            tree.node_count,
            config_path,
        )
        app.state.tree = tree
        app.state.engine = loader()
        yield

    app = FastAPI(title="CallCompass", version="0.1.0", lifespan=lifespan)

    @app.exception_handler(AudioError)
    async def audio_error_handler(request: Request, exc: Exception) -> JSONResponse:
        """Rejected audio is a 400 with the single-line reason as `detail`.

        Registered app-wide so every route that decodes audio gets the same shape
        without repeating a try/except (PRD: `{"detail": "Audio must be ..."}`).
        """
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.get("/api/health")
    async def health() -> HealthResponse:
        """Readiness and demo-state check."""
        engine: InferenceEngine = app.state.engine
        tree: Tree = app.state.tree
        return HealthResponse(
            status="ok",
            model_loaded=True,
            model_load_ms=round(engine.load_ms),
            tree_id=tree.tree_id,
            node_count=tree.node_count,
        )

    @app.get("/api/tree")
    async def get_tree() -> dict[str, Any]:
        """The validated tree config, verbatim, for the static visualization.

        `exclude_none` keeps optional fields (`prompt_hint`) absent when the config
        omits them, so the response round-trips to the file's own JSON.
        """
        tree: Tree = app.state.tree
        return tree.model_dump(exclude_none=True)

    @app.post("/api/analyze")
    async def analyze(audio: Annotated[UploadFile, File()]) -> StreamingResponse:
        """Traverse the tree over one uploaded utterance, streaming each step as SSE.

        The clock starts here so `total_latency_ms` is genuinely end-to-end. Decoding
        happens before the response is constructed, so a rejected upload surfaces as
        the app-wide `AudioError` 400 handler's JSON *before* the stream opens.
        """
        request_started = time.perf_counter()
        decoded = decode_wav(await audio.read())
        return StreamingResponse(
            analyze_events(
                decoded,
                app.state.tree,
                app.state.engine,
                request_started=request_started,
            ),
            media_type=SSE_MEDIA_TYPE,
            headers=SSE_HEADERS,
        )

    # Mounted last and at the root so the demo runs on one port with no build step.
    # Starlette matches routes in registration order, so every `/api/*` route above
    # still wins; `html=True` makes `GET /` serve `index.html`.
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="frontend")

    return app


app = create_app()
