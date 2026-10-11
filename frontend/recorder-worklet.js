// AudioWorklet that captures the microphone as mono 16 kHz float samples.
//
// Loaded with `audioWorklet.addModule()`, which runs it as a classic script in
// AudioWorkletGlobalScope — so it cannot `import` anything and must stay
// self-contained. That is why the resampler lives here rather than in wav.js.
//
// Where the browser honours `new AudioContext({ sampleRate: 16000 })` the ratio is 1
// and `push()` is a straight copy. Where it does not (Safari, and any device whose
// hardware rate is fixed), the same code path resamples here, off the main thread,
// so a long recording never competes with the UI.
//
// Kept free of worklet-only globals at the top level so node can load it and test
// `createResampler` directly (backend/tests/test_frontend_audio.py).

/**
 * Streaming linear resampler, mono in, mono out.
 *
 * Leftover input is carried between blocks, so the output is continuous: no clicks
 * at block boundaries and no dropped samples. Works for any ratio, including
 * upsampling from an 8 kHz device.
 *
 * @param {number} fromRate
 * @param {number} toRate
 */
function createResampler(fromRate, toRate) {
  const ratio = fromRate / toRate;
  let pending = new Float32Array(0);
  // Fractional read position inside `pending`, carried across blocks.
  let position = 0;

  return {
    ratio,
    /**
     * @param {Float32Array} block mono samples at `fromRate`
     * @returns {Float32Array} however many output samples that block completed
     */
    push(block) {
      const buffer = new Float32Array(pending.length + block.length);
      buffer.set(pending, 0);
      buffer.set(block, pending.length);

      // Interpolation needs both buffer[i] and buffer[i + 1], so stop one short.
      const count = Math.max(0, Math.ceil((buffer.length - 1 - position) / ratio));
      const out = new Float32Array(count);
      for (let n = 0; n < count; n += 1) {
        const index = Math.floor(position);
        const frac = position - index;
        out[n] = buffer[index] * (1 - frac) + buffer[index + 1] * frac;
        position += ratio;
      }

      // When downsampling, `position` can land past the end of this buffer; clamping
      // keeps the skipped remainder in `position` so the next block stays aligned.
      const consumed = Math.min(Math.floor(position), buffer.length);
      pending = buffer.slice(consumed);
      position -= consumed;
      return out;
    },
  };
}

/**
 * Averages however many channels arrived into one.
 *
 * getUserMedia is asked for mono, but the constraint is advisory — some devices
 * hand back stereo anyway, and the backend rejects anything but mono.
 *
 * @param {Float32Array[]} channels
 * @returns {Float32Array}
 */
function downmix(channels) {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const channel of channels) {
    for (let i = 0; i < out.length; i += 1) out[i] += channel[i] / channels.length;
  }
  return out;
}

class RecorderProcessor extends AudioWorkletProcessor {
  /** @param {{processorOptions?: {targetSampleRate?: number}}} options */
  constructor(options) {
    super();
    const target = options.processorOptions?.targetSampleRate ?? 16000;
    // `sampleRate` is the worklet global: the context's actual rate, which is not
    // necessarily the rate that was requested.
    this.resampler = createResampler(sampleRate, target);
    this.paused = false;
    // Pause/resume (US-026) travels over the port rather than tearing the processor
    // down, so the MediaStream/AudioContext/worklet stay alive across a pause.
    this.port.onmessage = (event) => {
      if (event.data?.type === "paused") this.paused = event.data.value;
    };
  }

  /** @param {Float32Array[][]} inputs */
  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || channels[0].length === 0) return true;
    if (this.paused) return true;
    const resampled = this.resampler.push(downmix(channels));
    if (resampled.length > 0) {
      this.port.postMessage(resampled, [resampled.buffer]);
    }
    return true;
  }
}

registerProcessor("recorder", RecorderProcessor);
