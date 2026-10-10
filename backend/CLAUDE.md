# backend/ — CallCompass Python package

## Quality checks (run these before every commit)

The venv lives at the **repo root** (`.venv`), but all three commands must be run from
`backend/` because the ruff/mypy/pytest config lives in `backend/pyproject.toml`:

```bash
cd backend
../.venv/bin/ruff check .        # lint + import sort
../.venv/bin/mypy callcompass    # typecheck (strict mode)
../.venv/bin/pytest              # tests
```

## Conventions

- **mypy is in `strict` mode.** Every function needs annotated params and an explicit return
  type, including `-> None` on tests. Untyped third-party imports need an
  `ignore_missing_imports` override in `pyproject.toml` (already set for `neudecide`,
  `onnxruntime`).
- `ruff` line length is 100; lint rules are `E, F, I, UP, B, W`.
- Tests live in `backend/tests/` and import the package as `callcompass.*` (editable install).
- Run the server from `backend/`: `../.venv/bin/uvicorn callcompass.main:app --reload`.

## Dependencies

- Adding a runtime dep means editing `[project].dependencies` in `backend/pyproject.toml`,
  then re-running `uv pip install --python ../.venv -e ".[dev]"` from `backend/`.
- `neudecide` and `onnxruntime` are heavy, real PyPI packages and are installed in the venv;
  the model itself downloads on first construction, so the first run of US-003's startup path
  is slow.
