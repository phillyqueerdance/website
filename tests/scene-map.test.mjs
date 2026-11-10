import assert from "node:assert/strict";
import test from "node:test";
import { networkFor } from "../scene-map-graph.js";

test("the strongest direct connections keep their places when exploring from another bubble", () => {
  const origin = { key: "artist:focus", kind: "artist" };
  const strongest = [19, 9, 5, 4, 4, 4].map((count, index) => ({
    key: "artist:co-bill-" + index, kind: "artist", count
  }));
  const previous = [
    { key: "party:arrival", kind: "party", count: 3 },
    ...Array.from({ length: 8 }, (_, index) => ({
      key: "artist:previous-" + index, kind: "artist", count: 1
    }))
  ];
  const branch = {
    links: [...strongest, ...previous], limit: 9, preferred: previous.map(link => link.key)
  };
  const graph = networkFor(origin, new Map([[origin.key, branch]]), () => true, 14);
  const direct = [...graph.values()].filter(vertex => vertex.depth === 1);
  assert.deepEqual(direct.map(vertex => vertex.item), [...strongest, ...previous.slice(0, 3)]);
  assert.ok(direct.every(vertex => vertex.parent === origin.key));
});
