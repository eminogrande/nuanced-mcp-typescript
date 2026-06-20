import { test } from "node:test";
import assert from "node:assert/strict";
import { enrich, findDependents, findDirectCallers, findIndirectCallers, type Graph } from "../graph/analyzer.js";

// A tiny synthetic graph shaped like the nuanced output format.
// a.main -> a.greet, a.helper -> a.greet; a.greet -> a.fmt
function sampleGraph(): Graph {
  return {
    "src.a.main": { filepath: "/repo/src/a.ts", callees: ["src.a.greet"], lineno: 1, end_lineno: 2 },
    "src.a.helper": { filepath: "/repo/src/a.ts", callees: ["src.a.greet"], lineno: 4, end_lineno: 5 },
    "src.a.greet": { filepath: "/repo/src/a.ts", callees: ["src.a.fmt"], lineno: 7, end_lineno: 8 },
    "src.a.fmt": { filepath: "/repo/src/a.ts", callees: [], lineno: 10, end_lineno: 10 },
  };
}

test("enrich returns the transitive subgraph for the entry function", () => {
  const g = sampleGraph();
  // Use the absolute filepath matching graph node.filepath.
  const e = enrich(g, "/repo/src/a.ts", "main");
  assert.equal(e.errors.length, 0);
  assert.ok(e.result);
  assert.ok(e.result!["src.a.main"], "entrypoint included");
  assert.ok(e.result!["src.a.greet"], "direct callee included");
  assert.ok(e.result!["src.a.fmt"], "transitive callee included");
  // helper does NOT call main, so not in subgraph
  assert.equal(e.result!["src.a.helper"], undefined);
});

test("enrich returns null result for unknown function", () => {
  const g = sampleGraph();
  const e = enrich(g, "/repo/src/a.ts", "nope");
  assert.equal(e.errors.length, 0);
  assert.equal(e.result, null);
});

test("findDependents lists files that call the target", () => {
  const g = sampleGraph();
  const deps = findDependents(g, ["src.a.greet"]);
  const files = [...deps.keys()];
  assert.deepEqual(files.sort(), ["/repo/src/a.ts"]);
  const fns = deps.get("/repo/src/a.ts")!.sort();
  assert.deepEqual(fns, ["helper", "main"]);
});

test("findDirectCallers and findIndirectCallers traverse the call chain", () => {
  const g = sampleGraph();
  // who directly calls greet? main and helper
  const direct = findDirectCallers(g, "src.a.greet");
  assert.equal(direct.length, 2);
  const directNames = direct.map((c) => c.key).sort();
  assert.deepEqual(directNames, ["src.a.helper", "src.a.main"]);

  // nothing calls main (entrypoint), so indirect callers of main's callers is empty
  const indirect = findIndirectCallers(g, ["src.a.main"]);
  assert.equal(indirect.length, 0);

  // indirect callers of greet's direct callers (main, helper): none, they're roots
  const indirect2 = findIndirectCallers(g, ["src.a.main", "src.a.helper"]);
  assert.equal(indirect2.length, 0);

  // calling findIndirectCallers with greet itself finds greet's direct callers
  const indirect3 = findIndirectCallers(g, ["src.a.greet"]);
  assert.equal(indirect3.length, 2);
});
