// Runs the *shipped* frontend tree layout under node over the real config, so the
// Python suite can check the drawing against the tree the backend actually serves
// (see test_frontend_tree.py).
//
// Only the pure half of tree.js is exercised: `layoutTree` and `wrapLabel` touch no
// DOM, which is deliberate — the coordinates are the part that has to be right, and
// they are the part a browser check reads least reliably.
//
// `--draw` additionally runs TreeView over a handful of stub SVG elements, which is
// how the initial dimmed state and the leaf-vs-branch shapes are pinned without a
// browser. TreeView takes its <svg> as an argument and never touches `document`, which
// is what makes that possible.
//
// Usage: node tree_fixture.mjs <tree.json path> [--draw]  -> JSON on stdout

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");
const { layoutTree, wrapLabel, edgeKey, TreeView } = await import(
  pathToFileURL(join(frontend, "tree.js")).href
);

const tree = JSON.parse(await readFile(process.argv[2], "utf8"));
const layout = layoutTree(tree);

/** The smallest element that satisfies what TreeView does to one. */
function element(name) {
  const el = {
    name,
    attrs: {},
    dataset: {},
    children: [],
    textContent: "",
    ownerDocument: { createElementNS: (_ns, n) => element(n) },
    setAttribute(key, value) {
      this.attrs[key] = value;
    },
    append(...kids) {
      this.children.push(...kids);
    },
    replaceChildren() {
      this.children = [];
    },
  };
  return el;
}

/** Everything the drawing says about one node: shape, state, and the text drawn. */
function describe(group) {
  const rect = group.children.find((c) => c.name === "rect");
  const text = group.children.find((c) => c.name === "text");
  return {
    id: group.dataset.nodeId,
    kind: group.dataset.kind,
    state: group.dataset.state,
    rx: Number(rect.attrs.rx),
    lines: text.children.map((t) => t.textContent),
  };
}

const drawn = {};
if (process.argv.includes("--draw")) {
  const svg = element("svg");
  const view = new TreeView(svg);
  view.render(tree);
  drawn.viewBox = svg.attrs.viewBox;
  drawn.ariaLabel = svg.attrs["aria-label"];
  drawn.layers = svg.children.map((g) => g.attrs.class);
  drawn.nodes = [...view.nodeEls.values()].map(describe);
  drawn.edges = [...view.edgeEls.entries()].map(([key, path]) => ({
    key,
    state: path.dataset.state,
    from: path.dataset.from,
    to: path.dataset.to,
    // A move followed by one cubic: edges are drawn, not faked with a straight line.
    d: path.attrs.d.slice(0, 1) + (path.attrs.d.includes(" C ") ? "C" : ""),
  }));
  // Re-rendering must not accumulate: the operator reloads the tree between runs.
  view.render(tree);
  drawn.nodeCountAfterRerender = view.nodeEls.size;
  drawn.layersAfterRerender = svg.children.length;
  for (const el of view.nodeEls.values()) el.dataset.state = "visited";
  view.reset();
  drawn.statesAfterReset = [...new Set([...view.nodeEls.values()].map((e) => e.dataset.state))];
  drawn.hasNodeLookup = view.node(tree.root) !== undefined;
}

process.stdout.write(
  JSON.stringify({
    ...layout,
    edgeKeys: layout.edges.map((e) => edgeKey(e.from, e.to)),
    drawn,
    wrap: {
      short: wrapLabel("Customer intent"),
      long: wrapLabel("Objection or buying signal that keeps going well past one line"),
      empty: wrapLabel("   "),
    },
  }),
);
