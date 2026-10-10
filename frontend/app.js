// CallCompass demo shell.
//
// Wires the health check and the capture pipeline. Everything else on the page is
// still a labelled placeholder that a later story replaces. No bundler, no build
// step — this is loaded directly as an ES module.

import { MicrophoneError, Recorder } from "./capture.js";
import { RecordingTimer } from "./timer.js";
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
 * Sends the encoded WAV to the backend to confirm the format is accepted.
 *
 * Deliberately throws the response away: this story only establishes that the
 * client-side encoding satisfies the backend's validation. US-013 replaces this with
 * consuming the SSE stream.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<string>} a message for the Capture column
 */
export async function verifyAccepted(bytes) {
  const body = new FormData();
  body.append("audio", new Blob([bytes], { type: "audio/wav" }), "utterance.wav");
  const controller = new AbortController();
  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      body,
      signal: controller.signal,
    });
    if (response.status === 400) {
      const { detail } = await response.json();
      return `Backend rejected the audio: ${detail}`;
    }
    return "";
  } finally {
    // The traversal stream itself is not this story's concern; drop it rather than
    // leaving a half-read response open.
    controller.abort();
  }
}

/**
 * Wires the Capture column: record/stop button, live waveform, and the 30 s clock.
 *
 * One `toggle()` drives every transition, so the auto-stop at the ceiling takes
 * exactly the same path as a click on Stop.
 */
export function wireCapture() {
  const button = document.getElementById("record-button");
  const recorder = new Recorder();
  const waveform = new Waveform(
    /** @type {HTMLCanvasElement} */ (document.getElementById("waveform-canvas")),
  );
  const timer = new RecordingTimer(document.getElementById("timer"), {
    onLimit: () => void toggle(),
  });
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
    await recorder.start();
    render(true);
    waveform.start(recorder.analyser);
    timer.start();
  }

  async function stop() {
    recording = await recorder.stop();
    settle();
    const problem = recording ? await verifyAccepted(recording.bytes) : "";
    if (problem) {
      setCaptureMessage(problem, "error");
    } else if (recording) {
      setCaptureMessage(
        `Captured ${(recording.durationMs / 1000).toFixed(1)}s · ` +
          `${recording.bytes.length} bytes · ${recording.sampleRate} Hz mono`,
        "info",
      );
    }
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
  // Keeps the trace spanning the column when the window changes size while idle.
  window.addEventListener("resize", () => waveform.render());

  render(false);
  waveform.stop();
  timer.reset();
  /** Exposed for the later stories that need the captured bytes or the controls. */
  return { recorder, waveform, timer, toggle, latest: () => recording };
}

checkHealth();
wireCapture();
