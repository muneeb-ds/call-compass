// Drives the *shipped* frontend playback control under node and prints what it did as
// JSON, so the Python suite can check the one thing that actually matters: the bytes
// handed to the audio element are byte-identical to the bytes POSTed to /api/analyze
// (see test_frontend_playback.py).
//
// The DOM is stubbed rather than emulated — playback.js takes its button, readout and
// audio element as constructor arguments and never touches `document`, so three small
// fakes are enough.
//
// Usage: node playback_fixture.mjs [seconds]  -> JSON on stdout

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");
const load = (name) => import(pathToFileURL(join(frontend, name)).href);

/** Object URLs handed out by the stub, so the test can see what was revoked. */
const objects = new Map();
let nextUrl = 0;
URL.createObjectURL = (blob) => {
  const url = `blob:stub/${nextUrl++}`;
  objects.set(url, blob);
  return url;
};
URL.revokeObjectURL = (url) => {
  objects.delete(url);
};

/** The smallest element that satisfies what playback.js reads and writes. */
function fakeElement(extra = {}) {
  const listeners = new Map();
  return {
    dataset: {},
    attributes: {},
    textContent: "",
    listeners,
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    removeAttribute(name) {
      delete this[name];
    },
    emit(type) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
    ...extra,
  };
}

function fakeAudio() {
  return fakeElement({
    src: "",
    paused: true,
    ended: false,
    currentTime: 0,
    play() {
      this.paused = false;
      this.ended = false;
      this.emit("play");
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
      this.emit("pause");
    },
  });
}

const { SAMPLE_RATE, encodeWav } = await load("wav.js");
const { Playback } = await load("playback.js");

const seconds = Number(process.argv[2] ?? 1);
const samples = new Float32Array(Math.round(SAMPLE_RATE * seconds)).fill(0.25);
const bytes = encodeWav(samples, SAMPLE_RATE);
// Exactly what capture.js's stop() returns: a blob over the *same* bytes as the upload.
const recording = {
  bytes,
  blob: new Blob([bytes], { type: "audio/wav" }),
  durationMs: Math.round((samples.length / SAMPLE_RATE) * 1000),
  sampleRate: SAMPLE_RATE,
};

const button = fakeElement({ disabled: false });
const readout = fakeElement();
const audio = fakeAudio();
const playback = new Playback(button, readout, audio);

/** @returns the operator-visible state of the control. */
const snapshot = (note) => ({
  note,
  disabled: button.disabled,
  label: button.textContent,
  pressed: button.attributes["aria-pressed"],
  playing: button.dataset.playing,
  readout: readout.textContent,
  hasSource: Boolean(audio.src),
});

const states = [snapshot("initial")];

// A press before any recording exists must do nothing at all.
playback.toggle();
states.push(snapshot("toggled while empty"));

playback.load(recording);
const loadedUrl = playback.url;
states.push(snapshot("loaded"));

playback.toggle();
states.push(snapshot("playing"));

audio.currentTime = 0.4;
audio.emit("timeupdate");
states.push(snapshot("mid-playback"));

playback.toggle();
states.push(snapshot("paused"));

playback.toggle();
audio.currentTime = recording.durationMs / 1000;
audio.ended = true;
audio.paused = true;
audio.emit("ended");
states.push(snapshot("ended"));

// Re-loading (the operator records again) must release the previous object URL.
playback.load(recording);
const reloadedUrl = playback.url;
const servedBlob = objects.get(reloadedUrl);
const served = Buffer.from(await servedBlob.arrayBuffer());

playback.clear();

process.stdout.write(
  JSON.stringify({
    states,
    cleared: snapshot("cleared"),
    durationMs: recording.durationMs,
    // Byte-for-byte what the audio element was given, and what the upload sends.
    playedBase64: served.toString("base64"),
    uploadedBase64: Buffer.from(bytes).toString("base64"),
    blobType: servedBlob.type,
    staleUrlRevoked: !objects.has(loadedUrl),
    liveUrlsAfterClear: objects.size,
  }),
);
