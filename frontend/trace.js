// The Trace column: one card per inference, appended as each `step` event arrives.
//
// The formatting half (`humanize`, `formatArguments`, `formatTotal`) is pure and is
// shared with the tree annotations and, later, the result card's breadcrumb — the
// option a step picked is named the same way everywhere on screen.
//
// `Trace` takes its two DOM elements as arguments and never touches `document`, which
// is what lets the Python suite drive it under node with stub elements.

/** Shown before the first step, so the column does not change shape mid-run. */
export const EMPTY_TOTAL = "Total: —";

/**
 * A snake_case tool or option name as a readable label.
 *
 * The tree config gives options a `tool_name` and a long `description`, but no short
 * label, and the description is a sentence. The name reads better in a card header and
 * in the breadcrumb: `pricing_question` → `Pricing question`.
 *
 * @param {string} name
 * @returns {string}
 */
export function humanize(name) {
  const words = String(name ?? "")
    .split(/[_\s]+/)
    .filter(Boolean);
  if (!words.length) return "";
  const text = words.join(" ");
  return text[0].toUpperCase() + text.slice(1);
}

/**
 * A step's arguments as `name: value` lines, in the order the model returned them.
 *
 * @param {Record<string, unknown>} args
 * @returns {string[]}
 */
export function formatArguments(args) {
  return Object.entries(args ?? {}).map(([name, value]) => `${name}: ${value}`);
}

/** @param {number} ms @returns {string} */
export function formatLatency(ms) {
  return `${Math.round(ms)} ms`;
}

/** @param {number} ms @returns {string} */
export function formatTotal(ms) {
  return `Total: ${Math.round(ms)} ms`;
}

/**
 * The step-card list plus the running total pinned above it.
 *
 * The total accumulates each step's `latency_ms`, i.e. inference time only. The
 * terminal event's authoritative `total_inference_ms` replaces it at the end
 * (`setTotal`); end-to-end latency is the result card's number, not this one, so the
 * two are never confused on screen.
 */
export class Trace {
  /**
   * @param {HTMLElement} totalEl the pinned running total
   * @param {HTMLElement} listEl container the cards are appended to
   */
  constructor(totalEl, listEl) {
    this.totalEl = totalEl;
    this.listEl = listEl;
    this.totalMs = 0;
    this.count = 0;
    /** Whether a figure has been reported at all — a run can end with zero steps. */
    this.hasTotal = false;
  }

  /** Back to the empty state: no cards, no total. */
  reset() {
    this.totalMs = 0;
    this.count = 0;
    this.hasTotal = false;
    this.listEl.replaceChildren();
    this.renderTotal();
  }

  /** @param {string} name @param {string} className @param {string} [text] */
  create(name, className, text) {
    const el = this.listEl.ownerDocument.createElement(name);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  /**
   * Appends one step's card and advances the running total.
   *
   * @param {{node_label: string, tool_called: string, arguments: Record<string, unknown>,
   *          latency_ms: number}} step a `step` event payload
   */
  addStep(step) {
    this.totalMs += step.latency_ms;
    this.count += 1;
    this.hasTotal = true;

    const card = this.create("article", "step");
    card.dataset.index = String(this.count - 1);
    const header = this.create("header", "step-node", step.node_label);
    header.append(this.create("span", "step-latency mono", formatLatency(step.latency_ms)));
    card.append(header, this.create("p", "step-option", humanize(step.tool_called)));
    for (const line of formatArguments(step.arguments)) {
      card.append(this.create("p", "step-arg mono", line));
    }
    this.listEl.append(card);
    // Keeps the newest card in view once a run outgrows the column.
    if (card.scrollIntoView) card.scrollIntoView({ block: "nearest" });
    this.renderTotal();
    return card;
  }

  /**
   * Replaces the accumulated total with an authoritative figure.
   *
   * A run can end with no steps at all (the model declines at the root), and that run
   * still spent inference time, so this is what shows the total rather than `addStep`.
   *
   * @param {number} ms
   */
  setTotal(ms) {
    this.totalMs = ms;
    this.hasTotal = true;
    this.renderTotal();
  }

  renderTotal() {
    this.totalEl.textContent = this.hasTotal ? formatTotal(this.totalMs) : EMPTY_TOTAL;
  }
}
