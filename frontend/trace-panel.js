// The collapsed trace rail and the slide-over panel it opens.
//
// `trace.js`'s public API is frozen by this story: the panel is a styled wrapper
// around the exact elements `Trace` already renders into (`trace-total`/`trace-list`),
// and the rail is a sibling view that reads the same per-step data `Analysis.onStep`
// hands out — not a rewrite of `Trace` and not a reader of its DOM. `TraceRail`
// therefore accumulates its own running total exactly the way `Trace` does, from the
// same `latency_ms` figures, rather than scraping `Trace`'s rendered text.
//
// Both classes take their elements as constructor arguments and never touch
// `document` directly, so the node harness can drive them with stub elements.

import { EMPTY_TOTAL, formatLatency, formatTotal } from "./trace.js";

/**
 * The collapsed-state rail: one compact chip per step, plus the running total.
 */
export class TraceRail {
  /**
   * @param {HTMLElement} listEl the chip container
   * @param {HTMLElement} totalEl the pinned total chip
   * @param {{onSelect?: (index: number) => void}} [hooks] `onSelect` fires when a
   *   chip is clicked, with the step's arrival index — the panel opens and scrolls
   *   to that step.
   */
  constructor(listEl, totalEl, hooks = {}) {
    this.listEl = listEl;
    this.totalEl = totalEl;
    this.onSelect = hooks.onSelect ?? null;
    this.totalMs = 0;
    this.hasTotal = false;
  }

  /** Back to no chips, no total — mirrors `Trace.reset()`. */
  reset() {
    this.totalMs = 0;
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
   * Appends one chip and advances the running total.
   *
   * @param {{latency_ms: number}} step the same `step` payload `Trace.addStep` got
   * @param {number} index the step's arrival order, 0-based
   */
  addStep(step, index) {
    this.totalMs += step.latency_ms;
    this.hasTotal = true;

    const chip = this.create("button", "trace-chip");
    chip.setAttribute("type", "button");
    chip.dataset.index = String(index);
    chip.append(this.create("span", "trace-chip-index", String(index + 1)));
    chip.append(this.create("span", "trace-chip-latency mono", formatLatency(step.latency_ms)));
    chip.addEventListener("click", () => {
      if (this.onSelect) this.onSelect(index);
    });
    this.listEl.append(chip);
    this.renderTotal();
    return chip;
  }

  /** Replaces the accumulated total with an authoritative figure. @param {number} ms */
  setTotal(ms) {
    this.totalMs = ms;
    this.hasTotal = true;
    this.renderTotal();
  }

  renderTotal() {
    this.totalEl.textContent = this.hasTotal ? formatTotal(this.totalMs) : EMPTY_TOTAL;
  }
}

/**
 * The slide-over panel and its toggle.
 *
 * Open/closed is a viewer preference, not run state: nothing here is ever touched by
 * `Analysis.reset()` or `resetAll`, which is what lets it survive a run and a reset.
 */
export class TracePanel {
  /**
   * @param {HTMLElement} panelEl carries `data-state="collapsed"|"open"`
   * @param {HTMLElement} toggleEl the labelled button; gets `aria-expanded`
   * @param {{doc?: {addEventListener: Function}}} [options] `doc` is where the
   *   `Escape` listener attaches — optional so a node test without a `document` can
   *   still exercise open/close/toggle.
   */
  constructor(panelEl, toggleEl, options = {}) {
    this.panelEl = panelEl;
    this.toggleEl = toggleEl;
    this.isOpen = false;
    toggleEl.addEventListener("click", () => this.toggle());
    if (options.doc) {
      options.doc.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && this.isOpen) this.close();
      });
    }
    this.render();
  }

  render() {
    this.panelEl.dataset.state = this.isOpen ? "open" : "collapsed";
    this.toggleEl.setAttribute("aria-expanded", String(this.isOpen));
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.render();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.render();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }
}
