// The decision tree, drawn from config/tree.json as served by GET /api/tree.
//
// Nothing here is hardcoded per tree: `layoutTree` derives every coordinate from the
// graph's own shape (depth and sibling index), which is what makes "re-point the demo
// by editing JSON only" true (PRD AC-10). Editing a label, adding an option, or adding
// a whole level changes the drawing with no code change.
//
// Depth is computed from the graph rather than read off each node's `level` field: the
// field is documentation, the edges are the truth, and an edge must always point down.
//
// `layoutTree` and `wrapLabel` are pure — no DOM, no fetch — so node can run them from
// the Python suite (backend/tests/test_frontend_tree.py). `TreeView` does the drawing
// and takes its <svg> as an argument, never touching `document` directly.

/** Geometry, in viewBox units. The SVG scales to its column, so these are relative. */
export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 58;
const COLUMN_GAP = 22;
const ROW_GAP = 70;
const PADDING = 14;
/** Roughly how many characters of the label fit on one line at NODE_WIDTH. */
const LINE_CHARS = 20;
const MAX_LINES = 3;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Stable identity for the edge between two nodes, shared with the highlight code. */
export function edgeKey(from, to) {
  return `${from}->${to}`;
}

/**
 * Greedy word wrap for a node label.
 *
 * Long single words are left to overflow rather than hyphenated: a clipped label is a
 * worse demo artifact than a slightly wide one.
 *
 * @param {string} label
 * @param {number} [chars] soft budget per line
 * @param {number} [maxLines]
 * @returns {string[]}
 */
export function wrapLabel(label, chars = LINE_CHARS, maxLines = MAX_LINES) {
  const lines = [];
  for (const word of String(label).trim().split(/\s+/).filter(Boolean)) {
    const last = lines.length - 1;
    if (lines.length && lines[last].length + 1 + word.length <= chars) {
      lines[last] = `${lines[last]} ${word}`;
    } else if (lines.length < maxLines) {
      lines.push(word);
    } else {
      lines[last] = `${lines[last]}…`;
      break;
    }
  }
  return lines.length ? lines : [""];
}

/**
 * Children of one node, in declaration order and de-duplicated.
 *
 * Two options at the same node can share a `next`, so the graph is a DAG rather than a
 * strict tree: the shared target is drawn once, with one edge per distinct parent.
 *
 * @param {object} node
 * @returns {string[]}
 */
function childIds(node) {
  if (node.type !== "branch") return [];
  const seen = [];
  for (const option of node.options) {
    if (!seen.includes(option.next)) seen.push(option.next);
  }
  return seen;
}

/**
 * Longest distance from the root to each node, so a node with several parents still
 * sits below all of them. The loader guarantees the graph is acyclic.
 *
 * @param {object} tree
 * @returns {Map<string, number>}
 */
function depths(tree) {
  const depth = new Map();
  const walk = (id, level) => {
    if (depth.has(id) && depth.get(id) >= level) return;
    depth.set(id, level);
    for (const child of childIds(tree.nodes[id])) walk(child, level + 1);
  };
  walk(tree.root, 0);
  return depth;
}

/**
 * Turns a tree config into positioned nodes and edges.
 *
 * Levels run top to bottom; within a level, nodes are ordered by when a breadth-first
 * walk from the root first reaches them, so siblings stay next to each other and the
 * edges don't cross more than the graph itself forces.
 *
 * @param {object} tree the GET /api/tree payload
 * @returns {{width: number, height: number, levels: number,
 *            nodes: Array<object>, edges: Array<object>}}
 */
export function layoutTree(tree) {
  const depth = depths(tree);
  // Breadth-first discovery order fixes the sibling index; sorting by depth keeps
  // each node in its own row even when it was reached early by a short path.
  const order = [];
  for (const queue = [tree.root]; queue.length; ) {
    const id = queue.shift();
    if (order.includes(id)) continue;
    order.push(id);
    queue.push(...childIds(tree.nodes[id]));
  }
  const rows = [];
  for (const id of order) {
    const level = depth.get(id);
    (rows[level] ??= []).push(id);
  }

  const widest = Math.max(...rows.map((row) => row.length));
  const content = widest * NODE_WIDTH + (widest - 1) * COLUMN_GAP;
  const width = content + PADDING * 2;
  const height = rows.length * NODE_HEIGHT + (rows.length - 1) * ROW_GAP + PADDING * 2;

  const nodes = [];
  const placed = new Map();
  rows.forEach((row, level) => {
    const slot = content / row.length;
    row.forEach((id, index) => {
      const node = tree.nodes[id];
      const x = PADDING + slot * (index + 0.5) - NODE_WIDTH / 2;
      const y = PADDING + level * (NODE_HEIGHT + ROW_GAP);
      const laid = {
        id,
        label: node.label,
        lines: wrapLabel(node.label),
        leaf: node.type === "leaf",
        level,
        index,
        x,
        y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      };
      nodes.push(laid);
      placed.set(id, laid);
    });
  });

  const edges = [];
  for (const parent of nodes) {
    const node = tree.nodes[parent.id];
    if (node.type !== "branch") continue;
    for (const child of childIds(node)) {
      const target = placed.get(child);
      // One edge per node pair; the options that share it are kept so a later story
      // can name the option that lit it.
      edges.push({
        key: edgeKey(parent.id, child),
        from: parent.id,
        to: child,
        options: node.options.filter((o) => o.next === child).map((o) => o.tool_name),
        x1: parent.x + parent.width / 2,
        y1: parent.y + parent.height,
        x2: target.x + target.width / 2,
        y2: target.y,
      });
    }
  }

  return { width, height, levels: rows.length, nodes, edges };
}

/** Vertical cubic bezier, so edges leave and arrive straight down. */
function edgePath(edge) {
  const bend = Math.max(18, (edge.y2 - edge.y1) / 2);
  return `M ${edge.x1} ${edge.y1} C ${edge.x1} ${edge.y1 + bend}, ${edge.x2} ${
    edge.y2 - bend
  }, ${edge.x2} ${edge.y2}`;
}

/**
 * Draws one tree into an inline <svg> and hands back handles on its parts.
 *
 * Every node and edge starts in the dimmed `data-state="idle"` ("not visited") state;
 * the live highlighting in a later story only flips `data-state`, so the look lives
 * entirely in styles.css.
 */
export class TreeView {
  /** @param {SVGSVGElement} svg */
  constructor(svg) {
    this.svg = svg;
    /** @type {ReturnType<typeof layoutTree>|null} */
    this.layout = null;
    /** @type {Map<string, SVGGElement>} */
    this.nodeEls = new Map();
    /** @type {Map<string, SVGPathElement>} */
    this.edgeEls = new Map();
  }

  /** @param {string} name @param {Record<string, string|number>} attrs */
  create(name, attrs = {}) {
    const el = this.svg.ownerDocument.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    return el;
  }

  /**
   * Replaces the drawing with one computed from `tree`.
   *
   * @param {object} tree the GET /api/tree payload
   */
  render(tree) {
    const layout = layoutTree(tree);
    this.layout = layout;
    this.nodeEls.clear();
    this.edgeEls.clear();
    this.svg.replaceChildren();
    this.svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
    this.svg.setAttribute("role", "img");
    this.svg.setAttribute("aria-label", `Decision tree ${tree.tree_id}`);

    // Edges first so they pass behind the node boxes.
    const edgeLayer = this.create("g", { class: "tree-edges", fill: "none" });
    for (const edge of layout.edges) {
      const path = this.create("path", { class: "tree-edge", d: edgePath(edge) });
      path.dataset.state = "idle";
      path.dataset.from = edge.from;
      path.dataset.to = edge.to;
      edgeLayer.append(path);
      this.edgeEls.set(edge.key, path);
    }
    this.svg.append(edgeLayer);

    const nodeLayer = this.create("g", { class: "tree-nodes" });
    for (const node of layout.nodes) {
      nodeLayer.append(this.renderNode(node));
    }
    this.svg.append(nodeLayer);
    return layout;
  }

  /** @param {object} node one entry from the layout */
  renderNode(node) {
    const group = this.create("g", { class: "tree-node" });
    group.dataset.state = "idle";
    group.dataset.nodeId = node.id;
    group.dataset.kind = node.leaf ? "leaf" : "branch";
    // Leaves get a pill shape against the branches' soft rectangles, so the
    // recommendations read as a different kind of thing from across the room.
    group.append(
      this.create("rect", {
        class: "tree-box",
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rx: node.leaf ? node.height / 2 : 9,
      }),
    );
    const text = this.create("text", {
      class: "tree-label",
      x: node.x + node.width / 2,
      y: node.y + node.height / 2,
      "text-anchor": "middle",
      "dominant-baseline": "middle",
    });
    const leading = 13;
    node.lines.forEach((line, i) => {
      const dy = (i - (node.lines.length - 1) / 2) * leading;
      const span = this.create("tspan", { x: node.x + node.width / 2, y: node.y + node.height / 2 });
      span.setAttribute("dy", String(dy));
      span.textContent = line;
      text.append(span);
    });
    group.append(text);
    this.nodeEls.set(node.id, group);
    return group;
  }

  /** @param {string} id @returns {SVGGElement|undefined} */
  node(id) {
    return this.nodeEls.get(id);
  }

  /** @param {string} from @param {string} to @returns {SVGPathElement|undefined} */
  edge(from, to) {
    return this.edgeEls.get(edgeKey(from, to));
  }

  /** Returns every node and edge to the dimmed "not visited" state. */
  reset() {
    for (const el of this.nodeEls.values()) el.dataset.state = "idle";
    for (const el of this.edgeEls.values()) el.dataset.state = "idle";
  }
}
