// CallCompass demo shell.
//
// Wires the health check and the capture pipeline. Everything else on the page is
// still a labelled placeholder that a later story replaces. No bundler, no build
// step — this is loaded directly as an ES module.

import { Analysis } from "./analysis.js";
import { MicrophoneError, Recorder } from "./capture.js";
import { Playback } from "./playback.js";
import { AnalyzeError } from "./sse.js";
import { RecordingTimer } from "./timer.js";
import { Trace } from "./trace.js";
import { TreeView } from "./tree.js";
import { Waveform } from "./waveform.js";

/** @param {string} text @param {"loading"|"ready"|"error"} state */
function setStatus(text, state) {
  const el = document.getElementById("health-status");
  el.textContent = text;
  el.dataset.state = state;
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
  const button = document.getElementById("record-button");
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

  /** Settles the UI back to its not-recording look. */
  function settle() {
    waveform.stop();
    timer.stop();
    render(false);
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
  }

  async function stop() {
    recording = await recorder.stop();
    settle();
    if (!recording) return;
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

  button.addEventListener("click", () => void toggle());
  playback.button.addEventListener("click", () => playback.toggle());
  // Keeps the trace spanning the column when the window changes size while idle.
  window.addEventListener("resize", () => waveform.render());

  render(false);
  waveform.stop();
  timer.reset();
  /** Exposed for the later stories that need the captured bytes or the controls. */
  return { recorder, waveform, timer, playback, toggle, latest: () => recording };
}

/**
 * Builds the Trace column and the traversal runner.
 *
 * The tree may still be loading when the first recording stops, so the view is
 * attached when its promise settles rather than being required up front — a run with
 * no tree drawn still produces trace cards and a total.
 *
 * @param {Promise<{view: TreeView, tree: object}|null>} loading the `loadTree()` promise
 * @returns {{analysis: Analysis, onRecording: (r: {bytes: Uint8Array}) => Promise<void>}}
 */
export function wireAnalysis(loading) {
  const trace = new Trace(
    document.getElementById("trace-total"),
    document.getElementById("trace-list"),
  );
  const analysis = new Analysis(trace);
  trace.reset();
  void loading.then((loaded) => {
    if (loaded) analysis.view = loaded.view;
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
      // An abort is a deliberate cancellation (Reset), not a failure to report.
      if (err.name === "AbortError") return;
      setCaptureMessage(
        err instanceof AnalyzeError
          ? `Backend rejected the audio: ${err.message}`
          : `Analysis failed: ${err.message}`,
        "error",
      );
    }
  }

  return { analysis, onRecording };
}

/** Page entry point. Exported so a later story can wire the same parts differently. */
export function main() {
  checkHealth();
  const loading = loadTree();
  const { analysis, onRecording } = wireAnalysis(loading);
  const capture = wireCapture({ onRecording });
  return { analysis, capture, loading };
}

main();
