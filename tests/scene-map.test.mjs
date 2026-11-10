import assert from "node:assert/strict";
import test from "node:test";
import { connectionsFor, networkFor } from "../scene-map-graph.js";

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

test("a relationship keeps every distinct shared listing in display order", () => {
  const focus = { key: "artist:focus", kind: "artist", name: "Focus" };
  const venue = { key: "venue:space", kind: "venue", name: "Space" };
  const known = new Map([[focus.key, focus], [venue.key, venue]]);
  const listing = (eventId, day, venueId = "space") => ({
    eventId, title: eventId, start: "2026-11-" + day + "T20:00:00-05:00",
    artistIds: ["focus"], venueId, venue: "Space", explicitQueer: true
  });
  const shared = [
    listing("oldest", "01"), listing("later", "16"), listing("recent", "08"),
    listing("next", "12"), listing("middle", "04")
  ];
  const events = [...shared, shared[0], listing("other-venue", "07", "other")];
  const [link] = connectionsFor(focus, events, known, Date.parse("2026-11-10T12:00:00-05:00"));
  assert.equal(link.count, 5);
  assert.equal(link.upcoming, 2);
  assert.deepEqual(link.events, [shared[3], shared[1], shared[2], shared[4], shared[0]]);
});
