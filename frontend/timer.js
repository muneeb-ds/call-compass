// Recording clock and the 30-second ceiling.
//
// The ceiling is the backend's limit (callcompass.audio.MAX_SECONDS), so it is derived
// from wav.js rather than written out twice: a timer that let the operator record 31
// seconds would turn a successful demo recording into an HTTP 400.
//
// Keep `formatClock` / `formatElapsed` pure so node can check them from the Python
// suite (backend/tests/test_frontend_timing.py).

import { MAX_SECONDS } from "./wav.js";

/** The recording ceiling, in milliseconds. */
export const MAX_RECORDING_MS = MAX_SECONDS * 1000;

/** How often the readout is repainted. Fine enough to look live, cheap enough to ignore. */
const TICK_MS = 100;

/**
 * Formats a duration as `m:ss`.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatClock(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Formats the elapsed-of-ceiling readout, e.g. `"0:12 / 0:30"`.
 *
 * Elapsed is clamped to the ceiling so the display can never read past its own limit
 * in the few milliseconds between the auto-stop firing and the recorder releasing.
 *
 * @param {number} ms
 * @param {number} [limitMs]
 * @returns {string}
 */
export function formatElapsed(ms, limitMs = MAX_RECORDING_MS) {
  return `${formatClock(Math.min(ms, limitMs))} / ${formatClock(limitMs)}`;
}

/**
 * Counts up in one element and fires `onLimit` when the ceiling is reached.
 *
 * The ceiling is enforced by its own timeout rather than by the display tick, so the
 * auto-stop lands on the limit itself instead of up to a tick late.
 */
export class RecordingTimer {
  /**
   * @param {HTMLElement} el
   * @param {object} [options]
   * @param {() => void} [options.onLimit] called once, when `limitMs` elapses
   * @param {number} [options.limitMs]
   */
  constructor(el, { onLimit = () => {}, limitMs = MAX_RECORDING_MS } = {}) {
    this.el = el;
    this.onLimit = onLimit;
    this.limitMs = limitMs;
    this.startedAt = 0;
    /** @type {ReturnType<typeof setInterval>|0} */
    this.interval = 0;
    /** @type {ReturnType<typeof setTimeout>|0} */
    this.timeout = 0;
  }

  /** Elapsed milliseconds, frozen at the value reached when `stop()` was called. */
  get elapsedMs() {
    return this.startedAt ? Math.min(performance.now() - this.startedAt, this.limitMs) : 0;
  }

  /** Starts counting from zero. */
  start() {
    this.clear();
    this.startedAt = performance.now();
    this.render(0);
    this.interval = setInterval(() => this.render(performance.now() - this.startedAt), TICK_MS);
    this.timeout = setTimeout(() => {
      this.render(this.limitMs);
      this.onLimit();
    }, this.limitMs);
  }

  /** Stops counting, leaving the final time on screen for the operator to read. */
  stop() {
    const elapsed = this.elapsedMs;
    this.clear();
    this.startedAt = 0;
    this.render(elapsed);
  }

  /** Stops counting and returns the readout to `0:00 / 0:30`. */
  reset() {
    this.clear();
    this.startedAt = 0;
    this.render(0);
  }

  /** Drops both timers without touching the display. */
  clear() {
    if (this.interval) clearInterval(this.interval);
    if (this.timeout) clearTimeout(this.timeout);
    this.interval = 0;
    this.timeout = 0;
  }

  /** @param {number} ms */
  render(ms) {
    this.el.textContent = formatElapsed(ms, this.limitMs);
  }
}
