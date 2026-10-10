// Playback of the captured recording.
//
// This is the demo operator's diagnostic for a misfire (PRD risk R-1): when the model
// picks a branch that looks wrong, the first question is what it actually heard. So
// playback plays the *encoded WAV bytes that were uploaded* — the recording's own
// `blob`, which capture.js builds over the same `bytes` the POST sends. A separate
// MediaRecorder blob would answer a different question.
//
// Every DOM node is injected, so nothing here touches `document` and the module can be
// exercised from node (see backend/tests/playback_fixture.mjs).

import { formatElapsed } from "./timer.js";

/**
 * Play/pause control plus an elapsed-of-duration readout for one recording.
 *
 * Before any recording exists the control is **disabled, not hidden**: the row has to
 * stay on screen so the operator can see the demo has a playback affordance at all.
 */
export class Playback {
  /**
   * @param {HTMLButtonElement} button
   * @param {HTMLElement} readout
   * @param {HTMLAudioElement} audio
   */
  constructor(button, readout, audio) {
    this.button = button;
    this.readout = readout;
    this.audio = audio;
    /** Object URL currently held, revoked on the next load/clear. @type {string} */
    this.url = "";
    /** Duration of the loaded recording in ms, from the encoder rather than the
     * element — `audio.duration` is NaN until metadata arrives. */
    this.durationMs = 0;

    this.audio.addEventListener("timeupdate", () => this.render());
    this.audio.addEventListener("play", () => this.render());
    this.audio.addEventListener("pause", () => this.render());
    this.audio.addEventListener("ended", () => {
      // Back to the start, so a second press replays rather than doing nothing.
      this.audio.currentTime = 0;
      this.render();
    });
    this.clear();
  }

  /** True while the element is playing. */
  get playing() {
    return !this.audio.paused && !this.audio.ended;
  }

  /**
   * Points the control at a recording and enables it.
   *
   * @param {import("./capture.js").Recording} recording
   */
  load(recording) {
    this.revoke();
    this.url = URL.createObjectURL(recording.blob);
    this.durationMs = recording.durationMs;
    this.audio.src = this.url;
    this.button.disabled = false;
    this.render();
  }

  /** Returns to the no-recording state: stopped, zeroed, and disabled. */
  clear() {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.revoke();
    this.durationMs = 0;
    this.button.disabled = true;
    this.render();
  }

  /** Play <-> pause. A no-op while disabled, so it is safe to wire to a hotkey later. */
  toggle() {
    if (this.button.disabled) return;
    if (this.playing) {
      this.audio.pause();
    } else {
      void this.audio.play();
    }
    this.render();
  }

  /** Releases the object URL. Safe to call twice. */
  revoke() {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = "";
  }

  /** Repaints the button label and the `0:03 / 0:07` readout. */
  render() {
    const playing = !this.button.disabled && this.playing;
    this.button.textContent = playing ? "Pause" : "Play";
    this.button.dataset.playing = String(playing);
    this.button.setAttribute("aria-pressed", String(playing));
    const elapsed = this.url ? (this.audio.currentTime || 0) * 1000 : 0;
    this.readout.textContent = formatElapsed(elapsed, this.durationMs);
  }
}
