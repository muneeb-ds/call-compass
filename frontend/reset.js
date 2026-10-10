// The Reset button: one click back to the demo's starting state.
//
// The demo is run repeatedly in front of an audience, so "start again" has to be a
// single control and must not be a page reload — reloading re-fetches the tree and
// re-runs the health check in front of the room, which looks like a restart rather
// than a second take.
//
// `resetAll` is the teardown itself: pure wiring over the two objects that own run
// state, so the order it does things in (cancel the stream *before* clearing) is
// assertable from node. `ResetControl` is the button, and takes its element as an
// argument like every other module here.

/**
 * Clears everything a run left behind, in the one order that is safe.
 *
 * @param {{analysis: import("./analysis.js").Analysis, capture: {reset: () => void}}} parts
 */
export function resetAll({ analysis, capture }) {
  // Cancel first. A chunk already in flight would otherwise be painted after the tree
  // had been dimmed, leaving a node lit with no trace card to explain it.
  analysis.cancel();
  // Trace cards, the running total, every node and edge highlight, the picks — and,
  // through `Analysis.onReset`, the result card.
  analysis.reset();
  // The recording, the playback control, the waveform, the clock, the inline message.
  capture.reset();
}

/**
 * The Reset button.
 *
 * Disabled until a run has finished: there is nothing to clear before then, and a live
 * control that does nothing reads as a broken demo. It stays enabled across a *later*
 * run, which is what lets it cancel one mid-flight.
 *
 * The DOM's own `disabled` is the state — there is no second copy of it to drift.
 */
export class ResetControl {
  /**
   * @param {HTMLButtonElement} button
   * @param {() => void} onReset the teardown, normally a `resetAll` closure
   */
  constructor(button, onReset) {
    this.button = button;
    this.onReset = onReset;
    this.disarm();
  }

  /** True when the button is live. */
  get armed() {
    return !this.button.disabled;
  }

  /** A run finished, by any route: there is now something to clear. */
  arm() {
    this.button.disabled = false;
  }

  /** Back to "nothing to clear". */
  disarm() {
    this.button.disabled = true;
  }

  /**
   * Clears the run and returns to the disarmed state.
   *
   * A no-op while disarmed, so neither a keyboard activation of a disabled button nor a
   * later hotkey can wipe a run that is still drawing its first frames.
   *
   * @returns {boolean} whether anything was cleared
   */
  trigger() {
    if (!this.armed) return false;
    this.onReset();
    this.disarm();
    return true;
  }
}
