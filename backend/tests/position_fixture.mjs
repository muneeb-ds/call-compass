// Runs the *shipped* `PositionReadout` under node, driven by `Analysis` over a real
// traversal's SSE body, so the Python suite can pin the readout text against the
// actual tree and the actual event sequence the backend produced (see
// test_frontend_position.py).
//
// Same harness shape as `analysis_fixture.mjs`: a stub `fetch` replays the captured
// body in fixed-size chunks.
//
// Usage: node position_fixture.mjs <tree.json> <sse-body-file> [--chunk=N] -> JSON on stdout

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");
const load = (name) => import(pathToFileURL(join(frontend, name)).href);

const { TreeView } = await load("tree.js");
const { Trace } = await load("trace.js");
const { Analysis } = await load("analysis.js");
const { formatPosition, PositionReadout } = await load("position.js");

const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? Number(found.split("=")[1]) : fallback;
};

const tree = JSON.parse(await readFile(process.argv[2], "utf8"));
const body = await readFile(process.argv[3], "utf8");
const chunk = arg("chunk", 0) || body.length;

/** The smallest element that satisfies what TreeView, Trace, and PositionReadout do to one. */
function element(name) {
  return {
    name,
    attrs: {},
    dataset: {},
    children: [],
    className: "",
    textContent: "",
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
  };
}

function fakeFetch(url, init) {
  const request = { url, ...init };
  const encoder = new TextEncoder();
  let offset = 0;
  return Promise.resolve({
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (request.signal && request.signal.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          }
          if (offset >= body.length) return { done: true, value: undefined };
          const piece = body.slice(offset, offset + chunk);
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
const trace = new Trace(element("p"), element("div"));
const analysis = new Analysis(trace, view);
const readoutEl = element("p");
const position = new PositionReadout(readoutEl);

const readings = [];
analysis.onActivate = (id) => {
  position.activate(id);
  readings.push(readoutEl.textContent);
};
analysis.onTerminal = (frame) => {
  const id = frame.data.leaf_node_id ?? frame.data.stopped_at_node_id;
  position.finish(id, frame.data.inference_count);
  readings.push(readoutEl.textContent);
};
analysis.onError = (payload) => {
  position.finish(payload.node_id);
  readings.push(readoutEl.textContent);
};

position.setLayout(view.layout, tree.root);
const beforeRun = readoutEl.textContent;

await analysis.run(new Uint8Array([1, 2, 3]), { fetchImpl: fakeFetch });

const afterRun = readoutEl.textContent;
// A reset returns to the pre-run root statement, with the count cleared.
position.reset(tree.root);
const afterReset = readoutEl.textContent;

process.stdout.write(
  JSON.stringify({
    beforeRun,
    readings,
    afterRun,
    afterReset,
    maxDepth: view.layout.levels,
    formatNoCount: formatPosition({ label: "Intent", depth: 1, maxDepth: 5 }),
    formatWithCount: formatPosition({ label: "Intent", depth: 1, maxDepth: 5, inferenceCount: 3 }),
  }),
);
