// The status bar's position readout: a plain-language statement of how far into the
// tree the model has reached, so the visual position (US-007's active-node state,
// US-008/009's camera) has a number attached to it.
//
// Depth and the tree's maximum depth come from the same `layoutTree` result
// `viewport.js` already reads — never a second depth calculation and never the
// config's documentary `level` field.
//
// `formatPosition` is pure and is what `test_frontend_position.py` pins.
// `PositionReadout` takes its element as a constructor argument and never touches
// `document`, same split as every other drawing half in this directory.

/**
 * @param {{label: string, depth: number, maxDepth: number, inferenceCount?: number|null}} info
 * @returns {string}
 */
export function formatPosition({ label, depth, maxDepth, inferenceCount = null }) {
  const base = `${label} · Depth ${depth} of ${maxDepth}`;
  return inferenceCount == null ? base : `${base} · inference ${inferenceCount}`;
}

/**
 * Writes the readout into `el`, expected to sit inside an `aria-live="polite"` region
 * so it is announced as the run advances.
 */
export class PositionReadout {
  /** @param {HTMLElement} el */
  constructor(el) {
    this.el = el;
    /** @type {{nodes: Array<{id: string, level: number, label: string}>, levels: number}|null} */
    this.layout = null;
    /** How many inferences have started so far in the current run. */
    this.inferenceCount = 0;
    /** True once a terminal/error event has frozen the readout for this run. */
    this.done = false;
  }

  /** @param {string} id @returns {{label: string, depth: number}} */
  locate(id) {
    const node = this.layout && this.layout.nodes.find((n) => n.id === id);
    return node ? { label: node.label, depth: node.level + 1 } : { label: id, depth: 1 };
  }

  /** @param {string} id @param {number|null} inferenceCount */
  show(id, inferenceCount) {
    if (!this.layout) return;
    const { label, depth } = this.locate(id);
    this.el.textContent = formatPosition({
      label,
      depth,
      maxDepth: this.layout.levels,
      inferenceCount,
    });
  }

  /**
   * Attaches the tree's layout and shows the pre-run statement: the root label at
   * `Depth 1 of T`, with no inference count.
   *
   * @param {{nodes: Array<object>, levels: number}} layout
   * @param {string} rootId
   */
  setLayout(layout, rootId) {
    this.layout = layout;
    this.done = false;
    this.inferenceCount = 0;
    this.show(rootId, null);
  }

  /** Called on every frontier move (`Analysis.onActivate`) while a run is in flight. */
  activate(id) {
    if (this.done) return;
    this.inferenceCount += 1;
    this.show(id, this.inferenceCount);
  }

  /**
   * Freezes the readout on the node the run ended on, with the authoritative inference
   * count if the terminal event carried one.
   *
   * @param {string} id
   * @param {number} [inferenceCount]
   */
  finish(id, inferenceCount = this.inferenceCount) {
    this.done = true;
    this.show(id, inferenceCount);
  }

  /** Back to the pre-run root statement for a new run. */
  reset(rootId) {
    if (rootId) this.setLayout(this.layout, rootId);
  }
}
