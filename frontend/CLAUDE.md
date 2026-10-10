# frontend/ — CallCompass demo UI

Vanilla ES modules served by FastAPI from `/`. **No bundler, no node_modules, no build
step, no JS typecheck or lint.** Everything here is loaded directly by the browser, so
every file must be valid in the browser as-is.

## Checks available for this directory

```bash
node --check frontend/*.js                 # syntax only
cd backend && ../.venv/bin/pytest tests/test_frontend_audio.py tests/test_frontend_timing.py
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
- `app.js` — page wiring only. Exports its entry points (`checkHealth`, `wireCapture`) so a
  later story can call them instead of re-deriving. `wireCapture()` returns
  `{ recorder, waveform, timer, toggle, latest }` — US-011/US-013/US-016 should drive those
  rather than re-querying the DOM.

## Conventions

- **Capture failures are shown inline** in the Capture column (`#capture-message`).
  Never `alert()`, never a silent catch — a demo operator has to see on screen that the
  mic was denied.
- UI state lives in `data-*` attributes set from the real object's state
  (`data-recording` from `recorder.recording`), not in a parallel CSS class.
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
