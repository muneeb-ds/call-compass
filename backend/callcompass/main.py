"""FastAPI application entrypoint.

Run with: uvicorn callcompass.main:app --reload
"""

from fastapi import FastAPI

app = FastAPI(title="CallCompass", version="0.1.0")


@app.get("/api/ping")
async def ping() -> dict[str, str]:
    """Liveness probe. Replaced by the richer /api/health in US-003."""
    return {"status": "ok"}
