// Reading the `POST /api/analyze` server-sent-event stream.
//
// `EventSource` cannot issue a POST with a file body, so the stream is read by hand
// from `fetch` + the response's `ReadableStream`. That is the whole reason this module
// exists: a frame boundary can land anywhere in a network chunk, so the parsing has to
// be incremental rather than a split over the finished body.
//
// `SseDecoder` is pure — no fetch, no DOM — so the Python suite runs it under node over
// the bytes the real backend produced (backend/tests/test_frontend_analysis.py). The
// per-node timing is the thing the demo exists to show, so frames are handed to the
// caller the instant they are complete and nothing is buffered until `done`.

/** The terminal frame: the backend guarantees it is always last, even after `error`. */
export const DONE = "done";

/**
 * One SSE frame as `{event, data}`, or null if it carried no `data:` line.
 *
 * Comment lines (`: keep-alive`) and unknown fields are ignored, per the protocol.
 *
 * @param {string} frame the text between two blank lines
 * @returns {{event: string, data: object}|null}
 */
export function parseFrame(frame) {
  let event = "message";
  const data = [];
  for (const line of frame.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // A single leading space after the colon is part of the framing, not the value.
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length) return null;
  return { event, data: JSON.parse(data.join("\n")) };
}

/**
 * Incremental SSE frame decoder.
 *
 * `push()` returns every frame that became complete, keeping any trailing partial
 * frame for the next chunk. A network chunk is not a frame: one read can carry half a
 * frame, three frames, or a split in the middle of a JSON payload.
 */
export class SseDecoder {
  constructor() {
    this.buffer = "";
  }

  /** @param {string} text @returns {Array<{event: string, data: object}>} */
  push(text) {
    this.buffer += text.replace(/\r\n|\r/g, "\n");
    const frames = this.buffer.split("\n\n");
    // The last piece is whatever follows the final blank line: a partial frame, or "".
    this.buffer = frames.pop() ?? "";
    const parsed = [];
    for (const frame of frames) {
      const event = parseFrame(frame);
      if (event) parsed.push(event);
    }
    return parsed;
  }

  /** Any frame left unterminated when the stream ended. @returns {Array<{event: string, data: object}>} */
  flush() {
    const rest = this.buffer;
    this.buffer = "";
    const event = rest.trim() ? parseFrame(rest) : null;
    return event ? [event] : [];
  }
}

/** A rejection from the backend (HTTP 400 audio validation, or any non-200). */
export class AnalyzeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "AnalyzeError";
  }
}

/**
 * POSTs one encoded WAV to `/api/analyze` and calls `onEvent` per SSE frame.
 *
 * Resolves once `done` arrives (or the body ends). Rejects with an `AnalyzeError`
 * carrying the backend's `detail` when the audio was refused before the stream opened,
 * and with the fetch's own `AbortError` when `signal` is aborted — the caller tells
 * those apart by `name`.
 *
 * @param {Uint8Array} bytes the WAV bytes, exactly as encoded for playback
 * @param {{onEvent: (frame: {event: string, data: object}) => void,
 *          signal?: AbortSignal, fetchImpl?: typeof fetch}} options
 * @returns {Promise<void>}
 */
export async function streamAnalyze(bytes, { onEvent, signal, fetchImpl = fetch }) {
  const body = new FormData();
  body.append("audio", new Blob([bytes], { type: "audio/wav" }), "utterance.wav");
  const response = await fetchImpl("/api/analyze", { method: "POST", body, signal });
  if (!response.ok) throw new AnalyzeError(await rejection(response));

  const reader = response.body.getReader();
  const text = new TextDecoder();
  const decoder = new SseDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of decoder.push(text.decode(value, { stream: true }))) {
        onEvent(frame);
        if (frame.event === DONE) return;
      }
    }
    for (const frame of decoder.flush()) onEvent(frame);
  } finally {
    // Releases the connection on every exit path, including an early `done` return and
    // a mid-stream throw, so a second run is not queued behind a half-read response.
    void reader.cancel().catch(() => {});
  }
}

/**
 * The readable reason a non-200 gives, preferring the backend's own `detail`.
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function rejection(response) {
  try {
    const payload = await response.json();
    if (payload && payload.detail) return String(payload.detail);
  } catch {
    // A non-JSON error body is no help; fall back to the status.
  }
  return `HTTP ${response.status}`;
}
