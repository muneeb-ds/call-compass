// WAV encoding — the one place in the frontend that knows the audio wire format.
//
// The backend (callcompass/audio.py) accepts exactly 16 kHz mono 16-bit PCM and
// refuses to resample or downmix, on purpose: a wrong header here must surface as a
// 400 rather than being quietly repaired, because the model would otherwise return a
// confident answer about audio it misheard (PRD risk R-5).
//
// Keep this module pure — no DOM, no AudioContext — so it can be run under node and
// cross-checked against the real decoder (backend/tests/test_frontend_audio.py).

/** Bytes per sample in the encoded output. 16-bit PCM, matching SAMPLE_WIDTH_BYTES. */
export const BYTES_PER_SAMPLE = 2;

/** The only sample rate the backend accepts. */
export const SAMPLE_RATE = 16000;

/** Longest recording the backend accepts, matching audio.py's MAX_SECONDS. */
export const MAX_SECONDS = 30;

const HEADER_BYTES = 44;
const FORMAT_PCM = 1;
const CHANNELS = 1;

/** @param {DataView} view @param {number} offset @param {string} text */
function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * Converts float samples in [-1, 1] to little-endian int16.
 *
 * The negative and positive full-scale values differ (-32768 vs 32767) because the
 * backend divides by 32768, so -1.0 must land on exactly -32768 to round-trip.
 *
 * @param {DataView} view
 * @param {number} offset
 * @param {Float32Array|number[]} samples
 */
function writePcm16(view, offset, samples) {
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset + i * BYTES_PER_SAMPLE, Math.round(value), true);
  }
}

/**
 * Encodes mono float samples as a complete 16-bit PCM WAV file.
 *
 * @param {Float32Array|number[]} samples mono, in [-1, 1]
 * @param {number} [sampleRate] defaults to the only rate the backend accepts
 * @returns {Uint8Array} the whole file, header included
 */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true); // size of everything after this field
  writeAscii(view, 8, "WAVE");

  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk is 16 bytes
  view.setUint16(20, FORMAT_PCM, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * CHANNELS * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, CHANNELS * BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true); // bits per sample

  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  writePcm16(view, HEADER_BYTES, samples);

  return new Uint8Array(buffer);
}

/**
 * Trims a buffer to the longest duration the backend accepts.
 *
 * The 30-second auto-stop fires on wall-clock time, so the worklet can have posted a
 * few milliseconds more audio than that by the time the context closes. Those few
 * milliseconds would be a 400 on a recording the operator watched succeed, so the
 * tail is dropped here rather than argued about.
 *
 * @param {Float32Array} samples
 * @param {number} [sampleRate]
 * @param {number} [maxSeconds]
 * @returns {Float32Array}
 */
export function clampSamples(samples, sampleRate = SAMPLE_RATE, maxSeconds = MAX_SECONDS) {
  const limit = Math.floor(sampleRate * maxSeconds);
  return samples.length > limit ? samples.subarray(0, limit) : samples;
}

/**
 * Flattens the chunks the worklet posted into one contiguous mono buffer.
 *
 * @param {Float32Array[]} chunks
 * @returns {Float32Array}
 */
export function concatChunks(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
