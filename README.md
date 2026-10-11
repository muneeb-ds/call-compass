# CallCompass

A demo app showing how **NeuDecide** — a 43 MB on-device speech-to-tool-call model (ONNX, CPU)
— walks a decision tree from a single recorded customer utterance. There is no transcription
step: raw audio maps directly to a structured tool call, once per tree node.

Press record, say one sentence as the customer, and watch the tree light up node by node with the
real per-inference latency, ending in a leaf that names the classification the model reached —
never advice.

> Full product requirements live in [`tasks/prd-callcompass-v2.md`](tasks/prd-callcompass-v2.md)
> (and the original [`tasks/prd-callcompass-mvp.md`](tasks/prd-callcompass-mvp.md) it builds on).

## What this is, and what it is not

The entire demo is **one customer utterance → one path through one tree**. Read it as a latency
and plumbing demonstration for on-device speech-to-tool-call, not as a product.

Explicit non-goals — none of these are implemented, and none are stubbed out to look implemented:

- **No live multi-turn calls.** One recorded utterance per run (pausable, but still one take).
  There is no conversation state, no barge-in, and no streaming during the utterance.
- **No CRM or telephony integration.** Nothing is read from or written to any external system.
- **English only.** No other language has been tested.
- **No speaker demographics or sentiment scoring.** The model emits a tool call and an enum
  value; it is not inferring anything about who is speaking.
- **Not a recommendation engine, by construction.** A leaf in `config/tree.json` carries a
  `label` and nothing else — the schema has no field for advice text. Every model in
  `backend/callcompass/tree.py` is strict (`extra="forbid"`), so a config that tries to add a
  `recommendation` or `rationale` back in fails at server startup rather than silently working.
  The model only ever chooses which branch to take; the leaf it lands on is a classification, not
  a script to read to the customer.

## Layout

```
backend/callcompass/   FastAPI app (Python package)
backend/tests/         pytest suite
frontend/              static vanilla HTML/CSS/JS, no build step
config/tree.json       the decision tree — the whole sales flow
scripts/bench_latency.py   the latency measurement behind the figures below
```

The UI itself is a thin status bar over three columns: the capture dock on the left (record,
pause/resume, timer, waveform, playback, reset), the tree you watch the model move through in
the centre, and the trace on the right — a numbered timeline of every step and its latency,
open by default on wide screens and collapsible to a narrow rail. Below 900px the columns
stack. There is no separate "result card" — a finished run's outcome shows at the foot of the
dock, under its controls.

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

Record yourself as the **customer**, one sentence, then stop.

The tree branches six ways at the root and runs up to **four** inferences deep, so different
utterances take visibly different routes — that is the point of the shape. A route is only as
long as the utterance has signal for: an utterance carrying only an intent
(`"what does Pro cost?"`) will legitimately stop early at "Couldn't place this".
**The utterances that demo well carry one signal per question on their route**, which is what
the examples below do.

Every node asks another question of the *same* one sentence, so the deepest routes need the
most densely loaded utterances. That is the real ceiling on tree depth here — not latency.

| Say this | Intended route | Inferences | Typically lands on |
| --- | --- | --- | --- |
| "What does the Pro tier cost per seat? We're a scaling team, but there's no budget this quarter." | pricing → plan cost → budget | 3–4 | **Budget objection** or **Timing objection** |
| "Does it do dashboards for my scaling team? We're interested, but we're mid-project right now." | feature → dashboards → timing | 4 | **Timing objection** |
| "How much is the Pro plan? My team is growing and we're evaluating you against Looker." | competitor mention → posture | 4 | **Incumbent in place** |
| "Do you have integrations for my growing team? I'm ready to buy, how do we start a trial?" | buying signal → close path | 2 | **Proposal requested** or **Trial requested** |
| "I'm really not interested, please don't call here again." | not interested | 1 | **Not interested** |
| "It's been raining all week and my dog won't go outside." | — | 1–2 | **Couldn't place this** |

That covers five of the six level-1 branches (`pricing_question`, `feature_question`,
`competitor_mention`, `buying_signal`, `not_interested` — `existing_account` is the sixth,
reached by e.g. "we've been paying all year and barely anyone on my team logs in"), plus the
honest-failure case.

> **"Typically lands on" is not a promise.** These six utterances, their intended routes, and the
> measured latencies below were all captured together in one `scripts/bench_latency.py` run
> against the real model on this repo's current `config/tree.json` (`northbeam-saas-v2`, 26
> nodes). The model's branch choice is genuinely probabilistic — the same "budget" utterance
> landed on **Timing objection** every time in that run rather than the intended **Budget
> objection** — because only tool *names*, not argument values, are grammar-constrained (see
> [Things worth knowing](#things-worth-knowing)). Demo the *mechanism* (watch the tree move,
> read the position readout, trust the latency), not a specific leaf as guaranteed output.
> Rehearse your own delivery before presenting — voice and phrasing shift the outcome, and a
> line that lands cleanly for one speaker may not for another.

### Pause and resume

Press Record, say the first half of the utterance, press **Pause** (or hit `P`) — the dock takes
on a visibly held treatment, the waveform freezes instead of going flat, and the browser's
recording indicator stays lit because the microphone is still open. Collect your thought, press
**Resume** (or `P` again), finish the sentence, then **Stop**. The two spans are stitched into one
buffer with no gap or inserted silence; after stopping, the static waveform shows the full take
with a marker at the exact sample offset where the splice happened, so you can confirm nothing
was lost before sending it. `Space` toggles record/stop and `P` toggles pause from anywhere
outside a text field.

### Watching the position readout

While a run is in flight, the status bar shows the active node's label, `Depth D of T`, and
`inference N` — updated the instant each inference returns, in sync with the node that lights up
on the tree. It is the plain-language version of what the highlighted node is already showing, so
narrate from it rather than reading node ids off the graph: "we're at depth 2 of 5, on the pricing
question, three inferences in."

### Operator notes

- **Press Reset between runs.** It clears the recording, the tree highlighting, the trace, the
  outcome strip, the static waveform, and the camera position without a page reload, so the tree
  is never re-fetched.
- **Play back the recording after a surprising result.** The playback control serves the exact
  bytes that were uploaded, so it is how you tell "the model was wrong" apart from "the mic
  caught half a sentence".
- Speak at a normal pace and finish the sentence. Recording auto-stops at 30 s of accumulated
  (unpaused) time.
- Results vary with voice and phrasing — the same sentence read by two different speakers, or run
  twice, can take different branches. That is expected model behaviour, not a bug; see the caveat
  above the demo table.
- The declared `enum` is **advisory**. NeuDecide grammar-constrains parameter *names*, not
  values, so an argument value outside the configured list shows up occasionally (the bench run
  above hit this on about half its runs). The branch is chosen by tool name alone, so traversal
  continues and the odd value is logged — it is trace detail, not a failure.

## Measured latency

20 consecutive runs of the demo-script utterances above, against the real model, on the current
`northbeam-saas-v2` tree (26 nodes, routes 1–4 inferences deep), on an **Apple M3 Pro (ARM64,
11 cores), macOS 27.0.1, Python 3.11.13, neudecide 0.1.0, onnxruntime 1.31.0**, `q4` variant, CPU
execution provider:

| | median | p95 | min | max |
| --- | --- | --- | --- | --- |
| Total inference (sum of `generate()` calls) | **333 ms** | **612 ms** | 129 ms | 612 ms |
| Total latency (server end to end, what the outcome strip shows) | **334 ms** | **613 ms** | 130 ms | 613 ms |
| Client wall clock around the HTTP request | 335 ms | 614 ms | 131 ms | 614 ms |

Comfortably inside the PRD's one-second budget — the worst single run (613 ms, a 4-inference
route) still leaves headroom. Model load time is excluded by design: it happens once at startup
(4.6 s in this run), not per request.

The spread is dominated by **how many inferences a path needs**, not by jitter:

- the 1-inference level-2 short circuit (`not_interested`): **~130–160 ms**
- the 2-inference off-topic decline (`unplaced`): **~200–250 ms**
- the 2-inference buying-signal route: **~325–465 ms**
- the 3–4-inference pricing/feature/competitor routes: **~300–615 ms**, and the single slowest
  run in the set (613 ms) is one of these

All 20 runs resolved as intended by *outcome* — every scripted utterance reached a leaf
(`completed`) except the off-topic one, which came back `unplaced` as designed. As the demo
script's caveat above says, *which* leaf a given utterance reaches is not guaranteed run to run.

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
  "tree_id": "northbeam-saas-v2",   // required, non-empty
  "version": "2.0.0",               // required, non-empty
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
          "next": "pricing_focus"           // must be a key in "nodes"
        }
      ]
    },
    "out_value_reframe": {
      "id": "out_value_reframe",
      "type": "leaf",
      "label": "Budget objection",      // the outcome, as a classification — nothing else
      "level": 5
    }
  }
}
```

The `description` fields are **not decoration** — they are what the model sees as the tool
descriptions, and they are the main lever on branch accuracy. Write them as a description of what
the customer said, not as an instruction to the model.

A leaf is deliberately **not** a place to put advice for an operator to read out: it carries
`label` (plus the shared `level` and optional `prompt_hint`) and nothing else. There is no
`recommendation` or `rationale` field in the schema at all.

### Constraints the loader enforces

An invalid config **fails server startup** with a single-line error naming the offending node id,
rather than misbehaving at inference time. Rejected:

- An unknown field anywhere (every object is strict, so a typo'd key is an error, not a no-op).
  **This is what rejects a `recommendation` or `rationale` key on a leaf** — those fields do not
  exist in the schema, so supplying either is a startup error like any other unknown key, not a
  silently-ignored no-op.
- A node whose `id` does not equal its key in `nodes`.
- A duplicate node id in the JSON text — caught even though `json.loads` would silently dedupe it.
- A `root` that is not a key in `nodes`.
- An option whose `next` points at a missing node id.
- A branch node with zero `options`.
- A duplicate `tool_name` within one node.
- An `argument` with a missing or empty `enum`. Arguments are enum-only by construction.
- A `tool_name` of `none_of_these` — the backend injects that tool into every node's tool list so
  the model can decline, so a config must not declare it.
- A cycle, checked from **every** node, so an unreachable cycle is still an error.
- An empty string in any required text field.

### Things worth knowing

- **The tree need not be uniform depth.** In the sample tree `out_graceful_exit` is a level-2
  leaf reached after a single inference, while its siblings' subtrees run to level 5.
- **It is a DAG, not strictly a tree.** `feature_fit`'s three capability options all point at
  `tier_fit`, and `tier_fit` itself has four distinct parents. Sharing a `next` is supported: it
  draws one node and one edge per *node pair*, and a node's rendered depth is its *longest* path
  from the root, so every edge still points downward.
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

All four must pass before any commit. The first three run from `backend/`; the fourth from the
repo root:

```bash
cd backend
../.venv/bin/ruff check .        # lint + import sort
../.venv/bin/mypy callcompass    # typecheck (strict)
../.venv/bin/pytest              # tests
cd ..
node --check frontend/*.js       # frontend syntax
```

The suite needs **no model and no network** — it injects a scripted fake. The frontend has no
bundler and no JS test runner; the JS that has to agree with a backend contract (WAV encoding,
the recording ceiling, SSE parsing, tree layout, reset behaviour) is instead tested from pytest
by running the shipped modules under `node`. Those tests **skip** if `node` is missing, so a
green suite does not by itself mean they ran.

See [`backend/CLAUDE.md`](backend/CLAUDE.md) and [`frontend/CLAUDE.md`](frontend/CLAUDE.md) for
module-level conventions.
