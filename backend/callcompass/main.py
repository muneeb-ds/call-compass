"""FastAPI application entrypoint.

Run with: uvicorn callcompass.main:app --reload

The tree config and the model are loaded once, in the lifespan handler, and held on
`app.state`. Nothing is constructed per request. `create_app()` takes both as injectable
dependencies so tests can boot the real app without downloading a 43 MB model.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel

from .model import InferenceEngine, load_engine
from .tree import Tree, default_config_path, load_tree

logger = logging.getLogger(__name__)

#: Builds the loaded model. Swapped for a fake in tests.
ModelLoader = Callable[[], InferenceEngine]


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
) -> FastAPI:
    """Builds the app. Startup order is tree-then-model: config errors are cheap and
    should surface before the expensive model load."""
    loader = model_loader if model_loader is not None else load_engine
    config_path = tree_path if tree_path is not None else default_config_path()

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

    return app


app = create_app()
