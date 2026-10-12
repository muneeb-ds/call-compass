// Live recording waveform, drawn on a Canvas from an AnalyserNode.
//
// Purely cosmetic — it never touches the captured samples. Its job is operator
// confidence: a flat line while the button says "Stop" is the one unambiguous sign
// that the mic is open but hearing nothing, which is otherwise indistinguishable
// from a model misfire when the demo goes wrong.

/** Idle baseline, live trace, and segment-marker colour fallbacks, matching styles.css. */
const IDLE_FALLBACK = "#8b949e";
const LIVE_FALLBACK = "#f85149";
const MARKER_FALLBACK = "#d29922";

/**
 * Downsamples `samples` into `columns` per-column min/max pairs — a peak envelope,
 * not an average, so a short loud transient between two samples' worth of silence
 * still shows up as a visible spike rather than being averaged away.
 *
 * Pure: no DOM, no canvas, so node can pin it directly.
 *
 * @param {Float32Array|number[]} samples
 * @param {number} columns
 * @returns {Array<{min: number, max: number}>} always exactly `columns` long
 */
export function peakEnvelope(samples, columns) {
  const length = samples.length;
  const result = new Array(columns);
  for (let i = 0; i < columns; i += 1) {
    const start = Math.floor((i * length) / columns);
    const end = Math.max(start + 1, Math.floor(((i + 1) * length) / columns));
    let min = Infinity;
    let max = -Infinity;
    for (let j = start; j < end && j < length; j += 1) {
      const value = samples[j];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    // A column past the end of a buffer shorter than `columns` has no samples at all.
    result[i] = min === Infinity ? { min: 0, max: 0 } : { min, max };
  }
  return result;
}

/**
 * Reads a colour token off the document's root element.
 *
 * Falls back when `getComputedStyle` isn't available (the node test harness has no
 * DOM) or when the token resolves to nothing.
 *
 * @param {string} name CSS custom property name, e.g. "--text-dim"
 * @param {string} fallback
 * @returns {string}
 */
export function readColorToken(name, fallback) {
  if (typeof getComputedStyle !== "function" || typeof document === "undefined") {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Renders a time-domain waveform into one canvas.
 *
 * `start(analyser)` runs an animation frame loop until `stop()`, which leaves the
 * canvas showing a flat gray baseline. Safe to start and stop repeatedly.
 */
export class Waveform {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    /** @type {AnalyserNode|null} */
    this.analyser = null;
    /** @type {Uint8Array|null} */
    this.data = null;
    /** requestAnimationFrame handle, 0 when idle. */
    this.frame = 0;
    this.idleColor = readColorToken("--text-dim", IDLE_FALLBACK);
    this.liveColor = readColorToken("--live", LIVE_FALLBACK);
    this.markerColor = readColorToken("--warning", MARKER_FALLBACK);
    /** The captured take's samples, while a static recording is drawn; null otherwise. */
    this.recordingSamples = null;
    /** @type {Array<{startMs: number, endMs: number}>|null} */
    this.recordingSegments = null;
  }

  /**
   * Begins drawing from `analyser`.
   *
   * @param {AnalyserNode|null} analyser null draws the idle baseline instead
   */
  start(analyser) {
    this.stop();
    if (!analyser) return;
    this.analyser = analyser;
    this.data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      this.frame = requestAnimationFrame(tick);
      this.render();
    };
    tick();
  }

  /** Stops the loop and settles the canvas back to a flat gray line. */
  stop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.analyser = null;
    this.data = null;
    this.recordingSamples = null;
    this.recordingSegments = null;
    this.render();
  }

  /**
   * Draws a static peak-envelope waveform of a finished take instead of the live
   * analyser trace, with a vertical marker at each boundary between `segments`.
   *
   * Replaces whatever is on screen immediately and persists — through a resize, since
   * `render()` redraws from these same samples — until the next `start()` or `stop()`.
   * A single-segment take (no pause occurred) draws no markers.
   *
   * @param {Float32Array} samples the captured take, in `[-1, 1]`
   * @param {Array<{startMs: number, endMs: number}>} segments one entry per
   *   record/resume span, as millisecond offsets into `samples` (US-027's shape)
   */
  renderRecording(samples, segments) {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.analyser = null;
    this.data = null;
    this.recordingSamples = samples;
    this.recordingSegments = segments;
    this.render();
  }

  /**
   * Holds whatever frame is currently drawn and stops reading the analyser, without
   * settling to the idle baseline (US-028's "freezes rather than flatlines").
   *
   * Unlike `stop()`, `this.analyser`/`this.data` are kept so `unfreeze()` can resume
   * the same trace.
   */
  freeze() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  /** Resumes the live loop after a `freeze()`. No-op if there is nothing to resume. */
  unfreeze() {
    if (!this.analyser || this.frame) return;
    const tick = () => {
      this.frame = requestAnimationFrame(tick);
      this.render();
    };
    tick();
  }

  /**
   * Matches the backing store to the canvas's laid-out size.
   *
   * The canvas is sized by CSS, so this has to run per frame: a window resize
   * mid-demo would otherwise stretch the trace.
   *
   * @returns {{ctx: CanvasRenderingContext2D, width: number, height: number}|null}
   */
  measure() {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return null;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    return { ctx, width, height };
  }

  /**
   * Draws the static peak-envelope waveform of a captured take, with a vertical
   * marker at each segment boundary. Called by `render()` so a resize redraws it the
   * same way the live trace is redrawn, without re-reading an analyser.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} width
   * @param {number} height
   */
  drawRecording(ctx, width, height) {
    const middle = height / 2;
    ctx.clearRect(0, 0, width, height);

    const columns = Math.max(1, Math.round(width));
    const envelope = peakEnvelope(this.recordingSamples, columns);
    ctx.strokeStyle = this.liveColor;
    ctx.lineWidth = Math.max(1, Math.round((window.devicePixelRatio || 1) * 1.5));
    ctx.beginPath();
    for (let i = 0; i < envelope.length; i += 1) {
      ctx.moveTo(i, middle - envelope[i].max * middle);
      ctx.lineTo(i, middle - envelope[i].min * middle);
    }
    ctx.stroke();

    const segments = this.recordingSegments || [];
    if (segments.length < 2) return;
    const totalMs = segments[segments.length - 1].endMs;
    if (!(totalMs > 0)) return;
    ctx.strokeStyle = this.markerColor;
    ctx.lineWidth = Math.max(1, Math.round(window.devicePixelRatio || 1));
    for (let i = 1; i < segments.length; i += 1) {
      const x = (segments[i].startMs / totalMs) * width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  /** Draws one frame: the live trace while recording, the baseline otherwise. */
  render() {
    const measured = this.measure();
    if (!measured) return;
    const { ctx, width, height } = measured;
    const middle = height / 2;

    if (this.recordingSamples) {
      this.drawRecording(ctx, width, height);
      return;
    }

    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = Math.max(1, Math.round((window.devicePixelRatio || 1) * 1.5));
    ctx.lineJoin = "round";
    ctx.beginPath();

    if (!this.analyser || !this.data) {
      ctx.strokeStyle = this.idleColor;
      ctx.moveTo(0, middle);
      ctx.lineTo(width, middle);
      ctx.stroke();
      return;
    }

    this.analyser.getByteTimeDomainData(this.data);
    ctx.strokeStyle = this.liveColor;
    const step = width / (this.data.length - 1);
    for (let i = 0; i < this.data.length; i += 1) {
      // getByteTimeDomainData centres silence on 128; map [0, 255] onto the height.
      const y = middle + ((this.data[i] - 128) / 128) * middle;
      if (i === 0) ctx.moveTo(0, y);
      else ctx.lineTo(i * step, y);
    }
    ctx.stroke();
  }
}
