// Runs the *shipped* frontend clip rules under node and prints the results as JSON, so
// the Python suite can check them against the backend's own limits and decoder (see
// test_frontend_clip.py).
//
// An uploaded file can be any length; the clip the operator picks from it is what is
// sent. A clip rule that let 30.0001 s through, or 0.29 s, would turn a clip the
// operator watched being accepted on screen into an HTTP 400.
//
// Usage: node clip_fixture.mjs -> {"limits": ..., "rules": ..., "wavs": {name: base64}}

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");
const load = (name) => import(pathToFileURL(join(frontend, name)).href);

const {
  MAX_CLIP_MS,
  MIN_CLIP_MS,
  canClip,
  clipRecording,
  defaultClip,
  describeClip,
  downmix,
  formatClipTime,
  moveClip,
  setClipEnd,
  setClipStart,
  sliceClip,
} = await load("clip.js");
const { MAX_SECONDS, MIN_SECONDS, SAMPLE_RATE } = await load("wav.js");

const LONG_MS = 75_000;
/** A 75 s file at 16 kHz: a slow ramp, so every sample's position is recoverable. */
const long = new Float32Array((LONG_MS / 1000) * SAMPLE_RATE);
for (let i = 0; i < long.length; i += 1) long[i] = (i % 1000) / 1000 - 0.5;

const b64 = (bytes) => Buffer.from(bytes).toString("base64");

process.stdout.write(
  JSON.stringify({
    limits: { maxClipMs: MAX_CLIP_MS, minClipMs: MIN_CLIP_MS, maxSeconds: MAX_SECONDS, minSeconds: MIN_SECONDS },
    rules: {
      defaultLong: defaultClip(LONG_MS),
      defaultShort: defaultClip(12_000),
      canClip: { tooShort: canClip(299), justEnough: canClip(300) },
      // The end can't be dragged past 30 s from the start, nor past the file.
      endPastCeiling: setClipEnd({ startMs: 0, endMs: 30_000 }, 70_000, LONG_MS),
      endPastFile: setClipEnd({ startMs: 60_000, endMs: 70_000 }, 99_000, LONG_MS),
      endShrunk: setClipEnd({ startMs: 10_000, endMs: 40_000 }, 25_000, LONG_MS),
      endUnderMinimum: setClipEnd({ startMs: 10_000, endMs: 40_000 }, 10_100, LONG_MS),
      // The start can't be dragged back more than 30 s before the end, nor past 0.
      startPastCeiling: setClipStart({ startMs: 40_000, endMs: 60_000 }, 0, LONG_MS),
      startPastZero: setClipStart({ startMs: 5_000, endMs: 20_000 }, -800, LONG_MS),
      startUnderMinimum: setClipStart({ startMs: 40_000, endMs: 60_000 }, 59_950, LONG_MS),
      // Moving keeps the length and stays inside the file.
      moved: moveClip({ startMs: 0, endMs: 30_000 }, 25_000, LONG_MS),
      movedPastEnd: moveClip({ startMs: 0, endMs: 30_000 }, 70_000, LONG_MS),
      movedPastStart: moveClip({ startMs: 20_000, endMs: 37_500 }, -5_000, LONG_MS),
      time: [formatClipTime(0), formatClipTime(54_449), formatClipTime(75_000), formatClipTime(605_960)],
      describe: describeClip({ startMs: 37_000, endMs: 54_500 }, LONG_MS),
      downmix: Array.from(downmix([new Float32Array([1, 0, 0.5]), new Float32Array([0, 1, -0.5])])),
      mono: downmix([long]) === long,
      // A slice starts on the sample its start time names.
      sliceFirst: sliceClip(long, { startMs: 1_000, endMs: 2_000 })[0],
      sliceLength: sliceClip(long, { startMs: 1_000, endMs: 2_000 }).length,
      sliceAtFileEnd: sliceClip(long, { startMs: 74_000, endMs: 80_000 }).length,
      // Edges that are not whole samples must not round up past the ceiling.
      sliceFractional: sliceClip(long, { startMs: 12_345.67, endMs: 42_345.69 }).length,
      recordingFields: (() => {
        const r = clipRecording(long, { startMs: 20_000, endMs: 35_000 });
        return {
          durationMs: r.durationMs,
          sampleRate: r.sampleRate,
          segments: r.segments,
          blobMatchesBytes: r.blob.size === r.bytes.length,
          samplesMatchBytes: r.samples.length * 2 + 44 === r.bytes.length,
        };
      })(),
    },
    wavs: {
      fullCeiling: b64(clipRecording(long, defaultClip(LONG_MS)).bytes),
      fromMiddle: b64(clipRecording(long, moveClip(defaultClip(LONG_MS), 30_000, LONG_MS)).bytes),
      fractional: b64(clipRecording(long, { startMs: 12_345.67, endMs: 42_345.69 }).bytes),
      shortest: b64(clipRecording(long, setClipEnd({ startMs: 5_000, endMs: 9_000 }, 0, LONG_MS)).bytes),
    },
  }),
);
