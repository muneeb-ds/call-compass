// The stage's camera: where the SVG's viewBox points, and how it gets there.
//
// `frameFor` is pure — it only reads a `layoutTree` result and a node id and returns
// the viewBox that centres that node, so it is node-testable the same way `layoutTree`
// itself is (see backend/tests/test_frontend_viewport.py). It never recomputes geometry
// that `layoutTree` already derived from the graph, and it never reads a node's
// documentary `level` field — depth comes from the layout, same as `tree.js`'s own rule.
//
// `Viewport` is the drawing half: it owns the <svg>'s `viewBox` attribute and animates
// toward a target frame, cancelling whatever animation was already in flight. It never
// computes a frame itself — callers (app.js) decide *what* to look at; `Viewport` only
// knows *how* to get the camera there.

import { NODE_HEIGHT } from "./tree.js";

const DURATION_MS = 220;
/** Vertical breathing room above/below the visible rows, in layout units. */
const MARGIN = NODE_HEIGHT;

/** Cubic ease-out: fast start, settling softly into the target. */
function easeOut(t) {
  return 1 - (1 - t) ** 3;
}

/**
 * The smallest axis-aligned box with the given aspect ratio that still covers a
 * `contentWidth` x `contentHeight` area, centred at `(centerX, centerY)`.
 *
 * @param {number} centerX @param {number} centerY
 * @param {number} contentWidth @param {number} contentHeight
 * @param {number} aspect width / height of the viewport the box will be shown in
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function fitAspect(centerX, centerY, contentWidth, contentHeight, aspect) {
  let width = contentHeight * aspect;
  let height = contentHeight;
  if (width < contentWidth) {
    width = contentWidth;
    height = contentWidth / aspect;
  }
  return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}

/** Frames the whole tree, letterboxed to `aspect` rather than cropped. */
function frameWholeTree(layout, aspect) {
  return fitAspect(layout.width / 2, layout.height / 2, layout.width, layout.height, aspect);
}

/**
 * The viewBox that centres `nodeId` with its immediate parent row and child row
 * visible, or the whole tree if that framing would already be no smaller than it.
 *
 * @param {ReturnType<typeof import("./tree.js").layoutTree>} layout
 * @param {string} nodeId
 * @param {number} aspect width / height of the viewport the box will be shown in
 * @param {number} [zoom] >1 zooms in, <1 zooms out; 1 is the default framing
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function frameFor(layout, nodeId, aspect, zoom = 1) {
  const node = layout.nodes.find((n) => n.id === nodeId);
  if (!node) return frameWholeTree(layout, aspect);

  const rowTop = new Map();
  for (const n of layout.nodes) {
    if (!rowTop.has(n.level)) rowTop.set(n.level, n.y);
  }
  const lo = Math.max(0, node.level - 1);
  const hi = Math.min(layout.levels - 1, node.level + 1);
  const top = rowTop.get(lo);
  const bottom = rowTop.get(hi) + NODE_HEIGHT;

  const centerX = node.x + node.width / 2;
  const centerY = (top + bottom) / 2;
  const contentHeight = (bottom - top + MARGIN * 2) / zoom;

  const frame = fitAspect(centerX, centerY, 0, contentHeight, aspect);
  if (frame.width >= layout.width && frame.height >= layout.height) {
    return frameWholeTree(layout, aspect);
  }
  return frame;
}

/** @param {{x,y,width,height}} from @param {{x,y,width,height}} to @param {number} t */
function lerpBox(from, to, t) {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    width: from.width + (to.width - from.width) * t,
    height: from.height + (to.height - from.height) * t,
  };
}

/** @param {SVGSVGElement} svg @returns {{x,y,width,height}|null} */
function readViewBox(svg) {
  const attr = svg.getAttribute && svg.getAttribute("viewBox");
  if (!attr) return null;
  const [x, y, width, height] = attr.trim().split(/\s+/).map(Number);
  if ([x, y, width, height].some((n) => Number.isNaN(n))) return null;
  return { x, y, width, height };
}

/**
 * Owns the stage `<svg>`'s `viewBox` and animates it toward whatever frame it is told
 * to go to, over ~220 ms with an ease-out curve. The viewBox is animated rather than a
 * CSS transform on the SVG, so stroke widths and node detail text stay at constant
 * screen size throughout the pan.
 *
 * Takes the `<svg>` as a constructor argument and the animation primitives as
 * injectable dependencies, so a node test can drive it without a real browser — the
 * same split `waveform.js`/`tree.js` already use.
 */
export class Viewport {
  /**
   * @param {SVGSVGElement} svg
   * @param {{raf?: (cb: (t: number) => void) => number, caf?: (id: number) => void,
   *          now?: () => number, reducedMotion?: () => boolean}} [deps]
   */
  constructor(svg, deps = {}) {
    this.svg = svg;
    this.raf = deps.raf ?? ((cb) => requestAnimationFrame(cb));
    this.caf = deps.caf ?? ((id) => cancelAnimationFrame(id));
    this.now = deps.now ?? (() => performance.now());
    this.reducedMotion =
      deps.reducedMotion ??
      (() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    /** @type {{x,y,width,height}|null} the box last written, so a new target can lerp from it */
    this.box = null;
    this.frameId = null;
  }

  /** Writes the viewBox attribute and records it as the current box. @param {{x,y,width,height}} box */
  setBox(box) {
    this.box = box;
    this.svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
  }

  /**
   * Animates toward `target`, cancelling any animation already in flight. Jumps
   * straight there under `prefers-reduced-motion: reduce`.
   *
   * @param {{x: number, y: number, width: number, height: number}} target
   */
  goTo(target) {
    if (this.frameId !== null) {
      this.caf(this.frameId);
      this.frameId = null;
    }
    const from = this.box ?? readViewBox(this.svg);
    if (!from || this.reducedMotion()) {
      this.setBox(target);
      return;
    }
    const start = this.now();
    const tick = () => {
      const t = Math.min(1, (this.now() - start) / DURATION_MS);
      this.setBox(lerpBox(from, target, easeOut(t)));
      this.frameId = t < 1 ? this.raf(tick) : null;
    };
    this.frameId = this.raf(tick);
  }
}
