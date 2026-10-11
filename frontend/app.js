// CallCompass demo shell.
//
// Wires the health check and the capture pipeline. Everything else on the page is
// still a labelled placeholder that a later story replaces. No bundler, no build
// step — this is loaded directly as an ES module.

import { Analysis } from "./analysis.js";
import { MicrophoneError, Recorder } from "./capture.js";
import { Playback } from "./playback.js";
import { OutcomeStrip } from "./outcome.js";
import { PositionReadout } from "./position.js";
import { ResetControl, resetAll } from "./reset.js";
import { AnalyzeError } from "./sse.js";
import { RecordingTimer } from "./timer.js";
import { Trace } from "./trace.js";
import { TraceRail, TracePanel } from "./trace-panel.js";
import { TreeView } from "./tree.js";
import { frameFor, isTextInputFocused, Viewport } from "./viewport.js";
import { Waveform } from "./waveform.js";

/** @param {string} text @param {"loading"|"ready"|"error"} state */
function setStatus(text, state) {
  const el = document.getElementById("health-status");
  el.textContent = text;
  el.dataset.state = state;
  document.getElementById("health-dot").dataset.state = state;
}

/**
 * Reads GET /api/health and reports readiness inline.
 *
 * Failures are shown in the page, never as an alert() and never swallowed: a demo
 * machine where the model did not load has to look broken on screen.
 */
export async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) {
      setStatus(`Backend not ready: HTTP ${response.status}`, "error");
      return null;
    }
    const health = await response.json();
    if (health.status !== "ok" || !health.model_loaded) {
      setStatus("Backend not ready: model is not loaded", "error");
      return null;
    }
    setStatus(
      `${health.tree_id} · ${health.node_count} nodes · model ${health.model_load_ms} ms`,
      "ready",
    );
    return health;
  } catch (err) {
    setStatus(`Backend unreachable: ${err.message}`, "error");
    return null;
  }
}

/**
 * Fetches GET /api/tree and draws it, dimmed, in the center column.
 *
 * The drawing is derived from the config alone, so editing a label in
 * `config/tree.json` and restarting the server is enough to change it.
 *
 * @returns {Promise<{view: TreeView, tree: object}|null>} null if the tree could not
 *   be loaded, with the reason already on screen
 */
export async function loadTree() {
  const message = document.getElementById("tree-message");
  /** @param {string} text */
  const fail = (text) => {
    message.textContent = text;
    message.hidden = false;
    return null;
  };
  const view = new TreeView(
    /** @type {SVGSVGElement} */ (document.getElementById("tree-canvas")),
  );
  try {
    const response = await fetch("/api/tree");
    if (!response.ok) return fail(`Could not load the tree: HTTP ${response.status}`);
    const tree = await response.json();
    view.render(tree);
    message.hidden = true;
    return { view, tree };
  } catch (err) {
    return fail(`Could not load the tree: ${err.message}`);
  }
}

/**
 * Shows or clears the Capture column's inline message.
 *
 * Capture problems are always reported here. Never alert(), and never a silent
 * failure: an operator standing in front of an audience needs to see on screen that
 * the mic was denied.
 *
 * @param {string} text empty to hide
 * @param {"error"|"info"} [state]
 */
function setCaptureMessage(text, state = "error") {
  const el = document.getElementById("capture-message");
  el.textContent = text;
  el.dataset.state = state;
  el.hidden = text === "";
}

/**
 * Wires the Capture column: record/stop button, live waveform, and the 30 s clock.
 *
 * One `toggle()` drives every transition, so the auto-stop at the ceiling takes
 * exactly the same path as a click on Stop.
 *
 * @param {{onRecording?: (recording: import("./capture.js").Recording) => Promise<void>}} [hooks]
 *   `onRecording` is awaited inside the guarded toggle, so the Record button stays
 *   disabled for as long as it runs — which is what keeps it disabled for a whole
 *   traversal — and a throw from it lands in the same inline error path as a mic failure.
 */
export function wireCapture(hooks = {}) {
  const dock = document.getElementById("dock");
  const button = document.getElementById("record-button");
  const pauseButton = /** @type {HTMLButtonElement} */ (
    document.getElementById("pause-button")
  );
  const recorder = new Recorder();
  const waveform = new Waveform(
    /** @type {HTMLCanvasElement} */ (document.getElementById("waveform-canvas")),
  );
  const timer = new RecordingTimer(document.getElementById("timer"), {
    onLimit: () => void toggle(),
  });
  const playback = new Playback(
    /** @type {HTMLButtonElement} */ (document.getElementById("play-button")),
    document.getElementById("playback-time"),
    /** @type {HTMLAudioElement} */ (document.getElementById("playback-audio")),
  );
  /** @type {import("./capture.js").Recording|null} */
  let recording = null;
  let busy = false;

  /** @param {boolean} isRecording */
  function render(isRecording) {
    button.textContent = isRecording ? "Stop" : "Record";
    button.dataset.recording = String(isRecording);
    button.setAttribute("aria-pressed", String(isRecording));
  }

  /**
   * Reflects the recorder's pause state onto the pause button and the dock, per the
   * PRD's dock state table: disabled unless a recording is in progress, labelled
   * `Pause`/`Resume`, and the dock itself carries a `paused` look distinct from both
   * `idle` and `recording` so it reads as unmistakably held, not merely idle.
   */
  function renderPause() {
    const paused = recorder.paused;
    pauseButton.disabled = !recorder.recording;
    pauseButton.textContent = paused ? "Resume" : "Pause";
    pauseButton.setAttribute("aria-pressed", String(paused));
    dock.dataset.state = !recorder.recording ? "idle" : paused ? "paused" : "recording";
  }

  /** Settles the UI back to its not-recording look. */
  function settle() {
    waveform.stop();
    timer.stop();
    render(false);
    renderPause();
  }

  /**
   * Pause <-> resume, without tearing anything down. Shares `toggle()`'s `busy` guard
   * so a pause click cannot race the auto-stop firing at the ceiling, and is itself a
   * no-op while nothing is recording.
   */
  function pauseToggle() {
    if (busy || !recorder.recording) return;
    if (recorder.paused) {
      recorder.resume();
      timer.resume();
      waveform.unfreeze();
    } else {
      recorder.pause();
      timer.pause();
      waveform.freeze();
    }
    renderPause();
  }

  async function start() {
    setCaptureMessage("");
    // The previous take is gone the moment a new one begins; leaving it playable would
    // let the operator audition audio the current run never used.
    playback.clear();
    await recorder.start();
    render(true);
    waveform.start(recorder.analyser);
    timer.start();
    renderPause();
  }

  async function stop() {
    recording = await recorder.stop();
    settle();
    if (!recording) return;
    // Replaces the flat idle baseline `settle()` just drew with the actual take, so the
    // canvas does not go blank the moment recording ends.
    waveform.renderRecording(recording.samples, recording.segments);
    playback.load(recording);
    setCaptureMessage(
      `Captured ${(recording.durationMs / 1000).toFixed(1)}s · ` +
        `${recording.bytes.length} bytes · ${recording.sampleRate} Hz mono`,
      "info",
    );
    if (hooks.onRecording) await hooks.onRecording(recording);
  }

  /** Record <-> Stop. Re-entrant calls are dropped, including a click racing the auto-stop. */
  async function toggle() {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      await (recorder.recording ? stop() : start());
    } catch (err) {
      settle();
      setCaptureMessage(
        err instanceof MicrophoneError ? err.message : `Recording failed: ${err.message}`,
        "error",
      );
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  /**
   * Back to the pre-recording state: no take, nothing to play, no message.
   *
   * Also discards a take still in progress. Reset can be armed by an earlier run while
   * the operator is part way into the next one, and leaving the mic open there would
   * keep the browser's recording indicator lit over an empty column.
   */
  function reset() {
    if (recorder.recording) void recorder.stop();
    recording = null;
    playback.clear();
    setCaptureMessage("");
    settle();
    timer.reset();
  }

  button.addEventListener("click", () => void toggle());
  pauseButton.addEventListener("click", () => pauseToggle());
  playback.button.addEventListener("click", () => playback.toggle());
  // Keeps the trace spanning the column when the window changes size while idle.
  window.addEventListener("resize", () => waveform.render());
  // Global shortcuts: Space mirrors the Record/Stop click, P mirrors Pause/Resume.
  // Both are ignored while a text field has focus, and `preventDefault()` on the
  // keydown also suppresses a focused button's own native space-activation, so a
  // Record/Pause button that happens to have focus does not double-fire.
  document.addEventListener("keydown", (event) => {
    if (isTextInputFocused(document)) return;
    if (event.code === "Space") {
      event.preventDefault();
      void toggle();
    } else if (event.code === "KeyP") {
      event.preventDefault();
      pauseToggle();
    }
  });

  render(false);
  renderPause();
  waveform.stop();
  timer.reset();
  /** Exposed for the later stories that need the captured bytes or the controls. */
  return { recorder, waveform, timer, playback, toggle, reset, latest: () => recording };
}

/**
 * Builds the Trace column and the traversal runner.
 *
 * The tree may still be loading when the first recording stops, so the view is
 * attached when its promise settles rather than being required up front — a run with
 * no tree drawn still produces trace cards and a total.
 *
 * @param {Promise<{view: TreeView, tree: object}|null>} loading the `loadTree()` promise
 * @param {{onFinish?: () => void}} [hooks] `onFinish` is called once a run has ended by
 *   any route — a terminal event, an `error` event, or a rejected upload — which is
 *   what arms the Reset button. A cancelled run is not a finish and does not call it.
 * @returns {{analysis: Analysis, outcome: OutcomeStrip, panel: TracePanel, viewport: Viewport,
 *            position: PositionReadout, onRecording: (r: {bytes: Uint8Array}) => Promise<void>}}
 */
export function wireAnalysis(loading, hooks = {}) {
  const finished = () => {
    if (hooks.onFinish) hooks.onFinish();
  };
  const svg = /** @type {SVGSVGElement} */ (document.getElementById("tree-canvas"));
  const viewport = new Viewport(svg);
  viewport.enableManualControls({
    followButton: /** @type {HTMLButtonElement} */ (document.getElementById("viewport-follow")),
    fitButton: /** @type {HTMLButtonElement} */ (document.getElementById("viewport-fit")),
    doc: document,
  });
  const trace = new Trace(
    document.getElementById("trace-total"),
    document.getElementById("trace-list"),
  );
  const outcome = new OutcomeStrip(document.getElementById("outcome-strip"));
  const position = new PositionReadout(document.getElementById("position-readout"));
  const panel = new TracePanel(
    document.getElementById("trace-panel"),
    document.getElementById("trace-toggle"),
    { doc: document },
  );
  const rail = new TraceRail(
    document.getElementById("trace-chip-list"),
    document.getElementById("trace-chip-total"),
    {
      // A chip opens the panel and scrolls it to the matching card — the chip's
      // index is the card's `data-index`, set by `Trace.addStep` in the same order.
      onSelect: (index) => {
        panel.open();
        const card = trace.listEl.children[index];
        if (card && card.scrollIntoView) card.scrollIntoView({ block: "nearest" });
      },
    },
  );
  const analysis = new Analysis(trace);
  trace.reset();
  outcome.clear();
  rail.reset();
  // The panel's open/closed state is a viewer preference, not run state, so neither
  // `onReset` nor `onTerminal` below ever touches `panel` — only the toggle does.
  analysis.onStep = (step, index) => rail.addStep(step, index);
  // Follows the frontier down the tree as it moves, as long as auto-follow is still
  // armed — a manual pan/zoom/Fit (or clicking Follow to re-arm it) owns that flag,
  // this hook only ever asks. The stage's own aspect ratio, read fresh each time, is
  // what keeps the framing correct across a window resize.
  analysis.onActivate = (id) => {
    const layout = analysis.view && analysis.view.layout;
    if (!layout) return;
    const rect = svg.getBoundingClientRect();
    const aspect = rect.height > 0 ? rect.width / rect.height : 16 / 9;
    viewport.autoGoTo(frameFor(layout, id, aspect));
    position.activate(id);
  };
  // The strip is drawn from the terminal event only, so an in-flight run never shows
  // an outcome; `reset()` (a new run, or US-016's button) takes it away again. A new
  // run re-arms auto-follow, too — `reset()` runs at the top of every `run()`, not
  // only from the Reset button, which is what makes "resumes on the next run" free.
  /** @type {string|null} the tree's root id, known once `loading` resolves. */
  let rootId = null;
  analysis.onReset = () => {
    outcome.clear();
    rail.reset();
    viewport.resetView();
    position.reset(rootId);
  };
  analysis.onTerminal = (frame) => {
    if (frame.event === "completed") {
      outcome.completed(frame.data, analysis.picks);
      position.finish(frame.data.leaf_node_id, frame.data.inference_count);
    }
    if (frame.event === "unplaced") {
      outcome.unplaced(frame.data, analysis.picks);
      position.finish(frame.data.stopped_at_node_id, frame.data.inference_count);
    }
    rail.setTotal(frame.data.total_inference_ms);
    finished();
  };
  // An `error` event is a finished run, so it gets a strip of its own rather than
  // leaving the dock on its pre-run absent state as if nothing had happened. It carries
  // no authoritative inference count, so the readout freezes on the count it already
  // tracked from `onActivate`.
  analysis.onError = (payload) => {
    outcome.errored(payload);
    position.finish(payload.node_id);
    finished();
  };
  void loading.then((loaded) => {
    if (!loaded) return;
    analysis.view = loaded.view;
    viewport.setLayout(loaded.view.layout);
    rootId = loaded.tree.root;
    position.setLayout(loaded.view.layout, rootId);
  });

  /** @param {{bytes: Uint8Array}} recording */
  async function onRecording(recording) {
    await loading;
    try {
      await analysis.run(recording.bytes);
      // An `error` event is a finished run, not a throw: the stream closed cleanly
      // after it, so the UI reports it and stays usable rather than hanging.
      if (analysis.error) setCaptureMessage(analysis.error.message, "error");
    } catch (err) {
      // An abort is a deliberate cancellation (Reset), not a failure to report — and
      // not a finish either: the UI has already been cleared.
      if (err.name === "AbortError") return;
      setCaptureMessage(
        err instanceof AnalyzeError
          ? `Backend rejected the audio: ${err.message}`
          : `Analysis failed: ${err.message}`,
        "error",
      );
      // A rejected upload still leaves a message and a recording on screen, so Reset
      // has something to clear.
      finished();
    }
  }

  return { analysis, outcome, panel, viewport, position, onRecording };
}

/** Page entry point. Exported so a later story can wire the same parts differently. */
export function main() {
  checkHealth();
  const loading = loadTree();
  // The teardown closes over both halves, so Reset is built first and the two are
  // handed to it as they come into existence. It only ever runs on a click.
  const reset = new ResetControl(
    /** @type {HTMLButtonElement} */ (document.getElementById("reset-button")),
    () => resetAll({ analysis, capture }),
  );
  const { analysis, outcome, panel, viewport, position, onRecording } = wireAnalysis(loading, {
    onFinish: () => reset.arm(),
  });
  const capture = wireCapture({ onRecording });
  reset.button.addEventListener("click", () => reset.trigger());
  return { analysis, outcome, panel, viewport, position, capture, reset, loading };
}

main();
