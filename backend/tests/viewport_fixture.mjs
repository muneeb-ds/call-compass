// Runs the *shipped* `frameFor` under node over the real tree layout, so the Python
// suite can pin the camera framing against the tree the backend actually serves (see
// test_frontend_viewport.py).
//
// Only the pure half of viewport.js is exercised — `frameFor` touches no DOM, which is
// the half whose maths has to be right. `Viewport` (the drawing half) is reviewed, not
// pinned here, the same split `tree_fixture.mjs` makes for `layoutTree` vs `TreeView`.
//
// Usage: node viewport_fixture.mjs <tree.json path> <nodeId> <aspect> [zoom]  -> JSON on stdout

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");
const { layoutTree } = await import(pathToFileURL(join(frontend, "tree.js")).href);
const { frameFor } = await import(pathToFileURL(join(frontend, "viewport.js")).href);

const tree = JSON.parse(await readFile(process.argv[2], "utf8"));
const nodeId = process.argv[3];
const aspect = Number(process.argv[4]);
const zoom = process.argv[5] === undefined ? undefined : Number(process.argv[5]);

const layout = layoutTree(tree);
const frame = zoom === undefined ? frameFor(layout, nodeId, aspect) : frameFor(layout, nodeId, aspect, zoom);

process.stdout.write(JSON.stringify({ layout: { width: layout.width, height: layout.height }, frame }));
