import assert from "node:assert/strict";
import test from "node:test";
import { connectionsFor, networkFor, visibleRelationships } from "../scene-map-graph.js";
import { photoFrame } from "../scene-map-photo-crop.js";

test("artist photo framing moves the circle to keep faces inside it", () => {
  const top = photoFrame(240, 320, [{ xMin: 90, xMax: 147, yMin: 38, yMax: 94 }]);
  assert.deepEqual(top, { x: 0, y: 0, size: 240, width: 240, height: 320 });

  const lower = photoFrame(240, 320, [{ xMin: 65, xMax: 114, yMin: 137, yMax: 192 }]);
  assert.equal(lower.size, 240);
  assert.ok(lower.y > 40);

  const edge = photoFrame(240, 240, [{ xMin: 32, xMax: 87, yMin: 34, yMax: 92 }]);
  assert.ok(edge.size < 240);
  assert.equal(edge.x, 0);

  const wideGroup = [
    { xMin: 0, xMax: 20, yMin: 100, yMax: 130 },
    { xMin: 220, xMax: 240, yMin: 100, yMax: 130 }
  ];
  assert.equal(photoFrame(240, 240, wideGroup), null);
  assert.equal(photoFrame(240, 320, []), null);
});

test("desktop and mobile keep the strongest direct connections within their bubble limits", () => {
  const origin = { key: "artist:focus", kind: "artist" };
  const strongest = [19, 9, 8, 7, 6, 5, 4, 4].map((count, index) => ({
    key: "artist:co-bill-" + index, kind: "artist", count
  }));
  const previous = [
    { key: "party:arrival", kind: "party", count: 3 },
    ...Array.from({ length: 8 }, (_, index) => ({
      key: "artist:previous-" + index, kind: "artist", count: 1
    }))
  ];
  const branches = new Map(strongest.map((link, index) => [link.key, {
    links: [{ key: "venue:outer-" + index, kind: "venue", count: 1 }], limit: 1
  }]));
  branches.set(origin.key, { links: [...strongest, ...previous], preferred: previous.map(link => link.key) });

  for (const limits of [{ total: 16, direct: 11, context: 3 }, { total: 10, direct: 7, context: 2 }]) {
    const graph = networkFor(origin, branches, () => true, limits);
    const direct = [...graph.values()].filter(vertex => vertex.depth === 1);
    const expected = [...strongest.slice(0, limits.direct - limits.context), ...previous.slice(0, limits.context)];
    assert.equal(graph.size, limits.total);
    assert.deepEqual(direct.map(vertex => vertex.item), expected);
    assert.ok(direct.every(vertex => vertex.parent === origin.key));
  }
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

test("only declared profile associations are flagged, even when a guest shares more events", () => {
  const party = { key: "party:night", kind: "party", name: "Night", related: [
    { kind: "artist", id: "resident" }, { kind: "collective", id: "crew" }, { kind: "artist", id: "private" }
  ] };
  const resident = { key: "artist:resident", kind: "artist", name: "Resident" };
  const guest = { key: "artist:guest", kind: "artist", name: "Guest" };
  const crew = { key: "collective:crew", kind: "collective", name: "Crew" };
  const venue = { key: "venue:space", kind: "venue", name: "Space" };
  const known = new Map([party, resident, guest, crew, venue].map(profile => [profile.key, profile]));
  const events = [
    { eventId: "one", partyId: "night", artistIds: ["resident", "guest"], venueId: "space" },
    { eventId: "two", partyId: "night", artistIds: ["guest"] }
  ];

  const links = connectionsFor(party, events, known);
  assert.deepEqual(links.map(link => [link.key, link.count, Boolean(link.associated)]), [
    [guest.key, 2, false], [resident.key, 1, true], [venue.key, 1, false], [crew.key, 0, true]
  ]);
  const branches = new Map([[party.key, { links }]]);
  const graph = networkFor(party, branches, () => true, { total: 4, direct: 3, context: 3 });
  assert.ok(graph.has(crew.key));
});

test("a declaration from either endpoint flags the existing edge without losing shared events", () => {
  const party = { key: "party:night", kind: "party", name: "Night" };
  const artist = { key: "artist:resident", kind: "artist", name: "Resident",
    related: [{ kind: "party", id: "night" }] };
  const event = { eventId: "one", partyId: "night", artistIds: ["resident"] };
  const known = new Map([[party.key, party], [artist.key, artist]]);
  const branches = new Map([[party.key, { links: connectionsFor(party, [event], known) }]]);
  const graph = networkFor(party, branches, () => true, { total: 16, direct: 11, context: 3 });
  assert.equal([...visibleRelationships(graph, branches).values()][0].associated, false);

  branches.set(artist.key, { links: connectionsFor(artist, [event], known), limit: 0 });
  const [edge] = visibleRelationships(graph, branches).values();
  assert.equal(edge.associated, true);
  assert.deepEqual(edge.link.events, [event]);
});
