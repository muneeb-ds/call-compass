// Runs the *shipped* outcome strip over a real traversal's SSE body under node (see
// test_frontend_outcome.py). Same harness shape as analysis_fixture.mjs: a captured
// `/api/analyze` response body is replayed through the shipped `sse.js` / `trace.js` /
// `analysis.js`, and `OutcomeStrip` is driven exactly as app.js drives it — cleared by
// `Analysis.onReset`, drawn only from `onTerminal` / `onError`.
//
// Usage: node outcome_fixture.mjs <tree.json> <sse-body-file>  ->  JSON on stdout

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");
const load = (name) => import(pathToFileURL(join(frontend, name)).href);

const { TreeView } = await load("tree.js");
const { Trace } = await load("trace.js");
const { Analysis } = await load("analysis.js");
const { OutcomeStrip, STOP_REASONS, breadcrumb, formatEndToEnd, formatInferenceCount, reasonText } =
  await load("outcome.js");

const tree = JSON.parse(await readFile(process.argv[2], "utf8"));
const body = await readFile(process.argv[3], "utf8");

/** The smallest element that satisfies what these modules do to one. */
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

const stripEl = element("p");
const strip = new OutcomeStrip(stripEl);
const stripEmpty = { state: stripEl.dataset.state ?? null, children: stripEl.children.length };
analysis.onReset = () => strip.clear();

const stripStates = [];
const handled = analysis.handle.bind(analysis);
analysis.handle = (frame) => {
  const out = handled(frame);
  stripStates.push([frame.event, stripEl.dataset.state ?? null]);
  return out;
};

analysis.onTerminal = (frame) => {
  if (frame.event === "completed") strip.completed(frame.data, analysis.picks);
  if (frame.event === "unplaced") strip.unplaced(frame.data, analysis.picks);
};
analysis.onError = (payload) => strip.errored(payload);

await analysis.run(new Uint8Array([1, 2, 3]), { fetchImpl: fakeFetch });

/** What the strip says, read back out of the stub element. One reader for all three
 * terminal looks, so "no leaf label on unplaced" and "no latency on error" are
 * assertable from the same shape. */
function read() {
  const state = stripEl.dataset.state ?? null;
  if (state === null) return { state: null };
  const line = stripEl.children[0];
  const text = (className) => {
    const found = line.children.find((c) => c.className === className);
    return found ? found.textContent : null;
  };
  return {
    state,
    label: text("outcome-label"),
    path: text("outcome-path"),
    count: text("outcome-count mono"),
    latency: text("outcome-latency mono"),
    reason: text("outcome-reason"),
  };
}

process.stdout.write(
  JSON.stringify({
    picks: analysis.picks,
    strip: read(),
    stripEmpty,
    stripStates,
    error: analysis.error,
    afterReset: (() => {
      analysis.reset();
      return { state: stripEl.dataset.state ?? null, children: stripEl.children.length };
    })(),
    breadcrumb: {
      three: breadcrumb(["pricing_question", "pro_tier", "budget_objection"]),
      one: breadcrumb(["not_interested"]),
      none: breadcrumb([]),
    },
    endToEnd: formatEndToEnd(497.6),
    inferenceCount: { one: formatInferenceCount(1), many: formatInferenceCount(4) },
    stopReasons: STOP_REASONS,
    // Every backend reason code, plus one the UI has never heard of.
    reasonText: Object.fromEntries(
      [...Object.keys(STOP_REASONS), "something_new"].map((reason) => [
        reason,
        reasonText(reason, "Pricing concern"),
      ]),
    ),
  }),
);
