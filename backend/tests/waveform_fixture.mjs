// Runs the *shipped* `peakEnvelope` downsampling function under node and prints the
// results as JSON, so the Python suite can pin it without a canvas or a DOM — see
// test_frontend_waveform.py.

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");
const { peakEnvelope } = await import(pathToFileURL(join(frontend, "waveform.js")).href);

// A ramp from -1 to 1 across 8 samples, so each column's min/max is easy to reason about.
const ramp = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75];
// A single spike buried in otherwise-silent samples — the peak envelope must still show
// it even though it is only one sample wide (an average across the column would hide it).
const spike = [0, 0, 0, 0, 1, 0, 0, 0];

process.stdout.write(
  JSON.stringify({
    rampFourColumns: peakEnvelope(ramp, 4),
    rampOneColumn: peakEnvelope(ramp, 1),
    spikeFourColumns: peakEnvelope(spike, 4),
    // Fewer samples than columns: some columns necessarily have no samples of their own.
    fewSamplesManyColumns: peakEnvelope([0.2, -0.6, 0.9], 8),
    // The degenerate case of no samples at all — must not throw.
    empty: peakEnvelope([], 5),
  }),
);
