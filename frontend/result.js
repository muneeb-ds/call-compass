// The result area: the one card drawn after the terminal event.
//
// The card is the one place on screen that speaks plain language rather than tool
// names, so it is the agent's actual answer: what to say next, how the model got
// there, and how long the whole round trip took.
//
// There are three terminal looks and the slot's `data-state` names which one is up:
// `completed` (green, a recommendation), `unplaced` (amber, "Couldn't place this"),
// and `error` (red, the run broke). The last two carry **no** recommendation text —
// the demo has to be as readable when the model declines as when it answers.
//
// It renders only from a terminal event — never mid-traversal — so the operator can
// never read a half-finished path as a recommendation.
//
// `ResultCard` takes its container as an argument and never touches `document`, which
// is how the Python suite drives it under node over the bytes the real backend
// produced.

import { humanize } from "./trace.js";

/** Shown before any run, so the result area does not change shape mid-demo. */
export const EMPTY_TEXT = "The recommendation appears here once a run finishes.";

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
  depth_limit: "the traversal hit its step limit before reaching a recommendation",
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
 * The result card.
 *
 * `clear()` is the empty state; `completed()` / `unplaced()` / `errored()` are the
 * only things that draw a card, so an in-flight run leaves the area exactly as it
 * was. All three share one markup shape — the accent colour comes from the slot's
 * `data-state`, not from a different structure — so there is one card to read.
 */
export class ResultCard {
  /** @param {HTMLElement} container the result area's slot */
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

  /** Back to the "nothing has run yet" state. */
  clear() {
    this.container.dataset.state = "empty";
    this.container.replaceChildren(this.create("p", "result-empty", EMPTY_TEXT));
  }

  /**
   * One card with its header, and the latency badge when the payload carries one.
   *
   * @param {string} title the header text
   * @param {number} [latencyMs] the terminal event's `total_latency_ms`
   */
  card(title, latencyMs) {
    const card = this.create("article", "result-card");
    const header = this.create("header", "result-head", title);
    if (typeof latencyMs === "number") {
      header.append(this.create("span", "result-latency mono", formatEndToEnd(latencyMs)));
    }
    card.append(header);
    return card;
  }

  /** Puts `card` on screen under `state`. @param {string} state */
  show(state, card) {
    this.container.dataset.state = state;
    this.container.replaceChildren(card);
    return card;
  }

  /**
   * Draws the recommendation for a `completed` run.
   *
   * @param {{label: string, recommendation: string, rationale?: string|null,
   *          total_latency_ms: number}} data the `completed` event payload
   * @param {string[]} picks each step's `tool_called`, for the breadcrumb
   */
  completed(data, picks = []) {
    const card = this.card(data.label, data.total_latency_ms);
    card.append(this.create("p", "result-recommendation", data.recommendation));

    const path = breadcrumb(picks);
    if (path) card.append(this.create("p", "result-path", path));
    // The rationale is the "why", in smaller text: useful on a projector, but it must
    // not compete with the line the agent is supposed to say.
    if (data.rationale) card.append(this.create("p", "result-rationale", data.rationale));

    return this.show("completed", card);
  }

  /**
   * Draws the "couldn't place this" card for an `unplaced` run.
   *
   * Deliberately carries **no** recommendation line: the model declined, and inventing
   * a next-best answer here is exactly the dishonesty this state exists to avoid. The
   * breadcrumb is still shown when some nodes did resolve, because how far the
   * traversal got is the useful part.
   *
   * @param {{stopped_at_label: string, reason: string, total_latency_ms: number}} data
   *   the `unplaced` event payload
   * @param {string[]} picks each step's `tool_called`, for the breadcrumb
   */
  unplaced(data, picks = []) {
    const card = this.card(UNPLACED_TITLE, data.total_latency_ms);
    card.append(
      this.create("p", "result-reason", reasonText(data.reason, data.stopped_at_label)),
    );

    const path = breadcrumb(picks);
    if (path) card.append(this.create("p", "result-path", path));

    return this.show("unplaced", card);
  }

  /**
   * Draws the card for an `error` event.
   *
   * An `error` is a *finished* run — the backend always sends `done` after it — so this
   * is a readable end state, not a spinner left turning. The message already names the
   * node that failed.
   *
   * @param {{message: string}} data the `error` event payload
   */
  errored(data) {
    const card = this.card(ERROR_TITLE);
    card.append(this.create("p", "result-reason", data.message));
    return this.show("error", card);
  }
}
