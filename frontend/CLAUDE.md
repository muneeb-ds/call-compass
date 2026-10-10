# frontend/ — CallCompass demo UI

Vanilla ES modules served by FastAPI from `/`. **No bundler, no node_modules, no build
step, no JS typecheck or lint.** Everything here is loaded directly by the browser, so
every file must be valid in the browser as-is.

## Checks available for this directory

```bash
node --check frontend/*.js                 # syntax only
cd backend && ../.venv/bin/pytest tests/test_frontend_{audio,timing,playback,tree,analysis}.py
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
  worklet globals, so the node harness can load it with the globals stubbed.
- `capture.js` — `Recorder` (start/stop/release) and `MicrophoneError`. `stop()` returns
  the encoded bytes **and** a Blob over the same bytes; use those bytes for both upload and
  playback, never a separate MediaRecorder blob.
- `timer.js` — the recording clock: pure `formatClock` / `formatElapsed`, the
  `MAX_RECORDING_MS` ceiling (derived from `wav.js`), and `RecordingTimer`, which owns both
  the display tick and the auto-stop. The ceiling is enforced by its own `setTimeout`, not
  by the tick, so the stop lands on the limit rather than up to a tick late.
- `waveform.js` — `Waveform(canvas)`: `start(analyser)` runs a `requestAnimationFrame` loop
  over `getByteTimeDomainData`, `stop()` leaves a flat gray baseline. Cosmetic only; it
  never reads or alters the captured samples. The canvas is sized by CSS and its backing
  store is re-matched per frame, so never set `canvas.width`/`height` in HTML.
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
  `reset()` / `cancel()` are what US-016's button calls. It also records every step's
  `tool_called` in `picks`, which is the result card's breadcrumb — the card must not
  re-derive the path from the terminal event's `path` (those are node ids).
- `result.js` — the result area. `breadcrumb(picks)` / `formatEndToEnd(ms)` are pure;
  `ResultCard(container)` draws **only** from a terminal event, so an in-flight run can
  never be read as a recommendation. The breadcrumb names the **chosen options**
  (`humanize`d from `trace.js`), not the node labels, and the card's latency is
  `total_latency_ms` (end to end) — deliberately a different number from the Trace
  column's inference-only total, which is why it is labelled "end to end".
  `clear()` is the empty state and is wired to `Analysis.onReset`.
- `app.js` — page wiring only. Exports its entry points (`checkHealth`, `loadTree`,
  `wireCapture`, `wireAnalysis`, `main`) so a later story can call them instead of
  re-deriving. `wireCapture({onRecording})` returns
  `{ recorder, waveform, timer, playback, toggle, latest }`; `onRecording` is **awaited inside
  the guarded `toggle()`**, which is what keeps the Record button disabled for the whole
  traversal without inventing a second flag. `main()` returns `{ analysis, capture, loading }`
  — US-016 should drive those rather than re-querying the DOM.

## Looking at the UI without a browser

There is no browser tool here. `qlmanage -t -s 1400 -o /tmp page.html` rasterizes a
**standalone HTML** file through WebKit (and the same works for `.svg`), and the Read
tool can view the PNG. Build that file by driving the *shipped* module over a stub
element that can serialize itself, with the real `styles.css` inlined — re-implementing
the markup by hand produces a picture that is wrong in ways that read as app bugs.

## Conventions

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
