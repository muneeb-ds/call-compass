// The clip an uploaded audio file is cut down to — the pure half of the file source.
//
// A file can be any length, but the backend accepts 0.3-30 s. So the whole file is
// shown and the operator picks the part that is sent: a clip that can be made shorter
// than 30 s but never longer, and never shorter than the backend's minimum. Every
// rule about that window lives here, with no DOM and no AudioContext, so node can run
// it (backend/tests/test_frontend_clip.py) against the backend's own limits.
//
// A clip becomes the same `Recording` shape `capture.js` produces for a microphone
// take — WAV bytes, a Blob over those same bytes, and the decoded samples — so the
// analyzer, playback and the static waveform cannot tell the two sources apart, and
// playback plays exactly the bytes the backend receives.
import { MAX_SECONDS, MIN_SECONDS, SAMPLE_RATE, encodeWav } from "./wav.js";

/** Longest clip, in ms: the backend's ceiling. */
export const MAX_CLIP_MS = MAX_SECONDS * 1000;

/** Shortest clip, in ms: the backend's floor. */
export const MIN_CLIP_MS = MIN_SECONDS * 1000;

/** @typedef {{startMs: number, endMs: number}} Clip */

/** @param {number} value @param {number} lo @param {number} hi */
function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * Averages a file's channels into one, the same downmix the recorder worklet applies
 * to a stereo microphone, because the backend refuses anything but mono.
 *
 * @param {Float32Array[]} channels one array per channel, all the same length
 * @returns {Float32Array}
 */
export function downmix(channels) {
  if (channels.length === 1) return channels[0];
  const length = channels[0].length;
  const out = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i += 1) out[i] += channel[i];
  }
  for (let i = 0; i < length; i += 1) out[i] /= channels.length;
  return out;
}

/**
 * Whether a file of `durationMs` is long enough to clip at all.
 *
 * @param {number} durationMs
 */
export function canClip(durationMs) {
  return durationMs >= MIN_CLIP_MS;
}

/**
 * The clip a freshly loaded file starts with: from the beginning, as long as allowed.
 *
 * @param {number} durationMs the whole file
 * @returns {Clip}
 */
export function defaultClip(durationMs) {
  return { startMs: 0, endMs: Math.min(durationMs, MAX_CLIP_MS) };
}

/**
 * Moves the clip's start, keeping its end where it is. The start stops where the clip
 * would grow past 30 s or shrink under the minimum — it never drags the end along.
 *
 * @param {Clip} clip @param {number} startMs requested @param {number} durationMs
 * @returns {Clip}
 */
export function setClipStart(clip, startMs, durationMs) {
  const lo = Math.max(0, clip.endMs - MAX_CLIP_MS);
  const hi = clip.endMs - MIN_CLIP_MS;
  return { startMs: clamp(startMs, lo, Math.max(lo, hi)), endMs: Math.min(clip.endMs, durationMs) };
}

/**
 * Moves the clip's end, keeping its start where it is, under the same two limits.
 *
 * @param {Clip} clip @param {number} endMs requested @param {number} durationMs
 * @returns {Clip}
 */
export function setClipEnd(clip, endMs, durationMs) {
  const lo = clip.startMs + MIN_CLIP_MS;
  const hi = Math.min(durationMs, clip.startMs + MAX_CLIP_MS);
  return { startMs: clip.startMs, endMs: clamp(endMs, Math.min(lo, hi), hi) };
}

/**
 * Slides the whole clip so it starts at `startMs`, keeping its length and staying
 * inside the file.
 *
 * @param {Clip} clip @param {number} startMs requested @param {number} durationMs
 * @returns {Clip}
 */
export function moveClip(clip, startMs, durationMs) {
  const length = clip.endMs - clip.startMs;
  const start = clamp(startMs, 0, Math.max(0, durationMs - length));
  return { startMs: start, endMs: start + length };
}

/**
 * `m:ss.t`, the clip's own readout. Tenths, because a clip edge is set to 0.1 s.
 *
 * @param {number} ms
 */
export function formatClipTime(ms) {
  const tenths = Math.max(0, Math.round(ms / 100));
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths % 10}`;
}

/**
 * The line under the clip editor, e.g. `0:12.0 to 0:42.0, 30.0 s of 2:31.4`.
 *
 * @param {Clip} clip @param {number} durationMs the whole file
 */
export function describeClip(clip, durationMs) {
  const length = ((clip.endMs - clip.startMs) / 1000).toFixed(1);
  return (
    `${formatClipTime(clip.startMs)} to ${formatClipTime(clip.endMs)}, ` +
    `${length} s of ${formatClipTime(durationMs)}`
  );
}

/**
 * The samples a clip covers, as a copy, so the encoded clip never aliases the file.
 *
 * @param {Float32Array} samples the whole file, mono, at `sampleRate`
 * @param {Clip} clip @param {number} [sampleRate]
 * @returns {Float32Array}
 */
export function sliceClip(samples, clip, sampleRate = SAMPLE_RATE) {
  const start = clamp(Math.round((clip.startMs / 1000) * sampleRate), 0, samples.length);
  const end = clamp(Math.round((clip.endMs / 1000) * sampleRate), start, samples.length);
  // Rounding both edges can land one sample past the ceiling; trim it rather than
  // send the backend 30.0001 s.
  const max = Math.floor(MAX_SECONDS * sampleRate);
  return samples.slice(start, Math.min(end, start + max));
}

/**
 * Encodes a clip as the `Recording` the analyzer and playback take — the same shape a
 * microphone take has, so nothing downstream needs to know which source it came from.
 *
 * @param {Float32Array} samples the whole file, mono, at 16 kHz
 * @param {Clip} clip
 * @returns {import("./capture.js").Recording}
 */
export function clipRecording(samples, clip) {
  const clipped = sliceClip(samples, clip, SAMPLE_RATE);
  const bytes = encodeWav(clipped, SAMPLE_RATE);
  const durationMs = Math.round((clipped.length / SAMPLE_RATE) * 1000);
  return {
    bytes,
    blob: new Blob([bytes], { type: "audio/wav" }),
    samples: clipped,
    durationMs,
    sampleRate: SAMPLE_RATE,
    segments: [{ startMs: 0, endMs: durationMs }],
  };
}
