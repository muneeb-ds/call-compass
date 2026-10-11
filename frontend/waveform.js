// Live recording waveform, drawn on a Canvas from an AnalyserNode.
//
// Purely cosmetic — it never touches the captured samples. Its job is operator
// confidence: a flat line while the button says "Stop" is the one unambiguous sign
// that the mic is open but hearing nothing, which is otherwise indistinguishable
// from a model misfire when the demo goes wrong.

/** Idle baseline and live trace colour fallbacks, matching styles.css's defaults. */
const IDLE_FALLBACK = "#8b949e";
const LIVE_FALLBACK = "#f85149";

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
function readColorToken(name, fallback) {
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
    this.render();
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

  /** Draws one frame: the live trace while recording, the baseline otherwise. */
  render() {
    const measured = this.measure();
    if (!measured) return;
    const { ctx, width, height } = measured;
    const middle = height / 2;

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
