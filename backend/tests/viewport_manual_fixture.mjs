// Runs the pure manual pan/zoom helpers in frontend/viewport.js under node, so the
// Python suite can pin their maths — see test_frontend_viewport.py. Only `panBox`,
// `zoomBox`, and `zoomBounds` are exercised here; `Viewport.enableManualControls` is
// DOM glue and is reviewed, not node-tested, same split as `goTo`'s animation loop.
//
// Usage:
//   node viewport_manual_fixture.mjs pan <x> <y> <w> <h> <dx> <dy>
//   node viewport_manual_fixture.mjs zoom <x> <y> <w> <h> <factor> <anchorX> <anchorY> <wholeW> <wholeH>
//   node viewport_manual_fixture.mjs bounds <wholeW> <wholeH>

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");
const { panBox, zoomBox, zoomBounds } = await import(pathToFileURL(join(frontend, "viewport.js")).href);

const [op, ...rest] = process.argv.slice(2);
const nums = rest.map(Number);

if (op === "pan") {
  const [x, y, width, height, dx, dy] = nums;
  process.stdout.write(JSON.stringify(panBox({ x, y, width, height }, dx, dy)));
} else if (op === "zoom") {
  const [x, y, width, height, factor, anchorX, anchorY, wholeW, wholeH] = nums;
  const bounds = zoomBounds({ width: wholeW, height: wholeH });
  process.stdout.write(
    JSON.stringify({ box: zoomBox({ x, y, width, height }, factor, anchorX, anchorY, bounds), bounds }),
  );
} else if (op === "bounds") {
  const [wholeW, wholeH] = nums;
  process.stdout.write(JSON.stringify(zoomBounds({ width: wholeW, height: wholeH })));
} else {
  throw new Error(`unknown op: ${op}`);
}
