# CallCompass

A demo app showing how **NeuDecide** — a 43 MB on-device speech-to-tool-call model (ONNX, CPU)
— guides a sales agent through a decision tree from a single recorded customer utterance. There
is no transcription step: raw audio maps directly to a structured tool call, once per tree node.

Press record, say one sentence as the customer, and watch the tree light up node by node with the
real per-inference latency, ending in a recommendation the agent can read out loud.

> Full product requirements live in [`tasks/prd-callcompass-mvp.md`](tasks/prd-callcompass-mvp.md).

## What this is, and what it is not

The entire demo is **one customer utterance → one path through one tree**. Read it as a latency
and plumbing demonstration for on-device speech-to-tool-call, not as a product.

Explicit non-goals — none of these are implemented, and none are stubbed out to look implemented:

- **No live multi-turn calls.** One recorded utterance per run. There is no conversation state,
  no barge-in, and no streaming during the utterance.
- **No CRM or telephony integration.** Nothing is read from or written to any external system.
- **English only.** No other language has been tested.
- **No speaker demographics or sentiment scoring.** The model emits a tool call and an enum
  value; it is not inferring anything about who is speaking.
- **Not a recommendation engine.** The advice comes from strings an operator wrote in
  `config/tree.json`. The model only chooses which branch to take.

## Layout

```
backend/callcompass/   FastAPI app (Python package)
backend/tests/         pytest suite
frontend/              static vanilla HTML/CSS/JS, no build step
config/tree.json       the decision tree — the whole sales flow
scripts/bench_latency.py   the latency measurement behind the figures below
```

## Requirements

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) (or pip)
- macOS or Linux, CPU only. No GPU, no `onnxruntime-gpu`.
- Access to the model weights — see [Model access](#model-access) below.

## Install

Verified from a clean checkout:

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv -e "backend[dev]"
```

With plain pip:

```bash
python3.11 -m venv .venv && source .venv/bin/activate
pip install -e "backend[dev]"
```

### Model access

The weights live in the **gated** Hugging Face repo `neuphonic/neudecide`. Request access, then
export a token that has it:

```bash
export HF_TOKEN=hf_...
```

Without a token the server fails fast at startup with a single readable line telling you this.
To run fully offline instead, point at a local directory holding `config.json`,
`tokenizer.model` and the three ONNX graphs:

```bash
export CALLCOMPASS_MODEL_DIR=/path/to/neudecide
```

Also honoured: `CALLCOMPASS_MODEL_REPO` (default `neuphonic/neudecide`) and
`CALLCOMPASS_MODEL_VARIANT` (default `q4`).

## Run

```bash
cd backend
../.venv/bin/uvicorn callcompass.main:app
```

Then open **http://127.0.0.1:8000**.

The model is downloaded on first boot (~43 MB) and loaded **once** per process, so the first
start takes ~20 s and later starts about 1.7 s. Startup logs the load time and the execution
provider, then runs a warmup inference so the first real request is not cold. `GET /api/health`
reports the same facts.

Use `http://127.0.0.1:8000`, not a LAN IP: `getUserMedia` requires a secure context, and
`localhost` counts as one while a bare IP over plain HTTP does not.

## Demo script

Record yourself as the **customer**, one sentence, then stop. Each utterance below was verified
end to end against the real model on this repo's `config/tree.json`.

The tree asks three questions of one sentence — intent, then tier, then objection — so an
utterance that carries only an intent (`"what does Pro cost?"`) will legitimately stop early at
"Couldn't place this". **The utterances that demo well carry all three signals**, which is what
the examples below do.

| Say this | Path | Lands on |
| --- | --- | --- |
| "What does the Pro tier cost? We're a scaling team but there's no budget this quarter." | pricing → Pro → budget | **Reframe on value** |
| "Does it do dashboards for my scaling team? We're interested but mid-project right now." | feature → Pro → timing | **Secure a dated follow-up** |
| "How much is the Pro plan? My team is growing and we're evaluating you against Looker." | pricing → Pro → competitor | **Differentiate, do not attack** |
| "Do you have integrations for my growing team? I'm ready to buy, how do we start a trial?" | feature → Pro → buying signal | **Advance to next step now** |
| "I'm really not interested, please don't call here again." | not interested | **Exit cleanly** (1 inference) |
| "What's the price per seat? We're a large org and security review and SSO are required, and no budget this quarter." | pricing → Enterprise → budget | **Reframe on value** |

That covers all three level-1 branches (`pricing_question`, `feature_question`,
`not_interested`) and every leaf in the sample tree.

### The honest-failure utterance

```
"It's been raining all week and my dog won't go outside."
```

Nothing in the tree applies, so the model declines at the root and the UI shows the amber
**"Couldn't place this"** card naming the node it stopped on and why. Worth showing on purpose:
the demo is more credible for having a visible decline state than for pretending every utterance
maps somewhere.

### Operator notes

- **Press Reset between runs.** It clears the recording, the highlighting, the trace and the
  result card without a page reload, so the tree is never re-fetched.
- **Play back the recording after a surprising result.** The playback control serves the exact
  bytes that were uploaded, so it is how you tell "the model was wrong" apart from "the mic
  caught half a sentence".
- Speak at a normal pace and finish the sentence. Recording auto-stops at 30 s.
- Results vary with voice and phrasing — the same sentence read by two different speakers can
  take different branches. Rehearse your own delivery of the lines above before presenting; do
  not assume a line that worked for someone else will work for you.
- The declared `enum` is **advisory**. NeuDecide grammar-constrains parameter *names*, not
  values, so an argument value outside the configured list shows up occasionally. The branch is
  chosen by tool name alone, so traversal continues and the odd value is logged — it is trace
  detail, not a failure.

## Measured latency

20 consecutive runs of the demo-script utterances above, against the real model, on an
**Apple M3 Pro (11 cores), macOS 27.0.1, Python 3.11.13, neudecide 0.1.0, onnxruntime 1.31.0**,
`q4` variant, CPU execution provider:

| | median | p95 | min | max |
| --- | --- | --- | --- | --- |
| Total inference (sum of `generate()` calls) | **240 ms** | **258 ms** | 50 ms | 258 ms |
| Total latency (server end to end, what the result card shows) | **242 ms** | **263 ms** | 50 ms | 263 ms |
| Client wall clock around the HTTP request | 242 ms | 266 ms | 51 ms | 266 ms |

Comfortably inside the PRD's one-second budget, with ~4x headroom. Model load time is excluded
by design — it happens once at startup, not per request.

The spread is dominated by **how many inferences a path needs**, not by jitter. Over 80 runs
(four 20-run repeats):

- a 3-inference path to a deep leaf: median **276 ms**
- the level-2 short circuit (`not_interested`) and a root-level decline, 1 inference each:
  median **67 ms** (range 50–100 ms)

**Caveat on the p95, worth reading before quoting it.** The measurement machine was a normal
laptop with other applications running (load average ~4–6, one background process holding a
core), not a quiesced benchmark host. Across the four repeats the median was stable at
**241–286 ms** but p95 ranged **263–477 ms**, because p95 over only 20 samples *is* the
second-slowest run and so moves with one outlier. The table above is the quietest of the four;
pooled across all 80 runs the figures are median **245 ms**, p95 **353 ms**. Treat
"comfortably under a second on laptop CPU" as the claim that is actually supported here, and
re-measure on your own machine rather than inheriting these numbers.

All 80 runs resolved as intended — every demo-script utterance reached its listed leaf and only
the off-topic utterance came back `unplaced`.

Reproduce it:

```bash
.venv/bin/python scripts/bench_latency.py --runs 20 --json /tmp/bench.json
```

The script boots a real uvicorn with the real model, synthesizes each utterance with macOS
`say` + `afconvert` at 16 kHz mono 16-bit (the same format the browser encoder emits), POSTs it
to `/api/analyze`, and reports the percentiles. Numbers from synthetic speech are representative
for *timing* — latency depends on audio length and inference count, not on who is talking — but
**branch accuracy on TTS audio is not representative of a human voice.** Measure timing with the
script; judge accuracy with your own microphone.

## Editing the tree

The sales flow is entirely in [`config/tree.json`](config/tree.json). Edit it, restart the
server, reload the page: new labels, new branches, and a new product need **no code change**.
The frontend lays the graph out from node depth and sibling index at render time, so there are no
coordinates to update.

### Schema

```jsonc
{
  "tree_id": "northbeam-saas-v1",   // required, non-empty
  "version": "1.0.0",               // required, non-empty
  "product": "Northbeam Analytics", // required, non-empty
  "root": "intent",                 // required; must be a key in "nodes"
  "nodes": {                        // required, at least one node
    "intent": {
      "id": "intent",               // must equal the map key
      "type": "branch",             // "branch" | "leaf"
      "label": "Customer intent",   // shown on the node in the UI
      "level": 1,                   // integer >= 1; documentation only (see note)
      "prompt_hint": "optional",    // optional, unused by the model
      "options": [                  // branch nodes only; at least one
        {
          "tool_name": "pricing_question",  // unique within the node
          "description": "The customer is asking about price, plans, or billing.",
          "argument": {
            "name": "pricing_focus",        // the one argument the tool takes
            "enum": ["plan_cost", "billing_terms", "discount"],  // non-empty
            "description": "Which aspect of pricing was raised."
          },
          "next": "product_interest"        // must be a key in "nodes"
        }
      ]
    },
    "rec_budget": {
      "id": "rec_budget",
      "type": "leaf",
      "label": "Reframe on value",
      "level": 4,
      "recommendation": "Acknowledge the budget constraint, then ...",  // required
      "rationale": "Optional smaller text under the recommendation."    // optional
    }
  }
}
```

The `description` fields are **not decoration** — they are what the model sees as the tool
descriptions, and they are the main lever on branch accuracy. Write them as a description of what
the customer said, not as an instruction to the model.

### Constraints the loader enforces

An invalid config **fails server startup** with a single-line error naming the offending node id,
rather than misbehaving at inference time. Rejected:

- An unknown field anywhere (every object is strict, so a typo'd key is an error, not a no-op).
- A node whose `id` does not equal its key in `nodes`.
- A duplicate node id in the JSON text — caught even though `json.loads` would silently dedupe it.
- A `root` that is not a key in `nodes`.
- An option whose `next` points at a missing node id.
- A branch node with zero `options`; a leaf without `recommendation`.
- A duplicate `tool_name` within one node.
- An `argument` with a missing or empty `enum`. Arguments are enum-only by construction.
- A `tool_name` of `none_of_these` — the backend injects that tool into every node's tool list so
  the model can decline, so a config must not declare it.
- A cycle, checked from **every** node, so an unreachable cycle is still an error.
- An empty string in any required text field.

### Things worth knowing

- **The tree need not be uniform depth.** In the sample tree `rec_graceful_exit` is a level-2
  leaf reached after a single inference, while its siblings' subtrees run to level 4.
- **It is a DAG, not strictly a tree.** `pricing_question` and `feature_question` both point at
  `product_interest`. Sharing a `next` is supported; a node's rendered depth is its *longest*
  path from the root, so every edge still points downward.
- **`level` is documentation only.** Layout and traversal both compute depth from the edges. It
  is validated as an integer `>= 1` and otherwise ignored, so do not rely on it.
- Each node's options are the **only** tools offered at that node. The model never sees another
  node's options, which is what keeps per-node accuracy high as the tree grows.
- Traversal is hard-capped at 10 steps regardless of config.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /` | the demo page (static, served from `frontend/`) |
| `GET /api/health` | `{status, model_loaded, model_load_ms, tree_id, node_count}` |
| `GET /api/tree` | the validated tree config, verbatim |
| `POST /api/analyze` | multipart WAV upload → `text/event-stream` traversal |

`/api/analyze` emits `started`, one `step` per inference, exactly one terminal event
(`completed` or `unplaced`), then `done`. A mid-run failure emits `error` and then `done` —
`done` is always last, so a client never needs a timeout to know a run is over.

Audio must be **WAV, 16 kHz, mono, 16-bit PCM**, 0.3–30 s, under 2 MB. Anything else is a
`400` naming the actual value received (e.g. `"Audio must be 16000 Hz mono; received 44100 Hz
stereo."`) before the stream opens. The backend deliberately **never** resamples or downmixes:
quietly repairing bad audio would hide a broken client pipeline, and wrong-rate audio produces
confidently wrong model output rather than an error.

## Quality checks

All three must pass before any commit. Run from `backend/`:

```bash
cd backend
../.venv/bin/ruff check .        # lint + import sort
../.venv/bin/mypy callcompass    # typecheck (strict)
../.venv/bin/pytest              # tests
```

The suite needs **no model and no network** — it injects a scripted fake. The frontend has no
bundler and no JS test runner; the JS that has to agree with a backend contract (WAV encoding,
the recording ceiling, SSE parsing, tree layout, reset behaviour) is instead tested from pytest
by running the shipped modules under `node`. Those tests **skip** if `node` is missing, so a
green suite does not by itself mean they ran.

See [`backend/CLAUDE.md`](backend/CLAUDE.md) and [`frontend/CLAUDE.md`](frontend/CLAUDE.md) for
module-level conventions.
