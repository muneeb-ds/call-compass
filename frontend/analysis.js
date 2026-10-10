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
    /** @type {string[]} each step's `tool_called`, in arrival order — the result breadcrumb. */
    this.picks = [];
    /** @type {AbortController|null} */
    this.controller = null;
    /** @type {((frame: {event: string, data: object}) => void)|null} */
    this.onTerminal = null;
    /** @type {((payload: object) => void)|null} */
    this.onError = null;
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
    if (event === "step") {
      // The node whose inference just returned lights now, along with the edge from
      // the node lit before it — which is this node's parent on the path taken.
      this.light(data.node_id);
      this.lightEdge(this.lit, data.node_id);
      if (this.view) this.view.annotate(data.node_id, stepDetail(data));
      this.trace.addStep(data);
      this.picks.push(data.tool_called);
      this.lit = data.node_id;
      return;
    }
    if (event === "completed") {
      // The leaf gets no step of its own, so its node and the edge into it light here
      // — last, as the PRD's sequence requires.
      this.lightEdge(this.lit, data.leaf_node_id);
      this.light(data.leaf_node_id);
      this.trace.setTotal(data.total_inference_ms);
      this.terminal = frame;
      if (this.onTerminal) this.onTerminal(frame);
      return;
    }
    if (event === "unplaced") {
      // Nodes visited before the stop stay lit; the node that could not be resolved
      // takes the warning outline instead of the visited highlight.
      this.lightEdge(this.lit, data.stopped_at_node_id);
      this.light(data.stopped_at_node_id, "warning");
      this.trace.setTotal(data.total_inference_ms);
      this.terminal = frame;
      if (this.onTerminal) this.onTerminal(frame);
      return;
    }
    if (event === "error") {
      this.error = data;
      if (data.node_id) this.light(data.node_id, "warning");
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
