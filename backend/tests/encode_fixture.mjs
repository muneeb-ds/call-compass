// Runs the *real* frontend capture pipeline under node and prints the WAV it
// produces as base64, so the Python suite can feed it to the real decoder.
//
// This is the only automated check that the browser-side encoding actually
// satisfies `callcompass.audio.decode_wav` — PRD risk R-5, where a subtly wrong
// header or sample rate yields confidently wrong model output instead of an error.
// The worklet is loaded the same way the browser loads it (a classic script with
// the AudioWorklet globals injected), so the resampler under test is the shipped one.
//
// Usage: node encode_fixture.mjs <sourceRate> <seconds> [blockSize]

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");
const { concatChunks, encodeWav } = await import(pathToFileURL(join(frontend, "wav.js")).href);

/** Loads `createResampler` out of the worklet, standing in for the worklet globals. */
function loadResamplerFactory(contextRate) {
  const source = readFileSync(join(frontend, "recorder-worklet.js"), "utf8");
  const load = new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    "sampleRate",
    `${source}\nreturn createResampler;`,
  );
  return load(class {}, () => {}, contextRate);
}

const sourceRate = Number(process.argv[2] ?? 48000);
const seconds = Number(process.argv[3] ?? 1);
const blockSize = Number(process.argv[4] ?? 128);

// A 220 Hz tone, the same signal the Python fixture generator uses.
const frames = Math.round(sourceRate * seconds);
const input = new Float32Array(frames);
for (let i = 0; i < frames; i += 1) {
  input[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / sourceRate);
}

const createResampler = loadResamplerFactory(sourceRate);
const resampler = createResampler(sourceRate, 16000);
const chunks = [];
for (let offset = 0; offset < input.length; offset += blockSize) {
  chunks.push(resampler.push(input.subarray(offset, offset + blockSize)));
}

const wav = encodeWav(concatChunks(chunks), 16000);
process.stdout.write(Buffer.from(wav).toString("base64"));
