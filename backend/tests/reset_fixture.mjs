// Runs the *shipped* Reset control over two consecutive traversals under node
// (see test_frontend_reset.py).
//
// The point of this fixture is the sequence, not a single snapshot: run, reset, run
// again. "Two consecutive runs do not accumulate" is only observable by doing it, and
// a Trace column that stacked the second run's cards on the first would pass every
// single-run assertion in the suite.
//
// Everything is wired exactly as app.js wires it — `resetAll` over the real `Analysis`
// plus a stub capture half, armed only by a finished run — so the button's enablement
// rule is checked here rather than read off the markup.
//
// Usage: node reset_fixture.mjs <tree.json> <sse-body-file> [--chunk=N]
//        [--reset-after=N] [--arm-first]  ->  JSON on stdout

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");
const load = (name) => import(pathToFileURL(join(frontend, name)).href);

const { TreeView } = await load("tree.js");
const { Trace } = await load("trace.js");
const { Analysis } = await load("analysis.js");
const { ResultCard } = await load("result.js");
const { ResetControl, resetAll } = await load("reset.js");

const flag = (name) => process.argv.includes(`--${name}`);
const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? Number(found.split("=")[1]) : fallback;
};

const tree = JSON.parse(await readFile(process.argv[2], "utf8"));
const body = await readFile(process.argv[3], "utf8");
const chunk = arg("chunk", 0) || body.length;
const resetAfter = arg("reset-after", -1);

/** The smallest element that satisfies what these modules do to one. */
function element(name) {
  return {
    name,
    attrs: {},
    dataset: {},
    children: [],
    className: "",
    textContent: "",
    disabled: false,
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

/** A `fetch` that replays `body` in `chunk`-sized pieces and honours the abort signal. */
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
const totalEl = element("p");
const listEl = element("div");
const trace = new Trace(totalEl, listEl);
const analysis = new Analysis(trace, view);
const resultEl = element("div");
const result = new ResultCard(resultEl);
result.clear();
analysis.onReset = () => result.clear();

// The capture half, stood in for: `resetAll` only needs `reset()`, and app.js's own
// version of it is DOM wiring that cannot be loaded here. Counting the calls is what
// proves Reset clears the recording and the playback control at all.
const capture = {
  resets: 0,
  reset() {
    this.resets += 1;
  },
};

const button = element("button");
const control = new ResetControl(button, () => resetAll({ analysis, capture }));
// `--arm-first` stands for "a previous run already finished", which is the state in
// which Reset is live while a stream is in flight.
if (flag("arm-first")) control.arm();

/** Whether the button was live as each frame arrived. */
const armedPerFrame = [];
const handled = analysis.handle.bind(analysis);
let frames = 0;
analysis.handle = (frame) => {
  frames += 1;
  const out = handled(frame);
  armedPerFrame.push([frame.event, control.armed]);
  if (frames === resetAfter) control.trigger();
  return out;
};

analysis.onTerminal = (frame) => {
  if (frame.event === "completed") result.completed(frame.data, analysis.picks);
  if (frame.event === "unplaced") result.unplaced(frame.data, analysis.picks);
  control.arm();
};
analysis.onError = (payload) => {
  result.errored(payload);
  control.arm();
};

const states = (map) => Object.fromEntries([...map].map(([k, el]) => [k, el.dataset.state]));
const unique = (map) => [...new Set(Object.values(states(map)))].sort();

/** Everything on screen, read back out of the stub elements. */
function snapshot() {
  const card = resultEl.children[0];
  return {
    armed: control.armed,
    disabled: button.disabled,
    nodes: states(view.nodeEls),
    nodeStates: unique(view.nodeEls),
    edgeStates: unique(view.edgeEls),
    annotated: [...view.detailEls.values()].filter((el) => el.children.length).length,
    cards: listEl.children.map((el) => ({
      index: el.dataset.index,
      node: el.children.find((c) => c.className === "step-node").textContent,
      option: el.children.find((c) => c.className === "step-option").textContent,
    })),
    total: totalEl.textContent,
    picks: analysis.picks,
    terminal: analysis.terminal && analysis.terminal.event,
    running: analysis.running,
    result: { state: resultEl.dataset.state, text: card ? card.textContent : null },
    captureResets: capture.resets,
  };
}

/** One traversal. Resolves with how it ended rather than throwing. */
async function run() {
  try {
    await analysis.run(new Uint8Array([1, 2, 3]), { fetchImpl: fakeFetch });
    return null;
  } catch (err) {
    return { name: err.name, message: err.message };
  }
}

const initial = snapshot();
const firstFailure = await run();
const afterFirstRun = snapshot();
// The enablement sequence belongs to one run; the second run appends to the same list.
const armedPerFrameFirstRun = [...armedPerFrame];

// The click. A second press must do nothing: the first one disarmed the button, so the
// teardown cannot run twice and clear a run that has only just started drawing.
const pressed = control.trigger();
const afterReset = snapshot();
const pressedAgain = control.trigger();
const afterSecondPress = snapshot();

frames = 0;
const secondFailure = await run();
const afterSecondRun = snapshot();

process.stdout.write(
  JSON.stringify({
    initial,
    armedPerFrame: armedPerFrameFirstRun,
    firstFailure,
    afterFirstRun,
    pressed,
    afterReset,
    pressedAgain,
    afterSecondPress,
    secondFailure,
    afterSecondRun,
  }),
);
