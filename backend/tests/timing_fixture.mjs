// Runs the *shipped* frontend clock and duration-clamp logic under node and prints
// the results as JSON, so the Python suite can check them against the backend's own
// limits (see test_frontend_timing.py).
//
// The 30-second ceiling the UI shows and the ceiling the backend enforces have to be
// the same number; a timer that let a recording run one tick long would turn a demo
// recording the operator watched succeed into an HTTP 400.
//
// Usage: node timing_fixture.mjs            -> {"maxRecordingMs":..., "clock": {...}}
//        node timing_fixture.mjs <seconds>  -> a base64 WAV clamped from that duration

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");
const load = (name) => import(pathToFileURL(join(frontend, name)).href);

const { MAX_SECONDS, SAMPLE_RATE, clampSamples, encodeWav } = await load("wav.js");
const { MAX_RECORDING_MS, accumulatedElapsed, formatClock, formatElapsed, remainingMs } =
  await load("timer.js");
const { deriveSegments } = await load("capture.js");

const seconds = process.argv[2] === undefined ? null : Number(process.argv[2]);

if (seconds === null) {
  const cases = [0, 1, 999, 1000, 12_000, 59_999, 60_000, 90_500, MAX_RECORDING_MS];
  process.stdout.write(
    JSON.stringify({
      maxSeconds: MAX_SECONDS,
      maxRecordingMs: MAX_RECORDING_MS,
      clock: Object.fromEntries(cases.map((ms) => [ms, formatClock(ms)])),
      elapsed: Object.fromEntries(cases.map((ms) => [ms, formatElapsed(ms)])),
      // The display must never read past its own ceiling, even if the stop lands late.
      overrun: formatElapsed(MAX_RECORDING_MS + 400),
      pausedReadout: formatElapsed(12_000, MAX_RECORDING_MS, true),
      // Two pauses: a 5s span, a pause, a 7s span, a second pause, both folded into
      // `accumulatedMs` the way RecordingTimer.pause() does - only wall-clock marks go in.
      accumulated: {
        running: accumulatedElapsed(5000, 20_000, 23_000, MAX_RECORDING_MS),
        pausedAfterTwoSpans: accumulatedElapsed(12_000, 0, 999_999, MAX_RECORDING_MS),
        clampedToCeiling: accumulatedElapsed(25_000, 1000, 10_000, MAX_RECORDING_MS),
      },
      remaining: {
        midTake: remainingMs(12_000, MAX_RECORDING_MS),
        pastCeiling: remainingMs(35_000, MAX_RECORDING_MS),
      },
      segments: {
        singleUnpaused: deriveSegments(
          [{ startSample: 0, endSample: 480_000 }],
          480_000,
          SAMPLE_RATE,
        ),
        twoSegmentTake: deriveSegments(
          [
            { startSample: 0, endSample: 160_000 },
            { startSample: 160_000, endSample: 320_000 },
          ],
          320_000,
          SAMPLE_RATE,
        ),
        clippedAtCeiling: deriveSegments(
          [
            { startSample: 0, endSample: 320_000 },
            { startSample: 320_000, endSample: 500_000 },
          ],
          480_000,
          SAMPLE_RATE,
        ),
      },
    }),
  );
} else {
  // A constant 0.25 so a dropped or duplicated sample can't hide in the waveform.
  const samples = new Float32Array(Math.round(SAMPLE_RATE * seconds)).fill(0.25);
  process.stdout.write(
    Buffer.from(encodeWav(clampSamples(samples), SAMPLE_RATE)).toString("base64"),
  );
}
