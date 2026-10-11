// One traversal run: SSE frames in, lit tree and trace cards out.
//
// Nodes light on *actual event arrival*. There are deliberately no artificial delays
// and no easing of the sequence: the real per-call timing is the thing being
// demonstrated, so if two inferences land 8 ms apart the UI shows them 8 ms apart.
//
// Highlighting only ever flips `data-state` on elements `TreeView` already drew and
// fills their detail text, so the look lives entirely in styles.css (including the
// ~120 ms transitions) and nothing is re-rendered mid-run.
//
// The backend has no "about to infer" event — a `Step` is only yielded once its node's
// inference returns — so the frontier (`data-state="active"`) is derived client-side
// from `started.root` and each `step.next_node_id`, the same information stream.py
// uses internally to attribute an error to a node.
//
// Takes `TreeView` and `Trace` as arguments and touches no DOM of its own, which is how
// the Python suite drives it under node over the bytes the real backend produced.

import { streamAnalyze } from "./sse.js";
import { formatArguments, formatLatency, humanize } from "./trace.js";

/**
 * The detail lines drawn under a lit node: option picked, argument, latency.
 *
 * @param {{tool_called: string, arguments: Record<string, unknown>, latency_ms: number}} step
 * @returns {string[]}
 */
export function stepDetail(step) {
  return [humanize(step.tool_called), ...formatArguments(step.arguments), formatLatency(step.latency_ms)];
}

/**
 * Drives one run of `/api/analyze` and paints it as it arrives.
 *
 * `run()` resolves with the terminal event (`completed` / `unplaced`) or null if the
 * stream ended without one, and rejects on a rejected upload or an aborted stream.
 * The result card is not drawn here — a later story subscribes via `onTerminal`.
 */
export class Analysis {
  /**
   * @param {import("./trace.js").Trace} trace
   * @param {import("./tree.js").TreeView|null} [view] null when the tree failed to load
   */
  constructor(trace, view = null) {
    this.trace = trace;
    this.view = view;
    /** @type {{event: string, data: object}|null} the terminal event of the last run */
    this.terminal = null;
    /** @type {object|null} payload of an `error` event, if one arrived */
    this.error = null;
    /** The last node that was lit, so a step can draw the edge from its parent. */
    this.lit = null;
    /** @type {string|null} the node currently being inferred, or null between runs. */
    this.active = null;
    /** @type {string[]} each step's `tool_called`, in arrival order — the result breadcrumb. */
    this.picks = [];
    /** @type {AbortController|null} */
    this.controller = null;
    /** @type {((frame: {event: string, data: object}) => void)|null} */
    this.onTerminal = null;
    /** @type {((payload: object) => void)|null} */
    this.onError = null;
    /** @type {((step: object, index: number) => void)|null} called after each step is traced. */
    this.onStep = null;
    /** @type {((id: string) => void)|null} called whenever the frontier moves — drives auto-follow. */
    this.onActivate = null;
    /** @type {(() => void)|null} called by `reset()`, for UI this class does not own. */
    this.onReset = null;
  }

  /** True while a traversal is in flight. */
  get running() {
    return this.controller !== null;
  }

  /** Clears everything the last run drew, including the tree highlighting. */
  reset() {
    this.terminal = null;
    this.error = null;
    this.lit = null;
    this.active = null;
    this.picks = [];
    this.trace.reset();
    if (this.view) this.view.reset();
    if (this.onReset) this.onReset();
  }

  /** Aborts an in-flight stream. Safe to call when nothing is running. */
  cancel() {
    if (this.controller) this.controller.abort();
  }

  /** @param {string} id @param {"visited"|"warning"} state */
  light(id, state = "visited") {
    const node = this.view && this.view.node(id);
    if (node) node.dataset.state = state;
  }

  /**
   * Marks `id` as the node currently being inferred. The frontier is always a single
   * node while a run is in flight — the caller must have already flipped the previous
   * active node to `visited`/`warning` before calling this, which `handle()` does.
   *
   * @param {string} id
   */
  activate(id) {
    const node = this.view && this.view.node(id);
    if (node) node.dataset.state = "active";
    this.active = id;
    if (this.onActivate) this.onActivate(id);
  }

  /** Draws the edge between two nodes, if the graph has one. @param {string} from @param {string} to */
  lightEdge(from, to) {
    const edge = from && this.view && this.view.edge(from, to);
    if (edge) edge.dataset.state = "visited";
  }

  /**
   * Paints one SSE frame.
   *
   * @param {{event: string, data: any}} frame
   */
  handle(frame) {
    const { event, data } = frame;
    if (event === "started") {
      // The backend yields a `Step` only after that node's inference returns, so
      // there is no "about to infer" frame on the wire — but the root is exactly the
      // node the first inference is about to run on.
      this.activate(data.root);
      return;
    }
    if (event === "step") {
      // The node whose inference just returned flips from active to visited, along
      // with the edge from the node lit before it — which is this node's parent on
      // the path taken. `next_node_id` is the next (and, until it arrives, only)
      // inference pending, so it becomes the new frontier.
      this.light(data.node_id);
      this.lightEdge(this.lit, data.node_id);
      if (this.view) this.view.annotate(data.node_id, stepDetail(data));
      this.trace.addStep(data);
      this.picks.push(data.tool_called);
      // The rail is a sibling view over the same step data, not a rewrite of Trace —
      // it needs the step's own arrival index, which `picks.length` gives for free.
      if (this.onStep) this.onStep(data, this.picks.length - 1);
      this.lit = data.node_id;
      this.activate(data.next_node_id);
      return;
    }
    if (event === "completed") {
      // The leaf gets no step of its own, so its node and the edge into it light here
      // — last, as the PRD's sequence requires. It was already the frontier (the
      // previous step's `next_node_id`), so this just flips active to visited.
      this.lightEdge(this.lit, data.leaf_node_id);
      this.light(data.leaf_node_id);
      this.active = null;
      this.trace.setTotal(data.total_inference_ms);
      this.terminal = frame;
      if (this.onTerminal) this.onTerminal(frame);
      return;
    }
    if (event === "unplaced") {
      // Nodes visited before the stop stay lit; the node that could not be resolved
      // takes the warning outline instead of the visited highlight — it was the
      // frontier, and the run is over, so there is no active node after this.
      this.lightEdge(this.lit, data.stopped_at_node_id);
      this.light(data.stopped_at_node_id, "warning");
      this.active = null;
      this.trace.setTotal(data.total_inference_ms);
      this.terminal = frame;
      if (this.onTerminal) this.onTerminal(frame);
      return;
    }
    if (event === "error") {
      this.error = data;
      // The failing node was the frontier; it takes the warning outline instead of
      // leaving a dead "active" pulse on a node that will never resolve.
      if (data.node_id) this.light(data.node_id, "warning");
      this.active = null;
      if (this.onError) this.onError(data);
    }
  }

  /**
   * Streams one run and paints it. Resolves with the terminal event, or null.
   *
   * @param {Uint8Array} bytes the encoded WAV, the same bytes playback uses
   * @param {{fetchImpl?: typeof fetch}} [options]
   * @returns {Promise<{event: string, data: object}|null>}
   */
  async run(bytes, options = {}) {
    this.reset();
    this.controller = new AbortController();
    try {
      await streamAnalyze(bytes, {
        onEvent: (frame) => this.handle(frame),
        signal: this.controller.signal,
        ...options,
      });
      return this.terminal;
    } finally {
      this.controller = null;
    }
  }
}
