// Runs the *shipped* SSE reader, trace panel, and highlighting under node over the
// bytes the real backend produced (see test_frontend_analysis.py).
//
// The body is served back through a stub `fetch` as a `ReadableStream` chopped into
// fixed-size chunks, so `streamAnalyze` is exercised on its real path — including frame
// boundaries landing mid-JSON, which is the failure a "split the finished body" parser
// would never hit in a browser until the day the response arrives in two packets.
//
// `Analysis` and `Trace` take their DOM as arguments and never touch `document`, so a
// few stub elements are enough to drive them and read back exactly what the demo would
// have drawn.
//
// Usage: node analysis_fixture.mjs <tree.json> <sse-body-file> [--chunk=N] [--status=N]
//        [--abort-after=N]  ->  JSON on stdout

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");
const load = (name) => import(pathToFileURL(join(frontend, name)).href);

const { TreeView } = await load("tree.js");
const { Trace } = await load("trace.js");
const { Analysis, stepDetail } = await load("analysis.js");
const { ResultCard, breadcrumb, formatEndToEnd } = await load("result.js");
const { AnalyzeError, SseDecoder, parseFrame } = await load("sse.js");

const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? Number(found.split("=")[1]) : fallback;
};

const tree = JSON.parse(await readFile(process.argv[2], "utf8"));
const body = await readFile(process.argv[3], "utf8");
const chunk = arg("chunk", 0) || body.length;
const status = arg("status", 200);
const abortAfter = arg("abort-after", -1);

/** The smallest element that satisfies what TreeView and Trace do to one. */
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

/** A `fetch` that replays `body` in `chunk`-sized pieces, or refuses with `status`. */
function fakeFetch(url, init) {
  const request = { url, ...init };
  requests.push(request);
  if (status !== 200) {
    return Promise.resolve({
      ok: false,
      status,
      json: async () => ({ detail: "Audio must be 16000 Hz mono; received 44100 Hz stereo." }),
    });
  }
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
        cancel: async () => {
          cancelled = true;
        },
      }),
    },
  });
}

const requests = [];
let cancelled = false;

const svg = element("svg");
const view = new TreeView(svg);
view.render(tree);
const totalEl = element("p");
const listEl = element("div");
const trace = new Trace(totalEl, listEl);
const analysis = new Analysis(trace, view);

// The result area, wired exactly as app.js wires it: drawn from the terminal event
// only, cleared by reset().
const resultEl = element("div");
const result = new ResultCard(resultEl);
result.clear();
const resultEmpty = { state: resultEl.dataset.state, text: resultEl.children[0].textContent };
analysis.onReset = () => result.clear();

const frames = [];
// The result area's state after each frame: it must stay empty until the terminal one.
const resultStates = [];
const handled = analysis.handle.bind(analysis);
analysis.handle = (frame) => {
  frames.push([frame.event, frame.data]);
  if (frames.length === abortAfter) analysis.cancel();
  const out = handled(frame);
  resultStates.push([frame.event, resultEl.dataset.state]);
  return out;
};

let terminal = null;
let failure = null;
analysis.onTerminal = (frame) => {
  terminal = frame.event;
  if (frame.event === "completed") result.completed(frame.data, analysis.picks);
};
try {
  await analysis.run(new Uint8Array([1, 2, 3]), { fetchImpl: fakeFetch });
} catch (err) {
  failure = { name: err.name, message: err.message, isAnalyzeError: err instanceof AnalyzeError };
}

/** What one step card says, read back out of the stub elements. */
function card(el) {
  const header = el.children.find((c) => c.className === "step-node");
  return {
    index: el.dataset.index,
    node: header.textContent,
    latency: header.children[0].textContent,
    latencyClass: header.children[0].className,
    option: el.children.find((c) => c.className === "step-option").textContent,
    args: el.children.filter((c) => c.className === "step-arg mono").map((c) => c.textContent),
  };
}

const states = (map) => Object.fromEntries([...map].map(([k, el]) => [k, el.dataset.state]));

process.stdout.write(
  JSON.stringify({
    frames,
    terminal,
    terminalEvent: analysis.terminal && analysis.terminal.event,
    error: analysis.error,
    failure,
    running: analysis.running,
    cancelled,
    requests: requests.map((r) => ({
      url: r.url,
      method: r.method,
      // The upload really is the multipart form the endpoint expects.
      audioBytes: r.body.get("audio").size,
      audioType: r.body.get("audio").type,
    })),
    nodes: states(view.nodeEls),
    edges: states(view.edgeEls),
    details: Object.fromEntries(
      [...view.detailEls].map(([id, el]) => [id, el.children.map((c) => c.textContent)]),
    ),
    total: totalEl.textContent,
    cards: listEl.children.map(card),
    picks: analysis.picks,
    resultEmpty,
    resultStates,
    // What the recommendation card says, read back out of the stub elements.
    result: (() => {
      const state = resultEl.dataset.state;
      const el = resultEl.children[0];
      const text = (className) => {
        const found = el.children && el.children.find((c) => c.className === className);
        return found ? found.textContent : null;
      };
      if (state !== "completed") return { state, empty: el.textContent };
      const head = el.children.find((c) => c.className === "result-head");
      return {
        state,
        label: head.textContent,
        latency: head.children[0].textContent,
        latencyClass: head.children[0].className,
        recommendation: text("result-recommendation"),
        path: text("result-path"),
        rationale: text("result-rationale"),
      };
    })(),
    // Reset is US-016's button, but it has to undo everything above right now.
    afterReset: (() => {
      analysis.reset();
      return {
        nodes: [...new Set(Object.values(states(view.nodeEls)))],
        edges: [...new Set(Object.values(states(view.edgeEls)))],
        details: [...view.detailEls.values()].every((el) => el.children.length === 0),
        cards: listEl.children.length,
        total: totalEl.textContent,
        picks: analysis.picks,
        result: { state: resultEl.dataset.state, text: resultEl.children[0].textContent },
      };
    })(),
    // The decoder on its own: a frame split anywhere must still arrive exactly once.
    decoder: (() => {
      const decoder = new SseDecoder();
      const out = [];
      for (let i = 0; i < body.length; i += 1) out.push(...decoder.push(body[i]));
      out.push(...decoder.flush());
      return out.map((f) => f.event);
    })(),
    comments: (() => {
      const decoder = new SseDecoder();
      // A keep-alive comment and CRLF framing are both legal and must not be events.
      const got = decoder.push(": keep-alive\r\n\r\nevent: done\r\ndata: {}\r\n\r\n");
      return got.map((f) => f.event);
    })(),
    noData: parseFrame("event: step"),
    breadcrumb: {
      three: breadcrumb(["pricing_question", "pro_tier", "budget_objection"]),
      one: breadcrumb(["not_interested"]),
      none: breadcrumb([]),
    },
    endToEnd: formatEndToEnd(497.6),
    stepDetail: stepDetail({
      tool_called: "pricing_question",
      arguments: { pricing_focus: "plan_cost" },
      latency_ms: 142.6,
    }),
  }),
);
