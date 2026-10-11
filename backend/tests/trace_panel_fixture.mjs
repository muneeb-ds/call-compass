// Runs the *shipped* trace rail and slide-over panel over a real traversal's SSE body
// under node (see test_frontend_trace_panel.py). Same harness shape as
// analysis_fixture.mjs / outcome_fixture.mjs: a captured `/api/analyze` response body
// is replayed through the shipped `sse.js` / `trace.js` / `analysis.js`, and
// `TraceRail` / `TracePanel` are driven exactly as app.js wires them — the rail from
// `Analysis.onStep`, the total from `Analysis.onTerminal`, and the panel's open state
// left untouched by `Analysis.reset()`.
//
// Usage: node trace_panel_fixture.mjs <tree.json> <sse-body-file>  ->  JSON on stdout

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");
const load = (name) => import(pathToFileURL(join(frontend, name)).href);

const { TreeView } = await load("tree.js");
const { Trace } = await load("trace.js");
const { Analysis } = await load("analysis.js");
const { TraceRail, TracePanel } = await load("trace-panel.js");

const tree = JSON.parse(await readFile(process.argv[2], "utf8"));
const body = await readFile(process.argv[3], "utf8");

/** The smallest element that satisfies what these modules do to one, plus the
 * listener bookkeeping `TracePanel`/`TraceRail` need (`addEventListener` and a manual
 * `fire` to simulate a click/keydown without a real DOM). */
function element(name) {
  return {
    name,
    attrs: {},
    dataset: {},
    children: [],
    className: "",
    textContent: "",
    listeners: {},
    ownerDocument: {
      createElementNS: (_ns, n) => element(n),
      createElement: (n) => element(n),
    },
    setAttribute(key, value) {
      this.attrs[key] = value;
    },
    append(...kids) {
      this.children.push(...kids);
    },
    replaceChildren(...kids) {
      this.children = [...kids];
    },
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    fire(type, event = {}) {
      for (const fn of this.listeners[type] ?? []) fn(event);
    },
  };
}

/** A `fetch` that replays the whole captured body in one piece. */
function fakeFetch(_url, _init) {
  const encoder = new TextEncoder();
  let offset = 0;
  return Promise.resolve({
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (offset >= body.length) return { done: true, value: undefined };
          const piece = body.slice(offset);
          offset += piece.length;
          return { done: false, value: encoder.encode(piece) };
        },
        cancel: async () => {},
      }),
    },
  });
}

const svg = element("svg");
const view = new TreeView(svg);
view.render(tree);
const totalEl = element("p");
const listEl = element("div");
const trace = new Trace(totalEl, listEl);
const analysis = new Analysis(trace, view);

const railListEl = element("div");
const railTotalEl = element("p");
const selected = [];
const rail = new TraceRail(railListEl, railTotalEl, {
  onSelect: (index) => selected.push(index),
});

const panelEl = element("aside");
const toggleEl = element("button");
const doc = element("document");
const panel = new TracePanel(panelEl, toggleEl, { doc });
rail.reset();

const initial = {
  panelState: panelEl.dataset.state,
  toggleExpanded: toggleEl.attrs["aria-expanded"],
  chips: railListEl.children.length,
  railTotal: railTotalEl.textContent,
};

analysis.onStep = (step, index) => rail.addStep(step, index);
analysis.onReset = () => rail.reset();
analysis.onTerminal = (frame) => rail.setTotal(frame.data.total_inference_ms);

await analysis.run(new Uint8Array([1, 2, 3]), { fetchImpl: fakeFetch });

/** What one chip says, read back out of the stub element. */
function chip(el) {
  return {
    index: el.dataset.index,
    label: el.children.find((c) => c.className === "trace-chip-index").textContent,
    latency: el.children.find((c) => c.className === "trace-chip-latency mono").textContent,
  };
}

// Click the first chip: fires `onSelect` with its index, same as a real click would.
railListEl.children[0]?.fire("click");

// Open, then close via Escape, then open again via the toggle button.
toggleEl.fire("click");
const afterToggleOpen = { state: panelEl.dataset.state, expanded: toggleEl.attrs["aria-expanded"] };
doc.fire("keydown", { key: "Escape" });
const afterEscape = { state: panelEl.dataset.state, expanded: toggleEl.attrs["aria-expanded"] };
toggleEl.fire("click");
const reopened = { state: panelEl.dataset.state, expanded: toggleEl.attrs["aria-expanded"] };

process.stdout.write(
  JSON.stringify({
    initial,
    chips: railListEl.children.map(chip),
    railTotal: railTotalEl.textContent,
    selected,
    afterToggleOpen,
    afterEscape,
    reopened,
    // A reset clears the rail but must never touch the panel's open/closed state.
    afterReset: (() => {
      analysis.reset();
      return {
        chips: railListEl.children.length,
        railTotal: railTotalEl.textContent,
        panelState: panelEl.dataset.state,
      };
    })(),
  }),
);
