// The result area: the recommendation card drawn after the terminal event.
//
// The card is the one place on screen that speaks plain language rather than tool
// names, so it is the agent's actual answer: what to say next, how the model got
// there, and how long the whole round trip took.
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

/**
 * The recommendation card.
 *
 * `clear()` is the empty state and `completed(data, picks)` is the only thing that
 * draws a card, so an in-flight run leaves the area exactly as it was.
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
   * Draws the recommendation for a `completed` run.
   *
   * @param {{label: string, recommendation: string, rationale?: string|null,
   *          total_latency_ms: number}} data the `completed` event payload
   * @param {string[]} picks each step's `tool_called`, for the breadcrumb
   */
  completed(data, picks = []) {
    const card = this.create("article", "result-card");
    const header = this.create("header", "result-head", data.label);
    header.append(
      this.create("span", "result-latency mono", formatEndToEnd(data.total_latency_ms)),
    );
    card.append(header, this.create("p", "result-recommendation", data.recommendation));

    const path = breadcrumb(picks);
    if (path) card.append(this.create("p", "result-path", path));
    // The rationale is the "why", in smaller text: useful on a projector, but it must
    // not compete with the line the agent is supposed to say.
    if (data.rationale) card.append(this.create("p", "result-rationale", data.rationale));

    this.container.dataset.state = "completed";
    this.container.replaceChildren(card);
    return card;
  }
}
