// Microphone capture: getUserMedia -> AudioWorklet -> 16 kHz mono 16-bit PCM WAV.
//
// The whole conversion is client-side and in memory. `stop()` returns the encoded
// bytes once, and the same bytes serve both the upload and the playback control
// (US-011) — playing back a separate MediaRecorder blob would show the operator
// audio the model never heard, which is the opposite of useful when a run misfires.

import { SAMPLE_RATE, concatChunks, encodeWav } from "./wav.js";

/** Name registered by recorder-worklet.js. */
const PROCESSOR = "recorder";
const WORKLET_URL = "./recorder-worklet.js";

/**
 * Capture failed for a reason the operator can act on.
 *
 * The message is written to be shown verbatim in the Capture column.
 */
export class MicrophoneError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "MicrophoneError";
  }
}

/** @param {unknown} err @returns {MicrophoneError} */
function describe(err) {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new MicrophoneError(
      "Microphone access was denied. Allow it in the browser's site settings, then try again.",
    );
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new MicrophoneError("No microphone was found. Connect one and reload the page.");
  }
  if (name === "NotReadableError") {
    return new MicrophoneError("The microphone is in use by another application.");
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new MicrophoneError(`Could not start recording: ${detail}`);
}

/**
 * One recording session's worth of audio, encoded and ready to send.
 *
 * @typedef {object} Recording
 * @property {Uint8Array} bytes the complete WAV file
 * @property {Blob} blob the same bytes, for playback
 * @property {number} durationMs
 * @property {number} sampleRate always 16000
 */

/**
 * Records one utterance at a time.
 *
 * A single instance is reused across runs: `start()` opens the mic and `stop()`
 * releases every resource it took (tracks, worklet, AudioContext), so holding the
 * page open all demo long does not leave the mic indicator lit.
 */
export class Recorder {
  constructor() {
    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {AudioContext|null} */
    this.context = null;
    /** @type {AudioWorkletNode|null} */
    this.node = null;
    /** Exposed so the waveform (US-010) can read frequency data while recording.
     * @type {AnalyserNode|null} */
    this.analyser = null;
    /** @type {Float32Array[]} */
    this.chunks = [];
    this.recording = false;
  }

  /**
   * Opens the microphone and starts collecting samples.
   *
   * @throws {MicrophoneError} if the mic is unavailable, denied, or unsupported
   */
  async start() {
    if (this.recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      throw new MicrophoneError(
        "This browser cannot capture audio. Use a recent Chrome or Edge over http://localhost or HTTPS.",
      );
    }

    this.chunks = [];
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      // Asking for 16 kHz lets the browser resample in native code; where the
      // request is ignored, the worklet resamples from `context.sampleRate`.
      this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
      await this.context.audioWorklet.addModule(WORKLET_URL);

      const source = this.context.createMediaStreamSource(this.stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.node = new AudioWorkletNode(this.context, PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { targetSampleRate: SAMPLE_RATE },
      });
      this.node.port.onmessage = (event) => {
        this.chunks.push(new Float32Array(event.data));
      };
      source.connect(this.analyser);
      this.analyser.connect(this.node);
      this.recording = true;
    } catch (err) {
      await this.release();
      throw describe(err);
    }
  }

  /**
   * Stops the microphone and encodes everything captured.
   *
   * @returns {Promise<Recording|null>} null if nothing was being recorded
   */
  async stop() {
    if (!this.recording) return null;
    this.recording = false;
    await this.release();

    const samples = concatChunks(this.chunks);
    const bytes = encodeWav(samples, SAMPLE_RATE);
    return {
      bytes,
      blob: new Blob([bytes], { type: "audio/wav" }),
      durationMs: Math.round((samples.length / SAMPLE_RATE) * 1000),
      sampleRate: SAMPLE_RATE,
    };
  }

  /** Tears down the mic, the worklet and the context. Safe to call twice. */
  async release() {
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    this.analyser?.disconnect();
    this.analyser = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
  }
}
