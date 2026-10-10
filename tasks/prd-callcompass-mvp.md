# PRD: CallCompass MVP

## Introduction

CallCompass is a demo app that shows what a 43 MB on-device speech-to-tool-call model can do for live sales work. A sales agent records one customer utterance (up to 30 seconds). The app then walks that same audio down a predefined decision tree: at each node it calls `model.generate(audio, tools)` where the node's branches are expressed as **tools with enum arguments**, plus a "none of these" escape option. It follows the chosen branch until it hits a leaf containing a recommended agent response.

The point of the demo is not the sales advice — it is the mechanism. The model never produces a transcript. It maps raw audio directly to a structured tool call, 3–4 times in a row, entirely on CPU, in well under a second. The UI makes that visible: the tree lights up node by node as each call returns, and each visited node shows the option picked, its arguments, and its latency in milliseconds.

**Demo audience:** prospective customers and partners evaluating NeuDecide (sales-engineering and solutions teams), plus internal stakeholders who need a tangible artifact for conference demos and investor conversations. Viewers are assumed to be technically literate but new to speech-to-tool-call as a concept.

## Goals

- Prove end-to-end that audio → tool call → tree traversal → recommendation works with no transcription step.
- Finish a complete 3–4 level traversal in **under 1 second total** on a laptop CPU (p50; under 1.5s p95).
- Make each inference step legible: option chosen, arguments, per-call latency, in the order they happened.
- Keep the decision tree fully editable in a single JSON file, with zero code changes, so a demo can be re-pointed at a new vertical in minutes.
- Fail honestly: when the model declines or returns nothing, say "couldn't place this" rather than inventing a path.
- Ship something a non-author can run from a clean checkout in under 5 minutes.

## User Stories

### US-001: Repository scaffold and quality checks
**Description:** As a developer, I need a runnable project skeleton with quality checks wired up so that every later story can be verified before commit.

**Acceptance Criteria:**
- [ ] Repo layout created: `backend/` (Python package `callcompass`), `frontend/` (static files), `config/` (tree JSON), `tasks/`
- [ ] `backend/pyproject.toml` declares dependencies: `fastapi`, `uvicorn[standard]`, `neudecide`, `onnxruntime`, `numpy`, `pydantic`, plus dev deps `ruff`, `mypy`, `pytest`, `httpx`
- [ ] `ruff check .` passes with no errors
- [ ] `mypy backend/callcompass` passes with no errors
- [ ] `pytest` runs and collects at least one passing placeholder test
- [ ] `README.md` documents install and run commands (`uvicorn callcompass.main:app --reload`)

### US-002: Tree config schema and loader
**Description:** As a demo operator, I want the decision tree defined in one JSON file so that I can change the sales flow without touching code.

**Acceptance Criteria:**
- [ ] `config/tree.json` exists containing the complete sample B2B SaaS tree from the "Sample Tree Config" section below
- [ ] Pydantic models in `backend/callcompass/tree.py` model the schema in "Tree Config Schema" below
- [ ] Loader validates on startup and raises a clear, single-line error naming the offending node id on failure
- [ ] Validation rejects: duplicate node ids, a `next` pointer to a missing node id, a branch node with zero options, a leaf without `recommendation`, a cycle, a root id not present in `nodes`
- [ ] Unit tests cover one valid tree and at least four distinct invalid trees (missing pointer, duplicate id, cycle, empty options)
- [ ] `ruff`, `mypy`, `pytest` pass

### US-003: Load NeuDecide once at startup
**Description:** As a demo operator, I want the model loaded a single time when the server boots so that no request pays model-load cost.

**Acceptance Criteria:**
- [ ] Model is loaded in a FastAPI lifespan handler and held in app state; it is never constructed per request
- [ ] Startup logs model load duration in ms and confirms CPU/ONNX execution provider
- [ ] A warmup inference runs at startup against a short silent audio buffer so the first real request is not cold
- [ ] `GET /api/health` returns `{"status":"ok","model_loaded":true,"tree_id":"<id>","node_count":N}`
- [ ] Server fails fast with a readable message if the model cannot be loaded
- [ ] `ruff`, `mypy`, `pytest` pass

### US-004: Node-to-tools conversion
**Description:** As a developer, I need each branch node converted into the model's tool format so that the model picks from exactly that node's options.

**Acceptance Criteria:**
- [ ] A pure function converts a branch node into the tool list passed to `model.generate(audio, tools)`
- [ ] Every node's tool list includes a synthetic `none_of_these` tool with no required arguments
- [ ] Each node option becomes a tool whose named argument is an **enum** constrained to that option's declared values
- [ ] Function is pure (no model or network calls) and unit-tested against the sample tree, asserting exact tool-list shape for the root and one mid-tree node
- [ ] `ruff`, `mypy`, `pytest` pass

### US-005: Traversal engine
**Description:** As a developer, I want a traversal engine that walks the tree over one audio buffer so that the traversal logic is testable without HTTP or a browser.

**Acceptance Criteria:**
- [ ] `traverse(audio, tree, model)` yields one step record per `generate()` call: `node_id`, `node_label`, `tool_called`, `arguments`, `latency_ms`, `next_node_id`
- [ ] The **same** audio buffer is passed at every node (no re-recording, no slicing)
- [ ] Traversal stops and reports `unplaced` when the model returns an empty list, returns `none_of_these`, or returns a tool not present in that node's list
- [ ] Traversal stops with `completed` when it reaches a leaf, emitting the leaf recommendation
- [ ] A hard depth cap of 10 steps prevents runaway traversal
- [ ] `latency_ms` measures only the `generate()` call, measured with `time.perf_counter`
- [ ] Unit tests use a fake model (scripted responses) to cover: full happy path to leaf, `none_of_these` at level 1, empty response mid-tree, unknown tool name
- [ ] `ruff`, `mypy`, `pytest` pass

### US-006: Audio validation and decode
**Description:** As a developer, I need uploaded audio validated and decoded so that bad input produces a clear 4xx instead of a model crash.

**Acceptance Criteria:**
- [ ] Accepts WAV upload, 16 kHz mono 16-bit PCM, decoded to the float array shape `neudecide` expects
- [ ] Rejects with HTTP 400 and a specific message: wrong sample rate, more than one channel, non-WAV payload, duration over 30 seconds, duration under 0.3 seconds, body over 2 MB
- [ ] Decode is tested against a generated 1-second 16 kHz mono WAV fixture and at least three rejection cases
- [ ] `ruff`, `mypy`, `pytest` pass

### US-007: SSE traversal endpoint
**Description:** As a frontend developer, I want traversal results streamed per node so that the UI can light up each node at the moment its inference actually returns.

**Acceptance Criteria:**
- [ ] `POST /api/analyze` accepts `multipart/form-data` with a `audio` WAV file and responds `text/event-stream`
- [ ] Emits events in order: `started`, then one `step` per node, then exactly one terminal event (`completed` or `unplaced`), then `done`
- [ ] Each event payload matches the schemas in "API Endpoints" below
- [ ] `completed` includes `total_latency_ms` and the leaf `recommendation`
- [ ] Any mid-stream exception emits an `error` event with a message, then `done`; the connection is never left hanging
- [ ] `GET /api/tree` returns the full tree for rendering, before any recording exists
- [ ] Integration test with `httpx` + a fake model asserts the full event sequence for happy path and unplaced path
- [ ] `ruff`, `mypy`, `pytest` pass

### US-008: Browser recording with waveform and timer
**Description:** As a sales agent, I want to record a customer utterance with visible feedback so that I know the mic is live and how long I have left.

**Acceptance Criteria:**
- [ ] A single button toggles Record → Stop, with a visually distinct recording state
- [ ] A live waveform renders on a Canvas from Web Audio API analyser data while recording
- [ ] A timer counts up as `MM:SS` and the UI makes the 30-second ceiling visible (e.g. "0:12 / 0:30")
- [ ] Recording auto-stops at 30 seconds
- [ ] Captured audio is converted to 16 kHz mono 16-bit PCM WAV in the browser before upload
- [ ] Denied or unavailable microphone shows an inline message, not a silent failure or an alert box
- [ ] Verify in browser using dev-browser skill

### US-009: Recording playback
**Description:** As a sales agent, I want to play back what I just recorded so that I can confirm the audio the model actually heard.

**Acceptance Criteria:**
- [ ] After stopping, a play/pause control plus elapsed-time readout appears for the captured WAV
- [ ] Playback uses the same WAV bytes that are sent to the backend
- [ ] Control is disabled (not hidden) before any recording exists
- [ ] Verify in browser using dev-browser skill

### US-010: Static tree visualization
**Description:** As a demo viewer, I want to see the whole decision tree before anything runs so that I understand the space the model is choosing within.

**Acceptance Criteria:**
- [ ] Tree is fetched from `GET /api/tree` on page load and rendered as an SVG node graph, levels laid out top-to-bottom
- [ ] Every node shows its label; leaf nodes are visually distinct from branch nodes
- [ ] All nodes start in a dimmed "not visited" state
- [ ] Layout is computed from the config, with no node positions hardcoded, so editing `tree.json` alone changes the rendering
- [ ] Verify in browser using dev-browser skill

### US-011: Live path highlighting from SSE
**Description:** As a demo viewer, I want each node to light up as its inference returns so that I can see the traversal happening in real time.

**Acceptance Criteria:**
- [ ] On stop, the frontend POSTs the WAV to `/api/analyze` and consumes the SSE stream
- [ ] Each `step` event lights its node and draws the edge to the next node, in arrival order
- [ ] Each lit node displays: option picked, argument name and value, and `latency_ms`
- [ ] A running total latency is displayed and updates per step
- [ ] Record button is disabled while a traversal is in flight
- [ ] Verify in browser using dev-browser skill

### US-012: Recommendation leaf card
**Description:** As a sales agent, I want the final recommendation in plain language so that I know what to say next.

**Acceptance Criteria:**
- [ ] On `completed`, a card shows the leaf recommendation text prominently, plus the path taken as a readable breadcrumb (e.g. "Pricing question → Pro tier → Budget objection")
- [ ] Card shows total end-to-end latency in ms
- [ ] Card renders only after the terminal event, never mid-traversal
- [ ] Verify in browser using dev-browser skill

### US-013: "Couldn't place this" state
**Description:** As a demo viewer, I want an explicit failure state so that the demo is honest when the model declines to choose.

**Acceptance Criteria:**
- [ ] On `unplaced`, a distinct card reads "Couldn't place this" and names where traversal stopped and why (`none of these` / empty response / unrecognized tool)
- [ ] Nodes visited before the stop remain lit; the unresolved node is marked distinctly from both visited and unvisited
- [ ] No recommendation text is shown in this state
- [ ] Verify in browser using dev-browser skill

### US-014: Reset
**Description:** As a demo operator, I want a one-click reset so that I can run the demo repeatedly in front of an audience.

**Acceptance Criteria:**
- [ ] A Reset button clears the recording, playback control, all node highlighting, latencies, and any result card
- [ ] Tree returns to its fully dimmed initial state without a page reload
- [ ] Reset is available after both `completed` and `unplaced`, and cancels any in-flight stream
- [ ] Two consecutive runs produce correct, non-accumulating results
- [ ] Verify in browser using dev-browser skill

## Functional Requirements

- **FR-1:** The system must load the NeuDecide model once at FastAPI startup, on CPU via ONNX, and reuse it for all requests.
- **FR-2:** The system must read its decision tree from a single JSON file at `config/tree.json` and validate it at startup.
- **FR-3:** The system must capture browser audio and convert it to 16 kHz mono 16-bit PCM WAV before upload.
- **FR-4:** The system must limit a recording to 30 seconds and auto-stop at the limit.
- **FR-5:** At each branch node, the system must call `model.generate(audio, tools)` with tools derived **only** from that node's options, plus a `none_of_these` tool.
- **FR-6:** The system must pass the identical audio buffer to every node's inference call.
- **FR-7:** Each option tool must declare its argument as an enum constrained to that option's declared values.
- **FR-8:** The system must follow the branch matching the returned tool call and repeat until a leaf is reached.
- **FR-9:** The system must terminate as `unplaced` if `generate()` returns an empty list, returns `none_of_these`, or returns a tool absent from the current node's list.
- **FR-10:** The system must measure and report per-call latency in ms, plus total traversal latency.
- **FR-11:** The system must stream one SSE `step` event per inference call so the UI updates incrementally.
- **FR-12:** The frontend must render the full tree before any run and highlight the chosen path node by node as events arrive.
- **FR-13:** The frontend must display, per visited node, the option picked, its arguments, and its latency in ms.
- **FR-14:** The frontend must show a recommendation card on completion and a "couldn't place this" card on `unplaced`.
- **FR-15:** The frontend must provide playback of the captured recording.
- **FR-16:** The frontend must provide a reset that returns the UI to its initial state without a page reload.
- **FR-17:** The system must reject invalid audio with HTTP 400 and a specific reason.
- **FR-18:** The system must support English audio only; no language detection or selection is offered.

## Non-Goals (Out of Scope)

- **Live or multi-turn calls.** One recorded utterance, one traversal. No continuous listening, no streaming audio during the call, no conversation state across utterances.
- **CRM integration.** No Salesforce/HubSpot, no contact records, no logging outcomes anywhere. Nothing is persisted — no database, no run history.
- **Non-English audio.** No multilingual models, no language detection, no translation.
- **Speaker demographics.** No age, gender, accent, or emotion inference, and no UI surface for any of it. Out of scope as a product decision, not just a schedule decision.
- **Transcription.** No ASR text is produced or displayed, even as a debugging aid. The demo's premise is audio → tool call directly.
- **Authentication, multi-user, or deployment.** Single local operator on `localhost`. No login, no hosting, no containers.
- **Tree authoring UI.** The tree is edited as JSON in a text editor. No visual builder.
- **Model training, fine-tuning, or evaluation harness.** The model is consumed as shipped.
- **Mobile layout.** Desktop/laptop browser only (Chrome/Edge).
- **GPU acceleration.** CPU only; sub-second performance on CPU is the claim being demonstrated.

## Design Considerations

### Screen layout (single page, no routing, three columns on a laptop screen)

**Left column — Capture (~25% width).** A large circular Record button at the top; it becomes a Stop button with a red pulse while recording. Directly beneath it, a Canvas waveform spanning the column width, animating live from the mic during recording and sitting flat and gray when idle. Below the waveform, a timer reading `0:08 / 0:30`. Below that, the playback row: a play/pause button and elapsed-time readout, disabled and grayed before a recording exists. At the bottom of the column, a secondary Reset button, enabled only once a run has finished.

**Center column — Tree (~50% width).** The full decision tree as an SVG graph, levels laid out top to bottom: level 1 (intent) as a single root node at top, branching down through product interest, then objection or buying signal, then leaf recommendations at the bottom. Nodes are rounded rectangles with the node label inside; leaves are drawn in a distinct shape and accent color. Every node starts dimmed at low opacity with a thin border. As each `step` event arrives, the chosen node animates to a fully opaque highlighted state and the edge from its parent draws in. The edge to a leaf highlights last. If traversal stops unresolved, the stopping node takes a distinct warning outline rather than the success highlight.

**Right column — Trace (~25% width).** A vertical list of step cards, appended in arrival order. Each card shows the node label as a header, the option picked as a bold line, the argument as `name: value` in monospace, and the latency as a right-aligned `142 ms` badge. A running `Total: 384 ms` sits pinned at the top of the column.

**Result area — below the tree, spanning the center and right columns.** Hidden until the terminal event. On completion: a card with a green accent, the breadcrumb path in small text, the recommendation text at large readable size, and total latency. On `unplaced`: a card with an amber accent reading "Couldn't place this", the node where traversal stopped, and the reason.

### Visual notes

- Dark background suits a conference-room projector and makes the dimmed/lit node contrast read clearly from the back of a room.
- Latency numbers are the hero stat of this demo. Render them in monospace and make them large enough to read from a distance.
- Node highlight transitions should be ~120 ms — enough to see sequence, short enough not to inflate perceived total latency.

## Technical Considerations

- **Backend:** Python 3.11+, FastAPI, Uvicorn. Model loaded in a lifespan handler and stored on `app.state`. Inference is synchronous CPU work, so traversal runs in a thread executor to avoid blocking the event loop.
- **Model:** `neudecide` package on ONNX Runtime, CPU execution provider, 43 MB. A startup warmup inference removes first-call cold cost from the demo.
- **Serving:** FastAPI serves `frontend/` as static files, so the whole demo runs from one process on one port. No separate frontend dev server, no build step.
- **Frontend:** Vanilla HTML/CSS/JS, ES modules, no bundler. Canvas for the waveform, inline SVG for the tree, `fetch` + `ReadableStream` for the SSE response (needed because `EventSource` cannot issue a POST with a file body).
- **Audio:** `getUserMedia` → `AudioContext` at 16 kHz where supported, otherwise resample in an `AudioWorklet`; encode a WAV header client-side. Browser-side conversion keeps the backend free of audio codec dependencies.
- **Tree layout:** computed at render time from node depth and sibling index. No hardcoded coordinates, so a config change is sufficient to re-point the demo.
- **Performance budget:** 3–4 inference calls per run. To hit sub-1-second total, each `generate()` call must average under ~200 ms with ~100 ms for audio handling and transport. Per-call latency is logged server-side so regressions are visible.
- **Error surface:** every failure path (mic denied, audio rejected, model error, stream error) has a named inline UI state. No `alert()`, no silent catch.

### Tree Config Schema

```jsonc
{
  "tree_id": "string",            // identifier, shown in /api/health
  "version": "string",            // free-form, for demo bookkeeping
  "product": "string",            // what is being sold; display only
  "root": "string",               // node id of level 1; must exist in nodes
  "nodes": {                      // map of node id -> node
    "<node_id>": {
      "id": "string",             // must equal its map key
      "type": "branch" | "leaf",
      "label": "string",          // shown in the tree viz
      "level": 1,                 // integer, for layout
      "prompt_hint": "string",    // optional; operator-facing note, not sent to the model

      // branch nodes only:
      "options": [
        {
          "tool_name": "string",  // tool name exposed to the model; snake_case
          "description": "string",// tool description the model sees
          "argument": {
            "name": "string",     // argument name
            "enum": ["string"],   // allowed values; the only values the model may return
            "description": "string"
          },
          "next": "string"        // node id to traverse to; must exist in nodes
        }
      ],

      // leaf nodes only:
      "recommendation": "string", // plain-language line the agent should say
      "rationale": "string"       // optional; why this recommendation, shown small
    }
  }
}
```

Constraints enforced by the loader: `id` matches its key; `root` exists; every `next` resolves; branch nodes have ≥1 option; leaves have `recommendation`; no duplicate `tool_name` within a single node; no cycles. The `none_of_these` tool is injected by the backend and must **not** appear in the config.

### Sample Tree Config

Sample product: **Northbeam Analytics**, a B2B SaaS product analytics subscription with Starter, Pro, and Enterprise tiers.

```json
{
  "tree_id": "northbeam-saas-v1",
  "version": "1.0.0",
  "product": "Northbeam Analytics (B2B SaaS subscription)",
  "root": "intent",
  "nodes": {
    "intent": {
      "id": "intent",
      "type": "branch",
      "label": "Customer intent",
      "level": 1,
      "prompt_hint": "What is the customer fundamentally doing in this utterance?",
      "options": [
        {
          "tool_name": "pricing_question",
          "description": "The customer is asking about price, plans, billing, or what a tier costs.",
          "argument": {
            "name": "pricing_focus",
            "enum": ["plan_cost", "billing_terms", "discount"],
            "description": "The specific pricing concern raised."
          },
          "next": "product_interest"
        },
        {
          "tool_name": "feature_question",
          "description": "The customer is asking what the product does or whether it supports something.",
          "argument": {
            "name": "feature_area",
            "enum": ["dashboards", "integrations", "data_export"],
            "description": "The capability the customer asked about."
          },
          "next": "product_interest"
        },
        {
          "tool_name": "not_interested",
          "description": "The customer is declining, deflecting, or asking to be left alone.",
          "argument": {
            "name": "decline_tone",
            "enum": ["firm", "soft", "defer_to_later"],
            "description": "How firmly the customer is declining."
          },
          "next": "rec_graceful_exit"
        }
      ]
    },

    "product_interest": {
      "id": "product_interest",
      "type": "branch",
      "label": "Product interest",
      "level": 2,
      "prompt_hint": "Which tier does the customer's described scale and need point to?",
      "options": [
        {
          "tool_name": "starter_tier",
          "description": "Small team, single product, light usage; fits the Starter plan.",
          "argument": {
            "name": "team_size_signal",
            "enum": ["solo", "small_team"],
            "description": "Indicated team size."
          },
          "next": "signal_check"
        },
        {
          "tool_name": "pro_tier",
          "description": "Growing team wanting integrations, collaboration, or multiple products; fits Pro.",
          "argument": {
            "name": "growth_signal",
            "enum": ["scaling_team", "multi_product", "needs_integrations"],
            "description": "What indicates Pro-tier need."
          },
          "next": "signal_check"
        },
        {
          "tool_name": "enterprise_tier",
          "description": "Large org raising security, compliance, SSO, procurement, or custom contracts.",
          "argument": {
            "name": "enterprise_driver",
            "enum": ["security_review", "sso_required", "procurement_process"],
            "description": "The enterprise requirement mentioned."
          },
          "next": "signal_check"
        }
      ]
    },

    "signal_check": {
      "id": "signal_check",
      "type": "branch",
      "label": "Objection or buying signal",
      "level": 3,
      "prompt_hint": "Is the customer pushing back, or leaning in?",
      "options": [
        {
          "tool_name": "budget_objection",
          "description": "The customer says it is too expensive or that budget is not available.",
          "argument": {
            "name": "budget_blocker",
            "enum": ["too_expensive", "no_budget_this_quarter", "needs_approval"],
            "description": "The nature of the budget obstacle."
          },
          "next": "rec_budget"
        },
        {
          "tool_name": "timing_objection",
          "description": "The customer is interested but says now is not the right time.",
          "argument": {
            "name": "timing_blocker",
            "enum": ["mid_project", "next_quarter", "team_change"],
            "description": "Why the timing is wrong."
          },
          "next": "rec_timing"
        },
        {
          "tool_name": "competitor_objection",
          "description": "The customer mentions an incumbent or alternative tool they already use or prefer.",
          "argument": {
            "name": "competitor_stance",
            "enum": ["already_using", "evaluating_both", "contract_locked"],
            "description": "Their relationship with the alternative."
          },
          "next": "rec_competitor"
        },
        {
          "tool_name": "buying_signal",
          "description": "The customer is moving forward: asking about next steps, trials, demos, or onboarding.",
          "argument": {
            "name": "readiness",
            "enum": ["wants_trial", "wants_demo", "ready_to_buy"],
            "description": "How ready they are to proceed."
          },
          "next": "rec_advance"
        }
      ]
    },

    "rec_budget": {
      "id": "rec_budget",
      "type": "leaf",
      "label": "Reframe on value",
      "level": 4,
      "recommendation": "Acknowledge the budget constraint, then move the conversation from price to cost-of-delay: ask what they currently spend in analyst hours pulling these numbers by hand. Offer the lower tier as a starting point rather than discounting the one they asked about.",
      "rationale": "A budget objection is rarely about the number; it is about unproven value. Shrink the commitment instead of the price."
    },
    "rec_timing": {
      "id": "rec_timing",
      "type": "leaf",
      "label": "Secure a dated follow-up",
      "level": 4,
      "recommendation": "Agree that timing matters and do not push for a decision now. Pin down a specific date to revisit, and ask what needs to be true by then. Offer to send a short summary they can forward internally in the meantime.",
      "rationale": "Timing objections are usually genuine. The win here is a dated next step, not a close."
    },
    "rec_competitor": {
      "id": "rec_competitor",
      "type": "leaf",
      "label": "Differentiate, do not attack",
      "level": 4,
      "recommendation": "Do not criticize the tool they already use. Ask what it does well and where it falls short, then speak only to that gap. If they are locked into a contract, offer to run a parallel pilot so there is evidence ready at renewal.",
      "rationale": "Attacking an incumbent attacks their past decision. Finding the gap gives them a reason to add you without admitting a mistake."
    },
    "rec_advance": {
      "id": "rec_advance",
      "type": "leaf",
      "label": "Advance to next step now",
      "level": 4,
      "recommendation": "They are leaning in — stop selling and start scheduling. Confirm the tier, name the next concrete step, and get it on the calendar before the call ends. Ask who else needs to be in the room.",
      "rationale": "A buying signal has a short shelf life. Converting it into a scheduled commitment on the call is the whole job."
    },
    "rec_graceful_exit": {
      "id": "rec_graceful_exit",
      "type": "leaf",
      "label": "Exit cleanly",
      "level": 2,
      "recommendation": "Thank them for their time and close without pressure. Ask one short question about whether the timing or the fit is the issue, accept the answer, and leave the door open for later.",
      "rationale": "A clean exit preserves the option of a future conversation. Pressing a firm no destroys it."
    }
  }
}
```

Note that `rec_graceful_exit` is a level-2 leaf: the tree is not required to be a uniform depth, and a `not_interested` intent short-circuits to a recommendation after one inference.

## API Endpoints

### `GET /api/health`
Readiness and demo-state check.
```json
{ "status": "ok", "model_loaded": true, "model_load_ms": 412, "tree_id": "northbeam-saas-v1", "node_count": 8 }
```

### `GET /api/tree`
Returns the validated tree config verbatim (schema above), for rendering the static visualization before any run.

### `POST /api/analyze`
**Request:** `multipart/form-data`, field `audio`: WAV, 16 kHz mono 16-bit PCM, 0.3–30 s, ≤ 2 MB.
**Response:** `text/event-stream`.

Event sequence: `started` → one `step` per inference → exactly one of `completed` / `unplaced` → `done`. An `error` event may replace the terminal event; `done` is always last.

```
event: started
data: {"tree_id":"northbeam-saas-v1","root":"intent","audio_duration_ms":4210}

event: step
data: {"index":0,"node_id":"intent","node_label":"Customer intent",
       "tool_called":"pricing_question","arguments":{"pricing_focus":"plan_cost"},
       "latency_ms":138,"next_node_id":"product_interest"}

event: step
data: {"index":1,"node_id":"product_interest","node_label":"Product interest",
       "tool_called":"pro_tier","arguments":{"growth_signal":"scaling_team"},
       "latency_ms":131,"next_node_id":"signal_check"}

event: step
data: {"index":2,"node_id":"signal_check","node_label":"Objection or buying signal",
       "tool_called":"budget_objection","arguments":{"budget_blocker":"too_expensive"},
       "latency_ms":142,"next_node_id":"rec_budget"}

event: completed
data: {"leaf_node_id":"rec_budget","label":"Reframe on value",
       "recommendation":"Acknowledge the budget constraint, then ...",
       "rationale":"A budget objection is rarely about the number ...",
       "path":["intent","product_interest","signal_check","rec_budget"],
       "inference_count":3,"total_inference_ms":411,"total_latency_ms":498}

event: done
data: {}
```

Unplaced terminal event:
```
event: unplaced
data: {"stopped_at_node_id":"product_interest","stopped_at_label":"Product interest",
       "reason":"none_of_these","path":["intent","product_interest"],
       "inference_count":2,"total_inference_ms":270,"total_latency_ms":341}
```
`reason` is one of `none_of_these`, `empty_response`, `unknown_tool`, `depth_limit`.

Error event:
```
event: error
data: {"message":"Inference failed at node 'signal_check'","node_id":"signal_check"}
```

**Audio rejection** happens before the stream opens and returns HTTP 400 JSON:
```json
{ "detail": "Audio must be 16000 Hz mono; received 44100 Hz stereo." }
```

### `GET /` and `/static/*`
Serves the frontend from `frontend/`.

## Acceptance Criteria (MVP ships when all of these hold)

**Functional**
- [ ] AC-1: From a clean checkout, documented install and run commands bring the app up on `localhost` and `GET /api/health` reports `model_loaded: true`.
- [ ] AC-2: Pressing Record shows a live waveform and a counting timer; pressing Stop ends capture; recording auto-stops at 30 s.
- [ ] AC-3: Playback plays back the exact audio that was sent to the backend.
- [ ] AC-4: The full tree renders from `tree.json` on page load, dimmed, with no hardcoded node positions.
- [ ] AC-5: A clear utterance matching the sample tree traverses to a leaf, lighting 3–4 nodes in arrival order.
- [ ] AC-6: Each visited node displays the option picked, its argument name and value, and its latency in ms.
- [ ] AC-7: The recommendation card shows the leaf text, the breadcrumb path, and total latency.
- [ ] AC-8: An off-topic utterance (e.g. weather chat) produces the "couldn't place this" card naming the stopping node and reason, with no recommendation shown.
- [ ] AC-9: Reset returns the UI to its initial state with no page reload, and a second run produces correct non-accumulating results.
- [ ] AC-10: Editing `config/tree.json` — renaming a node label and adding one option — changes both traversal and rendering after a server restart, with no code edit.

**Performance**
- [ ] AC-11: Median total traversal latency (`total_latency_ms`, measured over 20 runs on laptop CPU) is under 1000 ms; p95 under 1500 ms.
- [ ] AC-12: Per-call `generate()` latency is logged server-side for every call.
- [ ] AC-13: The first request after startup is not measurably slower than subsequent ones (startup warmup is working).

**Robustness**
- [ ] AC-14: Denied microphone permission shows an inline message and leaves the app usable.
- [ ] AC-15: Non-WAV, wrong sample rate, stereo, over-30 s, and under-0.3 s audio each return HTTP 400 with a specific reason surfaced in the UI.
- [ ] AC-16: An invalid `tree.json` fails at startup with a single-line error naming the offending node id.
- [ ] AC-17: A model exception mid-traversal produces an `error` event and a recoverable UI state, not a hung spinner.

**Quality**
- [ ] AC-18: `ruff check`, `mypy`, and `pytest` all pass.
- [ ] AC-19: Traversal, node-to-tools conversion, tree validation, and audio decode have unit tests using a fake model; `/api/analyze` has an SSE integration test.
- [ ] AC-20: `README.md` documents setup, run, how to edit the tree, and a suggested demo script with example utterances per branch.

## Risks

**R-1: Misfires on noisy or accented audio.** The model maps audio directly to a tool call with no transcript to inspect, so a wrong branch gives no diagnostic trail. In a live demo room with HVAC and crowd noise, a misfire looks like the product is broken.
*Mitigation:* ship a demo script with utterances verified in advance; recommend a headset mic; keep the trace panel visible so a wrong-but-plausible pick reads as a model choice rather than a bug. Playback lets the operator confirm what the model actually received.

**R-2: Branching early in the tree is unrecoverable.** A wrong pick at level 1 (intent) makes every subsequent call irrelevant, and the leaf will be confidently wrong. Error at the root costs the whole run.
*Mitigation:* keep level-1 options few, maximally distinct, and clearly described; prefer `none_of_these` over a weak guess by writing tight tool descriptions. Document this as a known property of greedy tree traversal rather than hiding it — it is a legitimate design discussion for viewers evaluating the approach. Backtracking is explicitly deferred to post-MVP.

**R-3: Open-ended arguments degrade reliability.** Enum arguments constrain the output space and keep the model honest. Any free-text or numeric argument reintroduces the open-ended generation this architecture avoids, and will be the first thing to produce garbage.
*Mitigation:* the schema permits enums only; the loader rejects argument specs without an `enum`. Resist adding free-text arguments to make a demo richer.

**R-4: Latency budget is tight.** 3–4 sequential inferences must total under a second. A slower laptop, a deeper tree, or a cold model blows the headline claim — which is the main thing being demonstrated.
*Mitigation:* startup warmup; cap demo trees at 4 levels; log per-call latency so regressions are caught; surface the real number in the UI rather than a rounded claim.

**R-5: Browser audio pipeline variance.** Resampling to 16 kHz mono differs across browsers and OS audio stacks; a subtly wrong WAV header or sample rate will produce confidently wrong model output rather than an error.
*Mitigation:* validate sample rate and channel count server-side and reject mismatches loudly; pin the demo to one tested browser (Chrome/Edge); include a fixture WAV in the repo for backend testing independent of the browser.

**R-6: `neudecide` tool-schema assumptions may not match the shipped API.** This PRD assumes `model.generate(audio, tools)` accepts a JSON-schema-like tool list with enum arguments and returns a list of tool calls. If the real signature differs, US-004 and US-005 change shape.
*Mitigation:* confirm against the installed package before US-004; the node-to-tools conversion is deliberately isolated in one pure function so an API mismatch is a single-file change.

**R-7: Demo over-reads as a product.** Viewers may assume live call handling and CRM integration are present or imminent.
*Mitigation:* the UI frames this as one recorded utterance; the README and demo script state the single-iteration scope plainly.

## Success Metrics

- Median total traversal under 1000 ms on laptop CPU over 20 runs.
- 3 of 3 planned happy-path demo utterances reach their intended leaf on the first attempt, in a normal room.
- Off-topic audio produces "couldn't place this" rather than a wrong recommendation, at least 8 of 10 times.
- A new vertical can be demoed by editing only `config/tree.json` — measured by actually doing it once, timed, and documented in the README.
- A colleague who did not build it can run the demo from the README without asking a question.

## Next Steps After MVP

1. **Multi-turn traversal.** Keep tree position across utterances so an agent can advance the tree over a real conversation rather than one recording.
2. **Confidence and backtracking.** Surface per-call confidence, and retry the parent node with a reduced option set when confidence is low — directly addressing R-2.
3. **Streaming audio.** Run traversal on a live mic stream with partial-utterance inference, rather than record-then-analyze.
4. **Tree authoring UI.** A visual editor over the same JSON schema, so non-engineers can build verticals.
5. **Batch evaluation harness.** A labeled corpus of utterances with expected leaves, so tree edits and model versions can be scored rather than eyeballed.
6. **Multilingual.** Add a second language once the single-language flow is proven.
7. **CRM write-back.** Log the traversal path and recommendation against a contact record.
8. **Packaging.** Containerize, or ship as a desktop app, so the demo runs without a Python environment.

## Open Questions

1. **`neudecide` tool-call API shape** — needs confirmation against the installed package before US-004: the exact tool schema format, the return type of `generate()`, and whether an explicit "no match" is expressible natively or must be a synthetic `none_of_these` tool as assumed here.
2. **Does `generate()` accept a file path, bytes, or a NumPy float array?** Determines whether the backend decodes WAV itself (US-006) or hands off the bytes.
3. **Is `generate()` thread-safe?** If not, inference needs a lock or a single-worker executor, which caps concurrency — acceptable for a single-operator demo but worth knowing.
4. **Should `prompt_hint` ever be passed to the model?** Currently operator-facing only. If the API accepts a system-prompt-equivalent, it may improve level-1 accuracy.
5. **Breadcrumb wording** — should the path show node labels ("Customer intent") or chosen options ("Pricing question")? Options read better; assumed in US-012, worth confirming with whoever runs the demo.
6. **Does the demo need a "load a sample recording" button** for rooms where live mic capture is unreliable? Cheap insurance against R-1/R-5 but adds a fixture-audio path not currently scoped.
```
