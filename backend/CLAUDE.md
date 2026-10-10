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

## Audio decode (`callcompass/audio.py`)

- The **only** module that knows the audio wire format. Pure — no model, network, or
  filesystem. `decode_wav(bytes)` → `DecodedAudio(samples, sample_rate, duration_ms)`.
- `samples` is `float32`, shape `(samples,)`, scaled into `[-1, 1)` — exactly what
  `neudecide.generate()` wants for a float array. `duration_ms` is what US-007's
  `started` event reports as `audio_duration_ms`.
- It **never resamples or downmixes.** Fixing up bad audio would hide the client-side
  pipeline bugs that are PRD risk R-5; a wrong rate is an error, not something to repair.
- Checks run cheapest-first: empty → size → WAV container → rate/channels → width →
  duration. Rate and channels are reported in **one** message so the PRD's example
  (`"Audio must be 16000 Hz mono; received 44100 Hz stereo."`) is reproducible.
- Rejections raise `AudioError` (a `ValueError`) with a single line naming the actual
  value. `create_app` registers one app-wide handler turning it into
  `400 {"detail": <message>}` — routes should let it propagate, not catch it.
- Uses stdlib `wave`, so there is no audio codec dependency. A non-WAV payload surfaces
  as `wave.Error`/`EOFError` and is collapsed into the one-line message.
- `tests/fakes.py::make_wav()` generates fixtures (no checked-in binary): defaults are
  valid, and keyword args build each invalid variant. Use it instead of hand-rolling RIFF.

## Traversal (`callcompass/traversal.py`)

- `traverse(audio, tree, model, max_steps=MAX_DEPTH)` is a **generator**: it yields a `Step`
  per `generate()` call, then **exactly one** terminal event (`Completed` or `Unplaced`), then
  stops. Consume it lazily — the SSE endpoint's whole point is forwarding each step as its
  inference returns.
- All three event models are Pydantic and their **field names are the SSE payload**
  (PRD "API Endpoints"). Each carries a literal `event` field, so the HTTP layer can use
  `event.event` as the SSE event name and `model_dump()` as the data. Changing a field name
  here changes the wire format — check the PRD first.
- `total_latency_ms` is deliberately **not** on the terminal events. Traversal only knows
  inference time (`total_inference_ms`); end-to-end latency belongs to the request layer,
  which merges it into the payload.
- The **tool name alone decides the branch.** An argument value outside the declared `enum`
  is logged and passed through, not treated as a failure — the enum is advisory at the
  grammar level and the argument is only descriptive detail in the trace.
- Only `calls[0]` is used; the model may return several tool calls but a node takes one branch.
- `max_steps` exists so tests can hit `depth_limit` on the 4-level sample tree. **Production
  must not pass it** — the default is the hard cap.
- `latency_ms` times only `generate()`, via `time.perf_counter`, and is rounded to an int.

## SSE streaming (`callcompass/stream.py`)

- The **only** module that knows the `text/event-stream` wire format. `analyze_events(...)`
  is an async generator of frames; `format_event(name, data)` builds one frame. Routes
  construct a `StreamingResponse` over it with `SSE_MEDIA_TYPE` / `SSE_HEADERS`
  (`X-Accel-Buffering: no`, so an intermediary can't coalesce the stream into one chunk and
  destroy the per-node timing the demo exists to show).
- Event order is fixed and **`done` is always last**, including after `error`. A client never
  needs a timeout to know a run is over.
- `traverse()` is pumped one `next()` at a time through `asyncio.to_thread`, so the blocking
  `generate()` never runs on the event loop. `traverse` is annotated as a `Generator` (not
  `Iterator`) specifically so `.close()` is available — the `finally` closes it on every exit
  path, including a client disconnect arriving as `GeneratorExit`.
- The `error` and `done` frames are yielded **outside** that `try/finally`: yielding while a
  `GeneratorExit` is in flight raises, which would leave the connection hanging.
- `total_latency_ms` is measured here (the route passes a `perf_counter()` reading taken on
  arrival) and merged into the terminal payload, because traversal only knows inference time.
- A failing node is named by tracking the *pending* node id — a `Step` is yielded only after
  its `generate()` succeeded, so the pending node is the root or the last step's `next_node_id`.
- `/api/analyze` takes `Annotated[UploadFile, File()]`, which needs the **`python-multipart`**
  runtime dep. Without it FastAPI raises at import/route-setup time, not per request.
- `tests/fakes.py::parse_sse(body)` parses a response body into `[(event, data), ...]` and is
  deliberately strict — a frame missing `event:` or `data:` fails the test rather than being
  skipped. `FakeModel(fail_on_call=N)` (1-indexed) exercises the mid-stream `error` path.

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

## Static frontend serving (`create_app`)

- `frontend/` is mounted with `StaticFiles(..., html=True)` at **`/`**, as the **last** route in
  `create_app`, so the demo runs on one port with no build step and `GET /` serves `index.html`.
- That mount matches **every** path. Starlette resolves routes in registration order, so the
  `/api/*` routes above it still win — but **any route added to the app after `create_app`
  returns is shadowed** (a GET-only mount answers 405). If a test needs an extra route, move
  the mount back to last (see `tests/test_audio.py::_app_with_decode_route`).
- `default_frontend_dir()` resolves `frontend/` from the repo root, same pattern as
  `default_config_path()`. `create_app(frontend_dir=...)` overrides it.
- The frontend is **vanilla ES modules** — no bundler, no transpile, no node_modules. There is
  no JS typecheck or lint step. See `frontend/CLAUDE.md`; its audio pipeline is covered from
  here by `tests/test_frontend_audio.py`, which runs the shipped JS encoder under node
  (`tests/encode_fixture.mjs`) and feeds the bytes to `decode_wav` and `/api/analyze`, and by
  `tests/test_frontend_timing.py` (`tests/timing_fixture.mjs`), which pins the UI's recording
  ceiling to `audio.MAX_SECONDS`, and by `tests/test_frontend_playback.py`
  (`tests/playback_fixture.mjs`), which stubs three DOM elements and asserts the bytes the
  playback control serves are byte-identical to the upload. All three skip if `node` is
  missing, so a green suite does not imply they ran. **Any frontend limit that mirrors a backend constant should get a line in
  one of those two tests** — that is the only place the two sides are checked against
  each other.

## Tests

- `tests/` is a package (`tests/__init__.py`), so share fixtures via `from .fakes import ...`.
- `tests/fakes.py` holds `FakeModel` (a scripted `generate()` that records its `calls`),
  `fake_engine()`, and the script helpers `picks(tool, **args)`, `NONE_OF_THESE_CALL`,
  `EMPTY_RESPONSE`. Extend these rather than writing a new double per story.
- A traversal script is one `FakeModel` response per node, in order; once it runs out
  `generate()` returns `[]`, which traversal reads as `empty_response`.
- The warmup lives in `load_engine()`, **not** in the lifespan handler, so an injected
  `model_loader` runs no warmup. `FakeModel.calls` therefore contains only the calls a test's
  own request made — don't write assertions that skip a leading warmup call.

## Dependencies

- Adding a runtime dep means editing `[project].dependencies` in `backend/pyproject.toml`,
  then re-running `uv pip install --python ../.venv -e ".[dev]"` from `backend/`.
- `neudecide` and `onnxruntime` are heavy, real PyPI packages and are installed in the venv;
  the model itself downloads on first construction, so the first run of US-003's startup path
  is slow.
