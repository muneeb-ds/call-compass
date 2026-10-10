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

## The `neudecide` API (confirmed by reading the installed source, v0.1.0)

Read from `.venv/lib/python3.11/site-packages/neudecide/`. These are facts, not guesses:

- **Construction:** `NeuDecide(model_dir, variant="q4", threads=None, providers=None)` or
  `NeuDecide.from_pretrained(repo_id="neuphonic/neudecide", variant="q4", token=None)`.
  Default providers are `["CPUExecutionProvider"]`.
- **Inference:** `model.generate(audio, tools, sample_rate=None, constrained=True,
  max_new_tokens=None)` → `list[{"name": str, "arguments": dict}]`, and **`[]` when no tool
  applies or the output doesn't parse**. An empty list is a normal result, not an error.
- **Audio:** a WAV path, or a NumPy array `(samples,)` / `(samples, channels)`. Float arrays
  must already be in `[-1, 1]`; integer arrays are scaled automatically. Pass `sample_rate=`
  if it isn't `model.sample_rate` (16000). Internally resampled with `soxr` and truncated to
  `config["max_audio_seconds"]`.
- **Tool schema:** each tool is `{"name", "description", "parameters"}`, where `parameters` is
  JSON Schema (`{"type": "object", "properties": {...}, "required": [...]}`) — a flat
  `{key: {...}}` mapping also works. See `grammar.tool_parameters`. **Only parameter *names*
  constrain decoding**: `grammar.tool_call_grammar` builds the grammar from keys with `{}` as
  each value schema, so a declared `enum` does *not* restrict values at the grammar level.
  Validate enum membership yourself after `generate()` returns.
- **Execution provider** is readable at runtime via `model.audio_encoder.get_providers()`.
- **Not concurrency-safe:** `generate_ids` lazily populates `self._ll_tokenizer`. Always go
  through `InferenceEngine.generate()`, which holds a lock.

### Model access (blocker worth knowing)

`neuphonic/neudecide` on the Hugging Face Hub is a **gated repo** — an unauthenticated
`from_pretrained()` fails with `GatedRepoError: 401`. To run the real model you need either
`HF_TOKEN` set to a token with granted access, or `CALLCOMPASS_MODEL_DIR` pointed at a local
directory holding `config.json`, `tokenizer.model`/`tokenizer.json`, and the ONNX graphs.
All backend tests use `tests/fakes.py` instead, so the suite needs no model and no network.

## Node-to-tools conversion (`callcompass/tools.py`)

- The **only** place that knows the `neudecide` tool-schema shape. It is pure (no model,
  network, or filesystem), so an upstream API change is a one-file edit. Keep it that way.
- `node_to_tools(branch)` → that node's options as tools, with `none_of_these` appended
  **last**. Never build a tool list by hand elsewhere, and never pass options from more
  than one node into a single `generate()` call.
- One option → one tool with exactly one required, enum-constrained string argument.
  `enum` is copied, not aliased, so a caller mutating the returned dict can't corrupt the
  loaded `Tree`.
- The `enum` is **advisory only** — `neudecide` grammar-constrains parameter *names*, not
  values — so every caller must re-check membership in `option.argument.enum` after
  `generate()` returns.
- `tests/test_tools.py` pins the exact dict shape for `intent` and `signal_check`, and
  round-trips a tool list through the real `neudecide.grammar.tool_parameters` to catch an
  upstream schema change. Update those assertions deliberately, not reflexively.

## Model loading (`callcompass/model.py`)

- `load_engine()` constructs the model **once**, times it, logs the duration and execution
  providers, then runs a warmup inference on 0.5 s of silence. Any failure in either step
  becomes a single-line `ModelLoadError` so startup fails fast.
- `create_app(model_loader=..., tree_path=...)` in `main.py` injects both dependencies;
  `app = create_app()` is the production instance. **Tests should always pass a
  `model_loader`** (use `tests.fakes.fake_engine`) — otherwise they try to download the model.
- Startup order in the lifespan handler is **tree first, then model**: config errors are cheap
  and should surface before the expensive load.
- Downstream code depends on the `SpeechToolModel` Protocol, never on `NeuDecide` directly.

## Tests

- `tests/` is a package (`tests/__init__.py`), so share fixtures via `from .fakes import ...`.
- `tests/fakes.py` holds `FakeModel` (a scripted `generate()` that records its `calls`) and
  `fake_engine()`. Extend these rather than writing a new double per story.

## Dependencies

- Adding a runtime dep means editing `[project].dependencies` in `backend/pyproject.toml`,
  then re-running `uv pip install --python ../.venv -e ".[dev]"` from `backend/`.
- `neudecide` and `onnxruntime` are heavy, real PyPI packages and are installed in the venv;
  the model itself downloads on first construction, so the first run of US-003's startup path
  is slow.
