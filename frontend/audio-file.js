// The audio-file source: decoding a chosen file, and the editor that picks its clip.
//
// This is the drawing half; every rule about what a clip may be lives in `clip.js`,
// which node can run. The file is decoded once, in the browser, straight to the
// backend's 16 kHz (decodeAudioData resamples to its context's rate) and downmixed to
// mono, so a clip is just a slice of samples — choosing a different part of the file
// never re-decodes it.
//
// The clip is set two ways that always agree: dragging on the waveform (the window's
// body moves it, its edges resize it), and two native range inputs, which are what
// give the editor keyboard control without any `tabindex`.
import { MIN_CLIP_MS, canClip, describeClip, downmix, moveClip, setClipEnd, setClipStart } from "./clip.js";
import { SAMPLE_RATE } from "./wav.js";
import { peakEnvelope, readColorToken } from "./waveform.js";

/** How close to a window edge, in CSS px, a press grabs that edge instead of the body. */
const EDGE_GRAB_PX = 10;

/** Thrown for a file the browser cannot decode or one too short to clip. */
export class AudioFileError extends Error {}

/**
 * @typedef {object} AudioFile
 * @property {string} name the file's own name, for the readout
 * @property {Float32Array} samples the whole file, mono, at 16 kHz
 * @property {number} durationMs
 */

/**
 * Decodes any format the browser can play into 16 kHz mono samples.
 *
 * @param {File} file
 * @param {{OfflineContext?: typeof OfflineAudioContext}} [deps]
 * @returns {Promise<AudioFile>}
 */
export async function decodeAudioFile(file, deps = {}) {
  const Context = deps.OfflineContext ?? globalThis.OfflineAudioContext;
  if (!Context) throw new AudioFileError("This browser cannot decode audio files.");
  let buffer;
  try {
    buffer = await new Context(1, 1, SAMPLE_RATE).decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new AudioFileError(
      `Could not read "${file.name}" as audio. Choose a WAV, MP3, M4A, OGG or FLAC file.`,
    );
  }
  const channels = [];
  for (let i = 0; i < buffer.numberOfChannels; i += 1) channels.push(buffer.getChannelData(i));
  const samples = downmix(channels);
  const durationMs = Math.round((samples.length / SAMPLE_RATE) * 1000);
  if (!canClip(durationMs)) {
    throw new AudioFileError(
      `"${file.name}" is ${(durationMs / 1000).toFixed(2)} s long; ` +
        `a clip needs at least ${MIN_CLIP_MS / 1000} s of audio.`,
    );
  }
  return { name: file.name, samples, durationMs };
}

/**
 * The whole file's waveform with the clip window over it, plus the start/end inputs.
 *
 * `onInput(clip)` fires on every change while it is being made (redraw only);
 * `onCommit(clip)` fires once a change is finished — a drag released, a range input's
 * `change` — which is when the clip is worth re-encoding.
 */
export class ClipEditor {
  /**
   * @param {{track: HTMLElement, canvas: HTMLCanvasElement, windowEl: HTMLElement,
   *          playheadEl: HTMLElement, startInput: HTMLInputElement,
   *          endInput: HTMLInputElement, readout: HTMLElement}} els
   * @param {{onCommit?: (clip: import("./clip.js").Clip) => void}} [hooks]
   */
  constructor(els, hooks = {}) {
    Object.assign(this, els);
    this.onCommit = hooks.onCommit;
    /** @type {AudioFile|null} */
    this.file = null;
    /** @type {import("./clip.js").Clip|null} */
    this.clip = null;
    this.disabled = false;
    /** Peak envelope cached per canvas width, so a drag redraws without rescanning. */
    this.envelope = null;
    this.envelopeWidth = 0;
    /** The drag in progress: what it grabbed and where, or null. */
    this.drag = null;
    this.dimColor = readColorToken("--text-dim", "#93a3bc");
    this.clipColor = readColorToken("--accent", "#f2b544");

    this.startInput.addEventListener("input", () => this.setStart(Number(this.startInput.value)));
    this.endInput.addEventListener("input", () => this.setEnd(Number(this.endInput.value)));
    this.startInput.addEventListener("change", () => this.commit());
    this.endInput.addEventListener("change", () => this.commit());
    this.track.addEventListener("pointerdown", (event) => this.pointerDown(event));
    this.track.addEventListener("pointermove", (event) => this.pointerMove(event));
    this.track.addEventListener("pointerup", (event) => this.pointerUp(event));
    this.track.addEventListener("pointercancel", (event) => this.pointerUp(event));
    this.clear();
  }

  /** @param {AudioFile} file @param {import("./clip.js").Clip} clip */
  load(file, clip) {
    this.file = file;
    this.envelope = null;
    for (const input of [this.startInput, this.endInput]) {
      input.max = String(file.durationMs);
    }
    this.track.dataset.state = "loaded";
    this.setClip(clip);
  }

  /** No file: an empty track, inputs disabled — never hidden. */
  clear() {
    this.file = null;
    this.clip = null;
    this.envelope = null;
    this.track.dataset.state = "empty";
    this.readout.textContent = "No file chosen";
    this.setPlayhead(null);
    this.render();
    this.setDisabled(this.disabled);
  }

  /** @param {boolean} disabled */
  setDisabled(disabled) {
    this.disabled = disabled;
    const off = disabled || !this.file;
    this.startInput.disabled = off;
    this.endInput.disabled = off;
    this.track.dataset.disabled = String(off);
  }

  /** @param {import("./clip.js").Clip} clip */
  setClip(clip) {
    this.clip = clip;
    this.startInput.value = String(Math.round(clip.startMs));
    this.endInput.value = String(Math.round(clip.endMs));
    this.readout.textContent = describeClip(clip, this.file.durationMs);
    const left = (clip.startMs / this.file.durationMs) * 100;
    const width = ((clip.endMs - clip.startMs) / this.file.durationMs) * 100;
    this.windowEl.style.left = `${left}%`;
    this.windowEl.style.width = `${width}%`;
    this.render();
  }

  /** @param {number} ms */
  setStart(ms) {
    if (this.file) this.setClip(setClipStart(this.clip, ms, this.file.durationMs));
  }

  /** @param {number} ms */
  setEnd(ms) {
    if (this.file) this.setClip(setClipEnd(this.clip, ms, this.file.durationMs));
  }

  commit() {
    if (this.file && this.onCommit) this.onCommit(this.clip);
  }

  /**
   * Marks how far playback has got, in ms from the start of the clip; null hides it.
   *
   * @param {number|null} clipMs
   */
  setPlayhead(clipMs) {
    if (clipMs === null || !this.file || !this.clip) {
      this.playheadEl.hidden = true;
      return;
    }
    const at = Math.min(this.clip.startMs + clipMs, this.clip.endMs);
    this.playheadEl.style.left = `${(at / this.file.durationMs) * 100}%`;
    this.playheadEl.hidden = false;
  }

  /** @param {PointerEvent} event */
  msAt(event) {
    const rect = this.track.getBoundingClientRect();
    const fraction = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    return Math.min(Math.max(fraction, 0), 1) * this.file.durationMs;
  }

  /** @param {PointerEvent} event */
  pointerDown(event) {
    if (this.disabled || !this.file) return;
    const rect = this.track.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const left = (this.clip.startMs / this.file.durationMs) * rect.width;
    const right = (this.clip.endMs / this.file.durationMs) * rect.width;
    const ms = this.msAt(event);
    if (Math.abs(x - left) <= EDGE_GRAB_PX) {
      this.drag = { grab: "start" };
    } else if (Math.abs(x - right) <= EDGE_GRAB_PX) {
      this.drag = { grab: "end" };
    } else if (x > left && x < right) {
      this.drag = { grab: "move", offsetMs: ms - this.clip.startMs };
    } else {
      // A press outside the window brings the window there, centred on the press,
      // and the same press can keep dragging it.
      const half = (this.clip.endMs - this.clip.startMs) / 2;
      this.setClip(moveClip(this.clip, ms - half, this.file.durationMs));
      this.drag = { grab: "move", offsetMs: ms - this.clip.startMs };
    }
    this.track.dataset.dragging = this.drag.grab;
    this.track.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  /** @param {PointerEvent} event */
  pointerMove(event) {
    if (!this.drag) {
      if (this.file && !this.disabled) this.track.dataset.hover = this.edgeAt(event);
      return;
    }
    const ms = this.msAt(event);
    if (this.drag.grab === "start") this.setStart(ms);
    else if (this.drag.grab === "end") this.setEnd(ms);
    else this.setClip(moveClip(this.clip, ms - this.drag.offsetMs, this.file.durationMs));
  }

  /** @param {PointerEvent} event */
  pointerUp(event) {
    if (!this.drag) return;
    this.drag = null;
    delete this.track.dataset.dragging;
    if (this.track.hasPointerCapture(event.pointerId)) {
      this.track.releasePointerCapture(event.pointerId);
    }
    this.commit();
  }

  /** Which edge a hover is over, so the cursor can say what a press will do. */
  edgeAt(event) {
    const rect = this.track.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const left = (this.clip.startMs / this.file.durationMs) * rect.width;
    const right = (this.clip.endMs / this.file.durationMs) * rect.width;
    if (Math.abs(x - left) <= EDGE_GRAB_PX || Math.abs(x - right) <= EDGE_GRAB_PX) return "edge";
    return x > left && x < right ? "body" : "outside";
  }

  /** Redraws the whole file: dim outside the clip, lamp amber inside it. */
  render() {
    const canvas = this.canvas;
    const dpr = globalThis.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const mid = height / 2;
    if (!this.file) {
      ctx.fillStyle = this.dimColor;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(0, Math.round(mid), width, Math.max(1, Math.round(dpr)));
      ctx.globalAlpha = 1;
      return;
    }
    const step = Math.max(1, Math.round(2 * dpr));
    const columns = Math.floor(width / step);
    if (!this.envelope || this.envelopeWidth !== columns) {
      this.envelope = peakEnvelope(this.file.samples, columns);
      this.envelopeWidth = columns;
    }
    const startCol = (this.clip.startMs / this.file.durationMs) * columns;
    const endCol = (this.clip.endMs / this.file.durationMs) * columns;
    for (let i = 0; i < columns; i += 1) {
      const { min, max } = this.envelope[i];
      const top = mid - Math.max(max, 0) * mid * 0.95;
      const bottom = mid - Math.min(min, 0) * mid * 0.95;
      ctx.fillStyle = i >= startCol && i < endCol ? this.clipColor : this.dimColor;
      ctx.fillRect(i * step, top, Math.max(1, step - Math.round(dpr)), Math.max(1, bottom - top));
    }
  }
}
