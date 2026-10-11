// The outcome strip: the one line drawn in the capture dock after a terminal event.
//
// It is the one place on screen that states what the traversal reached, in plain
// language, without reading as advice: a leaf is a classification outcome, not a line
// to say to a customer (see `backend/callcompass/tree.py`). There are three looks,
// keyed by the strip's `data-state`: `completed` (the leaf reached), `unplaced` (the
// model declined, with no leaf label at all), and `error` (the run broke).
//
// It renders only from a terminal event — never mid-traversal — and before the first
// run it is absent entirely, not an empty placeholder box, so the dock's shape before
// any take is just its controls.
//
// `OutcomeStrip` takes its container as an argument and never touches `document`,
// which is how the Python suite drives it under node over the bytes the real backend
// produced.

import { humanize } from "./trace.js";

/** Between breadcrumb segments. An arrow, not a slash: the path has a direction. */
export const BREADCRUMB_SEPARATOR = " → ";

/**
 * The path taken as a readable breadcrumb of the *options* that were chosen.
 *
 * Deliberately the picked options (`step.tool_called`), not the node ids in the
 * terminal event's `path`: "Pricing question → Pro tier → Budget objection" is the
 * conversation, whereas the node labels are the questions the tree asked.
 *
 * @param {string[]} picks each step's `tool_called`, in arrival order
 * @returns {string}
 */
export function breadcrumb(picks) {
  return (picks ?? [])
    .map((name) => humanize(name))
    .filter(Boolean)
    .join(BREADCRUMB_SEPARATOR);
}

/** @param {number} ms @returns {string} */
export function formatEndToEnd(ms) {
  return `${Math.round(ms)} ms end to end`;
}

/** @param {number} n @returns {string} */
export function formatInferenceCount(n) {
  return `${n} inference${n === 1 ? "" : "s"}`;
}

/** The `unplaced` headline. Plain, and deliberately not an apology. */
export const UNPLACED_TITLE = "Couldn't place this";

/** The `error` headline: the run broke, which is a different thing from declining. */
export const ERROR_TITLE = "Run failed";

/**
 * The backend's four `reason` codes, in the language an audience can follow.
 *
 * Each one says what the *model* did, because that is the honest reading: the tree
 * offered a set of options and the answer was not one of them. Keyed by the exact
 * `StopReason` literals in `callcompass/traversal.py`.
 */
export const STOP_REASONS = {
  none_of_these: "the model heard none of these options in the recording",
  empty_response: "the model returned no answer for this question",
  unknown_tool: "the model named an option this question does not offer",
  depth_limit: "the traversal hit its step limit before reaching an outcome",
};

/**
 * Why the traversal stopped, as a sentence naming the node it stopped on.
 *
 * An unrecognized code still produces a readable line rather than `undefined`: a new
 * backend reason must not blank out the only explanation on screen.
 *
 * @param {string} reason the `unplaced` event's `reason`
 * @param {string} label the node's label
 * @returns {string}
 */
export function reasonText(reason, label) {
  const why = STOP_REASONS[reason] ?? `the traversal stopped here (${reason})`;
  return `Stopped at “${label}”: ${why}.`;
}

/**
 * The outcome strip.
 *
 * `clear()` is the absent state; `completed()` / `unplaced()` / `errored()` are the
 * only things that draw a line, so an in-flight run leaves the strip exactly as it
 * was. All three are built from the same spans — the accent comes from the
 * container's `data-state`, not from a different structure.
 */
export class OutcomeStrip {
  /** @param {HTMLElement} container the strip's slot in the dock */
  constructor(container) {
    this.container = container;
  }

  /** @param {string} name @param {string} className @param {string} [text] */
  create(name, className, text) {
    const el = this.container.ownerDocument.createElement(name);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  /** Back to "nothing has run yet": no line at all, not an empty placeholder box. */
  clear() {
    delete this.container.dataset.state;
    this.container.replaceChildren();
  }

  /** Draws `parts` as one line under `state`. @param {string} state @param {HTMLElement[]} parts */
  show(state, parts) {
    this.container.dataset.state = state;
    const line = this.create("p", "outcome-line");
    line.append(...parts);
    this.container.replaceChildren(line);
    return line;
  }

  /**
   * Draws the outcome for a `completed` run: the leaf reached, the breadcrumb, how
   * many inferences it took, and the end-to-end latency.
   *
   * @param {{label: string, inference_count: number, total_latency_ms: number}} data
   *   the `completed` event payload
   * @param {string[]} picks each step's `tool_called`, for the breadcrumb
   */
  completed(data, picks = []) {
    const parts = [this.create("span", "outcome-label", data.label)];
    const path = breadcrumb(picks);
    if (path) parts.push(this.create("span", "outcome-path", path));
    parts.push(
      this.create("span", "outcome-count mono", formatInferenceCount(data.inference_count)),
    );
    parts.push(
      this.create("span", "outcome-latency mono", formatEndToEnd(data.total_latency_ms)),
    );
    return this.show("completed", parts);
  }

  /**
   * Draws the "couldn't place this" line for an `unplaced` run.
   *
   * Deliberately carries **no** outcome label — the model declined, and inventing a
   * next-best answer here is exactly the dishonesty this state exists to avoid. The
   * breadcrumb is still shown when some nodes did resolve, because how far the
   * traversal got is the useful part.
   *
   * @param {{stopped_at_label: string, reason: string, total_latency_ms: number}} data
   *   the `unplaced` event payload
   * @param {string[]} picks each step's `tool_called`, for the breadcrumb
   */
  unplaced(data, picks = []) {
    const parts = [
      this.create("span", "outcome-label", UNPLACED_TITLE),
      this.create("span", "outcome-reason", reasonText(data.reason, data.stopped_at_label)),
    ];
    const path = breadcrumb(picks);
    if (path) parts.push(this.create("span", "outcome-path", path));
    parts.push(
      this.create("span", "outcome-latency mono", formatEndToEnd(data.total_latency_ms)),
    );
    return this.show("unplaced", parts);
  }

  /**
   * Draws the line for an `error` event.
   *
   * An `error` is a *finished* run — the backend always sends `done` after it — so this
   * is a readable end state, not a spinner left turning. The message already names the
   * node that failed. No end-to-end figure: an `error` event carries no total.
   *
   * @param {{message: string}} data the `error` event payload
   */
  errored(data) {
    return this.show("error", [
      this.create("span", "outcome-label", ERROR_TITLE),
      this.create("span", "outcome-reason", data.message),
    ]);
  }
}
