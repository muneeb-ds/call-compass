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
 * @param {boolean} [paused] appends the `· paused` affordance (US-027)
 * @returns {string}
 */
export function formatElapsed(ms, limitMs = MAX_RECORDING_MS, paused = false) {
  const base = `${formatClock(Math.min(ms, limitMs))} / ${formatClock(limitMs)}`;
  return paused ? `${base} · paused` : base;
}

/**
 * Elapsed time across pauses, from wall-clock marks rather than a running total kept
 * ticking by a timer - that is what lets this be pinned from node with synthetic
 * timestamps instead of exercising real `setInterval` timing.
 *
 * An unpaused span contributes `now - startedAt`; a paused span (`startedAt === 0`)
 * contributes nothing beyond what was already folded into `accumulatedMs` when it
 * was closed.
 *
 * @param {number} accumulatedMs elapsed total from spans already closed
 * @param {number} startedAt `performance.now()` mark when the current span began,
 *   or `0` while paused or stopped
 * @param {number} now a `performance.now()` reading
 * @param {number} limitMs
 * @returns {number}
 */
export function accumulatedElapsed(accumulatedMs, startedAt, now, limitMs) {
  const live = startedAt ? accumulatedMs + (now - startedAt) : accumulatedMs;
  return Math.min(Math.max(0, live), limitMs);
}

/**
 * Milliseconds left before the ceiling, given whatever has already accumulated.
 *
 * `resume()` reschedules its auto-stop timeout against this rather than the full
 * `limitMs`, so a paused take can neither exceed the limit nor auto-stop early.
 *
 * @param {number} elapsedMs
 * @param {number} limitMs
 * @returns {number}
 */
export function remainingMs(elapsedMs, limitMs) {
  return Math.max(0, limitMs - elapsedMs);
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
    /** `performance.now()` mark for the current unpaused span; `0` while paused/stopped. */
    this.startedAt = 0;
    /** Elapsed total folded in from spans already closed by a `pause()` or `stop()`. */
    this.accumulatedMs = 0;
    this.paused = false;
    /** @type {ReturnType<typeof setInterval>|0} */
    this.interval = 0;
    /** @type {ReturnType<typeof setTimeout>|0} */
    this.timeout = 0;
  }

  /** Elapsed milliseconds, frozen while paused and at the value reached when `stop()` was called. */
  get elapsedMs() {
    return accumulatedElapsed(this.accumulatedMs, this.startedAt, performance.now(), this.limitMs);
  }

  /** Starts counting from zero. */
  start() {
    this.clear();
    this.accumulatedMs = 0;
    this.paused = false;
    this.startedAt = performance.now();
    this.render(0);
    this.interval = setInterval(() => this.render(this.elapsedMs), TICK_MS);
    this.scheduleCeiling(this.limitMs);
  }

  /**
   * Freezes the readout and drops the ceiling timeout. No-op when not running or
   * already paused.
   */
  pause() {
    if (!this.startedAt || this.paused) return;
    this.accumulatedMs = this.elapsedMs;
    this.startedAt = 0;
    this.paused = true;
    this.clear();
    this.render(this.accumulatedMs);
  }

  /**
   * Resumes counting, rescheduling the ceiling timeout against whatever budget is
   * left rather than the full `limitMs`. No-op when not paused.
   */
  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.startedAt = performance.now();
    this.interval = setInterval(() => this.render(this.elapsedMs), TICK_MS);
    this.scheduleCeiling(remainingMs(this.accumulatedMs, this.limitMs));
  }

  /** @param {number} remaining */
  scheduleCeiling(remaining) {
    this.timeout = setTimeout(() => {
      this.render(this.limitMs);
      this.onLimit();
    }, remaining);
  }

  /** Stops counting, leaving the final time on screen for the operator to read. */
  stop() {
    const elapsed = this.elapsedMs;
    this.clear();
    this.startedAt = 0;
    this.accumulatedMs = 0;
    this.paused = false;
    this.render(elapsed);
  }

  /** Stops counting and returns the readout to `0:00 / 0:30`. */
  reset() {
    this.clear();
    this.startedAt = 0;
    this.accumulatedMs = 0;
    this.paused = false;
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
    this.el.textContent = formatElapsed(ms, this.limitMs, this.paused);
  }
}
