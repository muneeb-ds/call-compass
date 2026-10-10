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

## Tree config (`callcompass/tree.py`)

- `tree.py` is the **only** module that knows the config file's shape. Downstream code consumes
  `Tree` / `BranchNode` / `LeafNode`, never raw dicts.
- Entry points: `parse_tree(text)`, `load_tree(path)`, `default_config_path()` (resolves
  `config/tree.json` from the repo root, two parents up from the package).
- All config failures surface as **`TreeConfigError` with a single-line message naming the
  offending node id**. Never let a raw `pydantic.ValidationError` escape — `parse_tree` catches
  and collapses it via `_single_line`.
- Validators that know their node id raise `TreeConfigError` directly (Pydantic propagates
  non-`ValueError` exceptions untouched); validators that don't raise `ValueError` and let
  Pydantic's `loc` supply the node id.
- Node models are a **discriminated union on `type`** and all models are `extra="forbid"`, so a
  typo'd field is an error rather than silently ignored.
- `NONE_OF_THESE = "none_of_these"` lives here and is **backend-injected at inference time**;
  the loader rejects any config that declares it. US-004's tool conversion must add it.
- The sample tree is **not uniform depth** (`rec_graceful_exit` is a level-2 leaf). Anything
  that walks or lays out the tree must handle varying depth.
- Duplicate node ids are caught by a `json.loads` `object_pairs_hook` — a plain dict would
  silently dedupe them, so parse config text through `parse_tree`, not `json.loads`.

## Dependencies

- Adding a runtime dep means editing `[project].dependencies` in `backend/pyproject.toml`,
  then re-running `uv pip install --python ../.venv -e ".[dev]"` from `backend/`.
- `neudecide` and `onnxruntime` are heavy, real PyPI packages and are installed in the venv;
  the model itself downloads on first construction, so the first run of US-003's startup path
  is slow.
