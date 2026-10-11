// Loads the *shipped* AudioWorklet processor under node, with the worklet globals
// stubbed the same way encode_fixture.mjs does, and drives it through a
// pause/resume cycle to prove `process()` stops posting sample chunks while paused
// without tearing the processor down (US-026).
//
// Usage: node pause_fixture.mjs -> prints JSON {postedWhileRecording, postedWhilePaused,
//                                               postedAfterResume, pausedFlagAfterToggle}

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");
const source = readFileSync(join(frontend, "recorder-worklet.js"), "utf8");

/** Stands in for the real MessagePort half of an AudioWorkletNode/Processor pair. */
class FakePort {
  constructor() {
    this.posted = [];
    this.onmessage = null;
  }
  postMessage(data) {
    this.posted.push(data);
  }
  /** Test helper: simulates a message arriving from the main thread. */
  send(data) {
    this.onmessage?.({ data });
  }
}

class FakeAudioWorkletProcessor {
  constructor() {
    this.port = new FakePort();
  }
}

let Captured = null;
function registerProcessor(_name, cls) {
  Captured = cls;
}

const load = new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", source);
load(FakeAudioWorkletProcessor, registerProcessor, 48000);

const instance = new Captured({ processorOptions: { targetSampleRate: 16000 } });

/** One input block: mono, non-silent, large enough to always flush the resampler. */
function block() {
  const samples = new Float32Array(960);
  for (let i = 0; i < samples.length; i += 1) samples[i] = 0.25;
  return [[samples]];
}

for (let i = 0; i < 4; i += 1) instance.process(block());
const postedWhileRecording = instance.port.posted.length;

instance.port.send({ type: "paused", value: true });
const pausedFlagAfterToggle = instance.paused;
instance.port.posted.length = 0;
for (let i = 0; i < 4; i += 1) instance.process(block());
const postedWhilePaused = instance.port.posted.length;

instance.port.send({ type: "paused", value: false });
instance.port.posted.length = 0;
for (let i = 0; i < 4; i += 1) instance.process(block());
const postedAfterResume = instance.port.posted.length;

process.stdout.write(
  JSON.stringify({ postedWhileRecording, postedWhilePaused, postedAfterResume, pausedFlagAfterToggle }),
);
