// CallCompass demo shell.
//
// Shell-only for now: the single job is to tell the operator, before they start
// talking to an audience, whether the backend actually came up with a model and a
// tree. Everything else on the page is a labelled placeholder that later stories
// replace. No bundler, no build step — this is loaded directly as an ES module.

/** @param {string} text @param {"loading"|"ready"|"error"} state */
function setStatus(text, state) {
  const el = document.getElementById("health-status");
  el.textContent = text;
  el.dataset.state = state;
}

/**
 * Reads GET /api/health and reports readiness inline.
 *
 * Failures are shown in the page, never as an alert() and never swallowed: a demo
 * machine where the model did not load has to look broken on screen.
 */
export async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) {
      setStatus(`Backend not ready: HTTP ${response.status}`, "error");
      return null;
    }
    const health = await response.json();
    if (health.status !== "ok" || !health.model_loaded) {
      setStatus("Backend not ready: model is not loaded", "error");
      return null;
    }
    setStatus(
      `${health.tree_id} · ${health.node_count} nodes · model ${health.model_load_ms} ms`,
      "ready",
    );
    return health;
  } catch (err) {
    setStatus(`Backend unreachable: ${err.message}`, "error");
    return null;
  }
}

checkHealth();
