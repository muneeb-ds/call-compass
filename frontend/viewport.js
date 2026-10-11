// The stage's camera: where the SVG's viewBox points, and how it gets there.
//
// `frameFor` is pure — it only reads a `layoutTree` result and a node id and returns
// the viewBox that centres that node, so it is node-testable the same way `layoutTree`
// itself is (see backend/tests/test_frontend_viewport.py). It never recomputes geometry
// that `layoutTree` already derived from the graph, and it never reads a node's
// documentary `level` field — depth comes from the layout, same as `tree.js`'s own rule.
// `panBox` and `zoomBox` are the same kind of pure maths for manual pan/zoom — they take
// and return a plain `{x, y, width, height}` box, no DOM, so they are node-testable too.
//
// `Viewport` is the drawing half: it owns the <svg>'s `viewBox` attribute and animates
// toward a target frame, cancelling whatever animation was already in flight. It never
// computes a frame itself — callers (app.js) decide *what* to look at; `Viewport` only
// knows *how* to get the camera there. `autoGoTo` is the auto-follow entry point and
// respects `this.following`; manual pan/drag/zoom/Fit always disable it, and `follow()`
// (or the next run, or a reset) re-arms it — see `enableManualControls`.

import { NODE_HEIGHT } from "./tree.js";

const DURATION_MS = 220;
/** Vertical breathing room above/below the visible rows, in layout units. */
const MARGIN = NODE_HEIGHT;
/** Tightest manual zoom-in, as a fraction of the whole-tree-fit frame's size. */
const MIN_ZOOM_RATIO = 1 / 6;

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

/**
 * Translates a viewBox by `(dx, dy)`, in the box's own units. Pure — no clamping to
 * the tree's bounds, same as `frameFor`'s edge nodes: panning off the drawn tree is
 * left legal, it is only zoom that gets clamped to "sane bounds".
 *
 * @param {{x: number, y: number, width: number, height: number}} box
 * @param {number} dx @param {number} dy
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function panBox(box, dx, dy) {
  return { x: box.x + dx, y: box.y + dy, width: box.width, height: box.height };
}

/**
 * The sane bounds a manual zoom should be clamped to, derived from the whole-tree
 * frame rather than any fixed pixel constant — so the bound scales with whatever tree
 * is loaded. Zooming out can never go past the whole tree already fitting (that is
 * what "Fit" gives you for free); zooming in is capped at `MIN_ZOOM_RATIO` of that.
 *
 * @param {{width: number, height: number}} wholeTreeFrame
 * @returns {{minWidth: number, minHeight: number, maxWidth: number, maxHeight: number}}
 */
export function zoomBounds(wholeTreeFrame) {
  return {
    minWidth: wholeTreeFrame.width * MIN_ZOOM_RATIO,
    minHeight: wholeTreeFrame.height * MIN_ZOOM_RATIO,
    maxWidth: wholeTreeFrame.width,
    maxHeight: wholeTreeFrame.height,
  };
}

/**
 * Zooms a viewBox by `factor` (>1 zooms in, <1 zooms out) around the point
 * `(anchorX, anchorY)` — expressed in the box's own units — keeping that point at the
 * same fractional position within the box, so a wheel/pinch zoom stays anchored under
 * the cursor rather than recentring. Clamped to `bounds` (see `zoomBounds`) so the
 * result can neither invert nor shrink to a dot.
 *
 * @param {{x: number, y: number, width: number, height: number}} box
 * @param {number} factor
 * @param {number} anchorX @param {number} anchorY
 * @param {{minWidth: number, minHeight: number, maxWidth: number, maxHeight: number}} [bounds]
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function zoomBox(box, factor, anchorX, anchorY, bounds) {
  let width = box.width / factor;
  let height = box.height / factor;
  if (bounds) {
    width = Math.min(bounds.maxWidth, Math.max(bounds.minWidth, width));
    height = Math.min(bounds.maxHeight, Math.max(bounds.minHeight, height));
  }
  const fx = box.width > 0 ? (anchorX - box.x) / box.width : 0.5;
  const fy = box.height > 0 ? (anchorY - box.y) / box.height : 0.5;
  return { x: anchorX - fx * width, y: anchorY - fy * height, width, height };
}

/**
 * True when focus sits in a field that should swallow its own keystrokes — the +/-
 * zoom shortcuts must not fire while the user is typing.
 *
 * @param {Document} doc
 */
function isTextInputFocused(doc) {
  const el = doc && doc.activeElement;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
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
    /** @type {ReturnType<typeof import("./tree.js").layoutTree>|null} set via `setLayout` */
    this.layout = null;
    /** @type {boolean} false once a manual pan/zoom/Fit has happened, until `follow()` or a reset */
    this.following = true;
    /** @type {{x: number, y: number, width: number, height: number}|null} what auto-follow last asked for */
    this.lastAutoTarget = null;
    /** @type {HTMLButtonElement|null} set by `enableManualControls`, kept in sync with `following` */
    this.followButton = null;
  }

  /** @param {ReturnType<typeof import("./tree.js").layoutTree>} layout */
  setLayout(layout) {
    this.layout = layout;
  }

  /** The SVG's own rendered aspect ratio, falling back to 16:9 before it has a size. */
  aspect() {
    const rect = this.svg.getBoundingClientRect && this.svg.getBoundingClientRect();
    return rect && rect.height > 0 ? rect.width / rect.height : 16 / 9;
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

  /**
   * The auto-follow entry point: always remembers where the frontier currently is,
   * but only actually moves the camera while `following` is true. This is what lets
   * `follow()` jump straight back to the frontier without needing a second copy of
   * "where it currently is" tracked outside this class.
   *
   * @param {{x: number, y: number, width: number, height: number}} target
   */
  autoGoTo(target) {
    this.lastAutoTarget = target;
    if (this.following) this.goTo(target);
  }

  /** A manual pan, zoom, or Fit happened: auto-follow stops until `follow()` or a reset. */
  disableFollow() {
    if (!this.following) return;
    this.following = false;
    if (this.followButton) this.followButton.disabled = false;
  }

  /** Re-arms auto-follow and jumps straight back to the frontier, if a run is in flight. */
  follow() {
    this.following = true;
    if (this.followButton) this.followButton.disabled = true;
    if (this.lastAutoTarget) this.goTo(this.lastAutoTarget);
  }

  /** Frames the whole tree. A manual interaction, like pan and zoom, so it disables follow. */
  fit() {
    if (!this.layout) return;
    this.disableFollow();
    this.goTo(frameWholeTree(this.layout, this.aspect()));
  }

  /**
   * Pans by a client-pixel delta (a drag), immediately — no easing while the pointer
   * is still moving.
   *
   * @param {number} dxPx @param {number} dyPx
   */
  panByClientDelta(dxPx, dyPx) {
    const rect = this.svg.getBoundingClientRect && this.svg.getBoundingClientRect();
    const box = this.box ?? readViewBox(this.svg);
    if (!box || !rect || rect.width <= 0 || rect.height <= 0) return;
    this.disableFollow();
    this.setBox(panBox(box, -dxPx * (box.width / rect.width), -dyPx * (box.height / rect.height)));
  }

  /**
   * Zooms by `factor` (>1 zooms in) around a point given in client (screen) space,
   * immediately, clamped to the sane bounds derived from the whole tree.
   *
   * @param {number} factor @param {number} clientX @param {number} clientY
   */
  zoomAtClientPoint(factor, clientX, clientY) {
    const rect = this.svg.getBoundingClientRect && this.svg.getBoundingClientRect();
    const box = this.box ?? readViewBox(this.svg);
    if (!box || !rect || !this.layout || rect.width <= 0 || rect.height <= 0) return;
    const anchorX = box.x + ((clientX - rect.left) / rect.width) * box.width;
    const anchorY = box.y + ((clientY - rect.top) / rect.height) * box.height;
    const bounds = zoomBounds(frameWholeTree(this.layout, this.aspect()));
    this.disableFollow();
    this.setBox(zoomBox(box, factor, anchorX, anchorY, bounds));
  }

  /** Zooms by `factor` around the centre of the current view (the +/- keys). */
  zoomAtCenter(factor) {
    const rect = this.svg.getBoundingClientRect && this.svg.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    this.zoomAtClientPoint(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  /**
   * Wires drag-to-pan, wheel/pinch-to-zoom, the +/- keys, and the Follow/Fit buttons.
   * Elements are taken as arguments rather than looked up here, same convention as
   * every other module in this directory — `app.js` owns the lookups. This half is
   * DOM glue over the pure `panBox`/`zoomBox` above and is reviewed, not node-tested,
   * the same split `goTo`'s animation loop already has.
   *
   * @param {{followButton?: HTMLButtonElement|null, fitButton?: HTMLButtonElement|null,
   *          doc?: Document|null}} [controls]
   */
  enableManualControls({ followButton = null, fitButton = null, doc = null } = {}) {
    this.followButton = followButton;
    if (followButton) {
      followButton.disabled = true;
      followButton.addEventListener("click", () => this.follow());
    }
    if (fitButton) fitButton.addEventListener("click", () => this.fit());

    /** @type {Map<number, {x: number, y: number}>} live pointers, by pointerId */
    const pointers = new Map();
    let pinchDistance = null;

    const points = () => [...pointers.values()];
    const distance = ([a, b]) => Math.hypot(a.x - b.x, a.y - b.y);
    const midpoint = ([a, b]) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

    this.svg.addEventListener("pointerdown", (event) => {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.svg.setPointerCapture) this.svg.setPointerCapture(event.pointerId);
      if (pointers.size === 2) pinchDistance = distance(points());
    });

    this.svg.addEventListener("pointermove", (event) => {
      if (!pointers.has(event.pointerId)) return;
      const prev = pointers.get(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 2 && pinchDistance) {
        const dist = distance(points());
        const mid = midpoint(points());
        this.zoomAtClientPoint(dist / pinchDistance, mid.x, mid.y);
        pinchDistance = dist;
      } else if (pointers.size === 1) {
        this.panByClientDelta(event.clientX - prev.x, event.clientY - prev.y);
      }
    });

    const release = (event) => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinchDistance = null;
    };
    this.svg.addEventListener("pointerup", release);
    this.svg.addEventListener("pointercancel", release);

    this.svg.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.zoomAtClientPoint(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX, event.clientY);
      },
      { passive: false },
    );

    if (doc) {
      doc.addEventListener("keydown", (event) => {
        if (isTextInputFocused(doc)) return;
        if (event.key === "+" || event.key === "=") {
          this.zoomAtCenter(1.2);
          event.preventDefault();
        } else if (event.key === "-" || event.key === "_") {
          this.zoomAtCenter(1 / 1.2);
          event.preventDefault();
        }
      });
    }
  }
}
