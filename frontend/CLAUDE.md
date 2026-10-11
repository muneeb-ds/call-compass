# frontend/ — CallCompass demo UI

Vanilla ES modules served by FastAPI from `/`. **No bundler, no node_modules, no build
step, no JS typecheck or lint.** Everything here is loaded directly by the browser, so
every file must be valid in the browser as-is.

## Checks available for this directory

```bash
node --check frontend/*.js                 # syntax only
cd backend && ../.venv/bin/pytest tests/test_frontend_{audio,timing,playback,tree,analysis,reset}.py
```

`tests/test_frontend_audio.py` is the only automated coverage the audio pipeline has: it
runs the **shipped** `wav.js` and worklet resampler under node (`tests/encode_fixture.mjs`)
and feeds the bytes to the real `decode_wav` and to `POST /api/analyze`. If you change
either file, run it — a wrong header or rate makes the model answer confidently about
audio it misheard (PRD risk R-5) rather than erroring.

`tests/test_frontend_timing.py` does the same for `timer.js`: it asserts the UI's
ceiling equals `callcompass.audio.MAX_SECONDS` and that an overshooting auto-stop still
uploads clean. **Any pure, contract-bearing JS belongs in a module node can import, so
it can be pinned from pytest this way** — that is the only test runner this directory has.

## Module layout

- `wav.js` — the **only** module that knows the audio wire format: `encodeWav(samples,
  rate)` → `Uint8Array`, plus `concatChunks`, `clampSamples`, `SAMPLE_RATE`, `MAX_SECONDS`.
  Pure: no DOM, no AudioContext, so node can run it. `-1.0` must map to exactly `-32768`
  because the backend divides by 32768. Every format limit the UI needs is re-exported from
  here rather than written out a second time.
- `recorder-worklet.js` — the AudioWorklet. Loaded via `audioWorklet.addModule()`, which
  runs it as a **classic script**: it cannot `import` anything and must stay
  self-contained (hence the resampler living here, not in `wav.js`). Registered under the
  name `recorder`. Keep `createResampler` / `downmix` as top-level functions that touch no
  worklet globals, so the node harness can load it with the globals stubbed. The
  processor's `this.port.onmessage` (set in its constructor) accepts
  `{type: "paused", value: boolean}` and flips an internal `paused` flag; `process()`
  returns early (skipping the resampler entirely) while paused, so no chunk is posted
  and no gap or extra silence is introduced at the splice when it resumes. This is the
  one message type the port protocol carries inbound — the outbound direction is still
  only the resampled `Float32Array` chunks.
- `capture.js` — `Recorder` (start/stop/release) and `MicrophoneError`. `stop()` returns
  the encoded bytes **and** a Blob over the same bytes; use those bytes for both upload and
  playback, never a separate MediaRecorder blob. `pause()`/`resume()` (US-026) hold the take
  open without tearing anything down — the `MediaStream`/`AudioContext`/worklet/analyser
  stay alive, so `resume()` needs no new permission prompt. Both are plain no-ops guarded by
  `this.recording`/`this.paused`, safe to call twice. The pause signal travels over
  `node.port.postMessage({type: "paused", value})` to the worklet rather than
  disconnecting/suspending anything — see `recorder-worklet.js` below. `release()` (and
  therefore `stop()`) always clears `paused`, so a later `start()` begins unpaused.
  `Recorder` also tracks `sampleCount`/`segmentStart`/`rawSegments` (US-027): every message
  from the worklet adds to `sampleCount`, and `pause()`/`stop()` close the currently-open
  segment at that running count (`resume()` opens the next one the same way) — **never** at
  a `performance.now()` mark, because a segment boundary has to land on the real splice in
  the encoded WAV, and only sample counts stay aligned with it. `stop()` converts those raw
  sample bounds to the `Recording.segments` the rest of the app sees via the pure, exported
  `deriveSegments(rawSegments, keptSamples, sampleRate)`, which also clips any bound past
  `keptSamples` — the sample count `clampSamples` actually kept after trimming the tail at
  the 30s ceiling.
- `timer.js` — the recording clock: pure `formatClock` / `formatElapsed` (now takes a
  `paused` flag that appends `· paused`) / `accumulatedElapsed` / `remainingMs`, the
  `MAX_RECORDING_MS` ceiling (derived from `wav.js`), and `RecordingTimer`, which owns both
  the display tick and the auto-stop. The ceiling is enforced by its own `setTimeout`, not
  by the tick, so the stop lands on the limit rather than up to a tick late.
  `RecordingTimer.pause()`/`resume()` (US-027) freeze/resume `elapsedMs`: `startedAt` is the
  `performance.now()` mark for the span currently running (`0` while paused/stopped) and
  `accumulatedMs` is the total already folded in from closed spans — `elapsedMs` is just
  `accumulatedElapsed(accumulatedMs, startedAt, performance.now(), limitMs)`, which is why
  that function is pure and exported: it is the one place "time across a pause" is computed,
  and it is what node pins instead of exercising real `setInterval`/`performance.now()`
  timing. `resume()` reschedules the ceiling `setTimeout` via `remainingMs(accumulatedMs,
  limitMs)` rather than the full `limitMs`, so a paused take can neither exceed the limit
  nor auto-stop early.
- `waveform.js` — `Waveform(canvas)`: `start(analyser)` runs a `requestAnimationFrame` loop
  over `getByteTimeDomainData`, `stop()` leaves a flat gray baseline. Cosmetic only; it
  never reads or alters the captured samples. The canvas is sized by CSS and its backing
  store is re-matched per frame, so never set `canvas.width`/`height` in HTML. Its two
  trace colours are read once at construction via `readColorToken(name, fallback)`, which
  calls `getComputedStyle(document.documentElement)` on the `styles.css` custom property
  and falls back to the hardcoded hex when `getComputedStyle`/`document` don't exist (the
  node test harness) - that fallback is what keeps this module node-testable without a DOM.
  `freeze()`/`unfreeze()` (US-028) pause the `requestAnimationFrame` loop without
  clearing `this.analyser`/`this.data` the way `stop()` does, so the last live frame
  stays on screen instead of settling to the idle baseline — that is what lets a
  paused take read as "held", not "stopped". `renderRecording(samples, segments)`
  (US-029) draws a **static** peak-envelope waveform of a finished take instead of the
  live analyser trace, with a vertical marker (`this.markerColor`, the `--warning`
  token) at each boundary between `segments` — the exact `Recording.segments` shape
  from `capture.js` (millisecond offsets; a single-segment take draws no markers,
  since there is no boundary between one span and itself). The pure half,
  `peakEnvelope(samples, columns)`, is exported and node-testable: it returns one
  `{min, max}` pair per column rather than an average, so a one-sample transient
  between two silent samples still shows up instead of being smoothed away. The
  static drawing **persists**: `render()` redraws from the stored `recordingSamples`
  on every call (including a resize), and only `start()`/`stop()` clear it back to
  the live/idle path — never a silent timeout. `Recording.samples` (the decoded
  `Float32Array` `capture.js`'s `stop()` already computes before encoding) is what
  feeds this, so the waveform never re-decodes the WAV bytes it just encoded.
- `playback.js` — `Playback(button, readout, audio)`: play/pause over the recording's own
  `blob`, so the operator hears the exact bytes the backend received. Takes its three DOM
  elements as arguments and never touches `document`, which is what lets node drive it with
  stubs. `clear()` is the empty state (**disabled, not hidden**) and also revokes the object
  URL; call it whenever the recording it points at stops being current.
- `tree.js` — the decision-tree drawing. `layoutTree(tree)` and `wrapLabel` are pure
  (node-testable) and derive **every** coordinate from the graph: depth is the longest
  path from the root, the sibling index sets x. No node id and no coordinate is ever
  hardcoded — `test_frontend_tree.py` asserts the sample tree's ids appear nowhere in
  this file, because "re-point the demo by editing JSON only" (PRD AC-10) depends on it.
  Two options sharing a `next` draw **one** node and **one** edge, keyed
  `edgeKey(from, to)`. `TreeView(svg)` draws it; every node and edge starts at
  `data-state="idle"`, and highlighting stories should only flip `data-state` and add a
  CSS rule — never re-render to change a look. `reset()` returns everything to idle.
  `TreeView.annotate(id, lines)` writes the live detail under a node into a `<text>` that
  was drawn **empty at render time**, for the same reason: filling text is not re-rendering.
- `sse.js` — the **only** module that knows the `text/event-stream` wire format.
  `streamAnalyze(bytes, {onEvent, signal, fetchImpl})` POSTs the WAV as multipart and calls
  `onEvent` per frame; a non-200 becomes an `AnalyzeError` carrying the backend's `detail`.
  `SseDecoder`/`parseFrame` are pure and **incremental** — a frame boundary can land anywhere
  in a network read, so never parse by splitting a finished body. `fetchImpl` is injectable
  purely so node can drive the real path.
- `trace.js` — the Trace column. `humanize` / `formatArguments` / `formatLatency` /
  `formatTotal` are pure and are the **single** naming of an option on screen; the tree
  annotations and US-014's breadcrumb must reuse them rather than re-format. `Trace(totalEl,
  listEl)` appends one card per step; `setTotal(ms)` overrides the accumulated figure with the
  terminal event's authoritative `total_inference_ms`, which is also how a run with zero steps
  still shows a total.
- `analysis.js` — one run: SSE frames in, lit tree and trace cards out. Takes `Trace` and
  `TreeView` as arguments and touches no DOM. **Nodes light on actual event arrival** — no
  artificial delays, ever; the real per-call timing is what the demo exists to show. The leaf
  gets no `step` of its own, so it lights on the terminal event. `onTerminal` / `onError` are
  the hooks US-014/US-015 should subscribe to rather than re-reading the stream, and
  `reset()` / `cancel()` are what US-016's button calls. An `error` event is a **finished**
  run (the backend always sends `done` after it), so `onError` fires and the stream resolves
  normally — never treat it as a throw or leave a spinner turning on it. It also records every step's
  `tool_called` in `picks`, which is the outcome strip's breadcrumb — the strip must not
  re-derive the path from the terminal event's `path` (those are node ids). `onStep(step,
  index)` fires right after `trace.addStep` for the same step, with that step's 0-based
  arrival index (`picks.length - 1`) — US-006's trace rail is built on this rather than
  reading `Trace`'s rendered DOM. `data-state="active"` marks the single node whose
  inference is currently in flight (`this.active`), derived client-side because the
  backend only yields a `Step` after a node's inference *returns* — there is no "about
  to infer" wire event. `started.root` activates the root; each `step.next_node_id`
  activates the next frontier right after that step's own node flips to `visited`;
  every terminal path (`completed`/`unplaced`/`error`) clears `this.active` to `null`
  after flipping the frontier node to `visited`/`warning`. A future story touching the
  frontier should extend `activate()`/the `handle()` branches rather than tracking a
  second copy of "where the model is" elsewhere. `onActivate(id)` fires from inside
  `activate()` itself, so it covers both the root-on-`started` and the
  `next_node_id`-on-`step` cases for free — `viewport.js`'s auto-follow is built on this
  rather than a second frontier tracker.
- `trace-panel.js` — the collapsed trace rail and the slide-over panel it opens. `trace.js`'s
  public API is frozen, so the **panel** is just `index.html` chrome around the exact
  `trace-total`/`trace-list` elements `Trace` already renders into — no module owns it.
  `TraceRail(listEl, totalEl, {onSelect})` is the sibling view: it accumulates its own
  running total from `Analysis.onStep`'s `latency_ms` figures (same arithmetic as `Trace`,
  deliberately duplicated rather than scraping `Trace`'s text), and `setTotal(ms)` takes the
  terminal event's authoritative figure the same way `Trace.setTotal` does. `onSelect(index)`
  fires on a chip click; wiring it to `panel.open()` plus `trace.listEl.children[index]
  .scrollIntoView()` is what opens the panel scrolled to the matching card.
  `TracePanel(panelEl, toggleEl, {doc})` owns open/closed as `data-state="open"|"collapsed"`
  plus the toggle's `aria-expanded`; `doc.addEventListener("keydown", ...)` is how `Escape`
  closes it, and `doc` is optional so the node harness can drive open/close/toggle without a
  real `document`. **Neither class is ever touched by `Analysis.reset()`/`resetAll`** — the
  panel's open state is a viewer preference, not run state, which is what lets it survive a
  run and a reset; only `app.js`'s `analysis.onReset` clears the rail.
- `outcome.js` — the outcome strip, in the dock. `breadcrumb(picks)` / `formatEndToEnd(ms)` /
  `formatInferenceCount(n)` / `reasonText(reason, label)` are pure; `OutcomeStrip(container)`
  draws **only** from a terminal event, so an in-flight run can never be read as an answer.
  The breadcrumb names the **chosen options** (`humanize`d from `trace.js`), not the node
  labels, and the strip's latency is `total_latency_ms` (end to end) — deliberately a
  different number from the Trace column's inference-only total, which is why it is
  labelled "end to end". `clear()` is the **absent** state (no children, no `data-state`
  at all — not an empty placeholder box) and is wired to `Analysis.onReset`. There are
  **three** terminal looks — `completed` (green), `unplaced` (amber, with **no** leaf
  label at all), `errored` (red) — and they share one line shape; the accent comes from
  the container's `data-state`, so a new state is a CSS block plus a method, never new
  markup. `.outcome-line` and its children truncate with `text-overflow: ellipsis`
  rather than wrap, which is what keeps the strip to one line and the dock under its
  ~15vh ceiling regardless of how long the breadcrumb or reason text gets.
  `STOP_REASONS` is keyed by the exact `StopReason` literals in
  `callcompass/traversal.py` and `test_frontend_outcome.py` pins the two sets equal, so
  **adding a backend stop reason fails here until the UI has a sentence for it**.
- `viewport.js` — the stage camera. `frameFor(layout, nodeId, aspect, zoom)` is pure: it
  reads a `layoutTree` result and a node id and returns the `{x, y, width, height}`
  viewBox that centres that node with its immediate parent row and child row visible,
  clamped to never pan narrower than a `fitAspect`-matched whole-tree frame — when the
  3-row window would already be no smaller than the whole tree, the whole tree is framed
  instead (centred on the tree, not the node), which is what keeps a small operator tree
  from jittering. It never reads a node's documentary `level` field or recomputes
  coordinates — `layout.nodes[].level/x/y` from `tree.js` is the only source of depth and
  position. `Viewport(svg, deps)` is the drawing half: it owns the `<svg>`'s `viewBox`
  attribute and animates toward whatever frame `goTo(target)` is given, over ~220 ms
  ease-out, cancelling any animation already in flight; under
  `prefers-reduced-motion: reduce` (or with no prior box to lerp from) it jumps straight
  there. The viewBox is animated, never a CSS transform on the `<svg>`, so stroke widths
  and the node detail text stay at constant screen size through a pan. `deps` (raf/caf/
  now/reducedMotion) are injectable the same way `waveform.js` injects
  `getComputedStyle`, purely so a node test could drive the animation loop without a
  browser — though `test_frontend_viewport.py` only pins `frameFor`, the pure half, the
  same split `test_frontend_tree.py` makes for `layoutTree` vs `TreeView`. Auto-follow is
  wired from `Analysis.onActivate(id)` (fired from `activate()` alongside the existing
  `data-state="active"` flip) in `app.js`'s `wireAnalysis`, reading the stage's live
  `getBoundingClientRect()` aspect ratio on every call so a window resize is picked up
  for free on the next frontier move — but through `viewport.autoGoTo(target)`, not
  `goTo` directly: `autoGoTo` always records `target` as `lastAutoTarget` but only
  animates there while `viewport.following` is true. `panBox(box, dx, dy)` and
  `zoomBox(box, factor, anchorX, anchorY, bounds)` are the pure halves of manual pan/
  zoom (node-tested via `viewport_manual_fixture.mjs`); `zoomBounds(wholeTreeFrame)`
  derives the "neither inverted nor shrunk to a dot" clamp from the whole-tree frame
  itself rather than a fixed pixel constant, so it scales with whatever tree is loaded.
  `Viewport.enableManualControls({followButton, fitButton, doc})` is the DOM glue —
  pointer drag-to-pan, wheel/pinch-to-zoom (two simultaneous pointers), and the +/-
  keys (ignored while `isTextInputFocused`, exported so `app.js`'s `Space`/`P` capture
  shortcuts (US-028) reuse the same focus check) — and is reviewed, not node-tested, same
  split as `goTo`'s animation loop. Any manual pan/zoom/`fit()` calls
  `disableFollow()`, which enables the Follow button (per this file's "disabled, never
  hidden" rule, it is never `hidden`); `follow()` re-arms `following` and jumps back to
  `lastAutoTarget`. `resetView()` (US-030) is the other re-arming path and is distinct
  from `follow()`: it clears `lastAutoTarget` and goes to the **whole-tree frame**
  instead, because the start of a new take (a fresh run, or the Reset button) must not
  open the camera on the previous run's leaf — `follow()` is for re-arming auto-follow
  *mid-run*, `resetView()` is for the boundary between runs. `Analysis.onReset` calls
  `viewport.resetView()` — and `reset()` runs at the top of every `run()`, not only from
  the Reset button — which is what makes "auto-follow resumes and the camera returns to
  the whole tree on the next run or on reset" free without a second code path.
- `position.js` — the status bar's position readout. `formatPosition({label, depth,
  maxDepth, inferenceCount})` is pure and omits the `· inference N` segment when
  `inferenceCount` is `null`/omitted, which is the only difference between the pre-run
  and in-run text. `PositionReadout(el)` owns the drawing half and takes its element
  as a constructor argument like every other module here. `setLayout(layout, rootId)`
  attaches the same `layoutTree` result `viewport.js` reads (never a second depth
  calculation, never the config's documentary `level` field — `node.level` is
  0-indexed, the readout's `Depth D` is `level + 1`) and shows the pre-run root
  statement with no count. `activate(id)` is wired to `Analysis.onActivate` and
  increments its own running inference count on every frontier move — the same hook
  `viewport.js`'s auto-follow uses, so "where the model is" has one source. `finish(id,
  inferenceCount)` is wired to `onTerminal`/`onError` and freezes the readout
  (`this.done` blocks any further `activate()`); `completed`/`unplaced` pass the
  terminal event's own authoritative `inference_count` rather than trusting the
  client's running count, which only ever matches it by coincidence — the client counts
  frontier moves (one extra, for the leaf becoming active with no step of its own),
  the backend counts actual `generate()` calls. An `error` event carries no count, so
  it freezes on whatever the client had already tracked. `reset(rootId)` (wired to
  `Analysis.onReset`) returns to the pre-run statement for the next run.
- `reset.js` — the Reset button. `resetAll({analysis, capture})` is the teardown and is
  pure wiring, so its **order** is assertable from node: cancel the in-flight stream
  *before* clearing, or a chunk already in flight repaints a node the tree just dimmed.
  `analysis.reset()` cascades, through the `onReset` hook `app.js` wires, into every
  surface that only came into existence in a later story — the trace rail, the outcome
  strip, the viewport (back to the whole-tree frame, auto-follow re-armed), and the
  position readout (back to the root) — so `resetAll` itself never grew new parameters
  as those stories landed. The **one** surface deliberately left alone by that cascade
  is the trace panel's open/closed state — a viewer preference, not run state, so it
  survives both a run and a Reset press. `ResetControl(button, onReset)` keeps its
  state in the DOM's own `disabled` — there is no second copy — and `trigger()` is a
  no-op while disarmed. It is armed only by a **finished** run (terminal event, `error`
  event, or a rejected upload) and disarmed by its own press, which is what lets it
  stay live across a later run and cancel it.
- `app.js` — page wiring only. Exports its entry points (`checkHealth`, `loadTree`,
  `wireCapture`, `wireAnalysis`, `main`) so a later story can call them instead of
  re-deriving. `wireCapture({onRecording})` returns
  `{ recorder, waveform, timer, playback, toggle, reset, latest }`; `onRecording` is **awaited
  inside the guarded `toggle()`**, which is what keeps the Record button disabled for the whole
  traversal without inventing a second flag. `wireAnalysis(loading, {onFinish})` reports a run
  ending by **any** route through that one hook; it also builds the `TraceRail`/`TracePanel`
  pair and wires `analysis.onStep`/`onReset` to the rail, and builds the `PositionReadout`,
  calling its `setLayout` once `loading` resolves (`rootId` is captured there too, for
  `onReset`). `main()` returns
  `{ analysis, outcome, panel, viewport, position, capture, reset, loading }` — drive
  those rather than re-querying the DOM.
  Teardown is never re-derived: `capture.reset()` and `Analysis.reset()` each own their half,
  and a story that adds UI should clear it from the owning half or from `Analysis.onReset`.
  `wireCapture`'s `pauseToggle()` (US-028) shares `toggle()`'s `busy` flag by checking
  it rather than setting it (`pause()`/`resume()` are synchronous), which is what drops
  a pause click racing the auto-stop's `toggle()` call. `renderPause()` is the single
  place the dock's `#dock` `data-state` (`idle`/`recording`/`paused`) and the pause
  button's label/`aria-pressed`/`disabled` are derived from `recorder.recording`/
  `recorder.paused` — call it anywhere either flag might have changed rather than
  touching the button or the dock directly. The `Space`/`P` shortcuts live in a single
  `document`-level `keydown` listener inside `wireCapture`, gated by `viewport.js`'s
  exported `isTextInputFocused` (shared rather than reimplemented) and by
  `preventDefault()`, which also suppresses a focused button's own native
  space-activation so a focused Record/Pause button does not double-fire.

## Looking at the UI without a browser

There is no browser tool here. `qlmanage -t -s 1400 -o /tmp page.html` rasterizes a
**standalone HTML** file through WebKit (and the same works for `.svg`), and the Read
tool can view the PNG. Build that file by driving the *shipped* module over a stub
element that can serialize itself, with the real `styles.css` inlined — re-implementing
the markup by hand produces a picture that is wrong in ways that read as app bugs.

## Conventions

- **Focus and motion are handled once, centrally, in `styles.css`.** A single
  `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` rule at
  the top of the file covers every interactive control — don't add a per-component
  focus style. Tab order is DOM order (no `tabindex` anywhere); keep a new control's
  markup position equal to its visual position rather than reordering via CSS. Every
  animation introduced for v2 (the active-node pulse, the viewport's viewBox tween,
  the trace panel slide, the dock's state-change transition) has a matching
  `@media (prefers-reduced-motion: reduce)` override next to its definition — a new
  one needs the same pairing. The `active` tree-node state keeps a **static** halo
  (`filter: drop-shadow(...)`, not just the animated keyframe) specifically so it
  stays visually distinct from `visited` by shape/ring even with the loop suppressed
  — never rely on `stroke`/fill colour alone to distinguish a node state, since colour
  is the one channel reduced-motion and colour-blind viewers can't be assumed to read.
- **SVG text that sits over the graph gets a halo**, not a z-order fix: `paint-order: stroke`
  plus a `stroke: var(--bg)` (see `.tree-detail`). Node groups already paint after the edge
  layer, and it is still unreadable where a freshly-lit edge runs under the text.
- **Capture failures are shown inline** in the Capture column (`#capture-message`).
  Never `alert()`, never a silent catch — a demo operator has to see on screen that the
  mic was denied.
- UI state lives in `data-*` attributes set from the real object's state
  (`data-recording` from `recorder.recording`, `data-playing` from `audio.paused`), not in a
  parallel CSS class.
- **A control with no data yet is `disabled`, never `hidden`.** The Capture column must not
  change shape on the first run — an operator mid-demo should not see widgets appear.
- **Take DOM elements as constructor arguments** rather than calling `document.getElementById`
  inside a module. `app.js` owns every lookup; that is what makes a module node-testable.
  A module that must *create* elements (`tree.js`) goes through `el.ownerDocument`, not the
  `document` global, for the same reason.
- **Split each module into a pure half and a drawing half.** The pure half (geometry,
  formatting, limits) is where the correctness lives and is the only half pytest can run
  under node; keep the drawing half thin enough that reading it is enough review.
- **One `toggle()` drives every Record/Stop transition**, so the 30 s auto-stop takes the
  identical path to a click on Stop. It is guarded by a `busy` flag because those two can
  race. Add new transitions inside it rather than beside it.
- `new AudioContext({ sampleRate: 16000 })` is a *request*. The worklet always resamples
  from its own `sampleRate` global, so the ratio-1 case is just the same code path.
- `getUserMedia({ audio: { channelCount: 1 } })` is also advisory — the worklet downmixes
  whatever arrives, because the backend rejects anything but mono.
- The browser needs `http://localhost` or HTTPS for `getUserMedia`; over a plain-IP origin
  `navigator.mediaDevices` is undefined, which `Recorder.start()` reports as an
  unsupported browser.
