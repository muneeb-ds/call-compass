# CallCompass

A demo app showing how **NeuDecide** — a 43 MB on-device speech-to-tool-call model (ONNX, CPU)
— guides a sales agent through a decision tree from a single recorded customer utterance. No
transcription step: raw audio maps directly to a structured tool call, once per tree node.

> Full product requirements live in [`tasks/prd-callcompass-mvp.md`](tasks/prd-callcompass-mvp.md).
> A complete setup/demo/tree-editing guide lands in US-017.

## Layout

```
backend/callcompass/   FastAPI app (Python package)
backend/tests/         pytest suite
frontend/              static vanilla HTML/CSS/JS, no build step
config/                decision tree JSON
```

## Requirements

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) (or pip)

## Install

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv -e "backend[dev]"
```

With plain pip:

```bash
python3.11 -m venv .venv && source .venv/bin/activate
pip install -e "backend[dev]"
```

## Run

```bash
cd backend
../.venv/bin/uvicorn callcompass.main:app --reload
```

Then open http://127.0.0.1:8000.

## Quality checks

All three must pass before any commit. Run from `backend/`:

```bash
cd backend
../.venv/bin/ruff check .
../.venv/bin/mypy callcompass
../.venv/bin/pytest
```
