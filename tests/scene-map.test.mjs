import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { connectionsFor, networkFor, visibleRelationships } from "../scene-map-graph.js";

function searchFixture() {
  const source = readFileSync(new URL("../scene-map.js", import.meta.url), "utf8");
  const start = source.indexOf("function search(map)");
  const end = source.indexOf("function checkbox(", start);
  assert.ok(start >= 0 && end > start);
  const artist = { key: "artist:focus", kind: "artist", name: "Focus" };
  const selections = [];
  const outside = {};
  const top = new EventTarget(), root = new EventTarget();
  const input = Object.assign(new EventTarget(), {
    value: "focus", blur() { this.blurred = true; }
  });
  const results = Object.assign(new EventTarget(), {
    children: [], scrollTop: 0,
    replaceChildren() { this.children = []; },
    append(button) { this.children.push(button); },
    contains(button) { return this.children.includes(button); }
  });
  top.contains = target => target === input || results.contains(target);
  const map = { search: input, results, root, searchOpen: false };
  runInNewContext(source.slice(start, end) + "\nbindSearch(map, top);", {
    top, map, known: new Map([[artist.key, artist]]), matchesQueerFilter: () => true,
    node: () => ({ append() {}, click() { this.onclick(); } }),
    typePill: () => ({}), startScene: (current, item) => selections.push(item.key)
  });
  input.dispatchEvent(new Event("focus"));
  const [result] = results.children;
  assert.ok(result);
  function emit(element, type, attributes) {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries(attributes)) Object.defineProperty(event, key, { value });
    element.dispatchEvent(event);
    return event;
  }
  const touch = (type, { x = 0, y = 0, remaining = Number(type !== "touchend") } = {}) => {
    const contact = { identifier: 1, clientX: x, clientY: y };
    return emit(results, type, {
      target: { closest: () => result }, changedTouches: [contact], touches: Array(remaining).fill(contact)
    });
  };
  return { map, input, results, result, outside, top, root, selections, emit, touch };
}

test("a tap selects a search result even if the field blurs and the browser skips click", () => {
  const f = searchFixture();
  f.touch("touchstart");
  for (const relatedTarget of [null, f.outside]) f.emit(f.top, "focusout", { relatedTarget });
  assert.equal(f.map.searchOpen, true);
  assert.equal(f.touch("touchend", { x: 2, y: 3 }).defaultPrevented, true);
  assert.deepEqual(f.selections, ["artist:focus"]);
  assert.equal(f.input.value, "");
  assert.equal(f.input.blurred, true);
  assert.equal(f.map.searchOpen, false);
  assert.equal(f.results.children.length, 0);
  f.result.click();
  assert.deepEqual(f.selections, ["artist:focus"]);
});

test("scrolling and canceling a touch leave the search results open", () => {
  for (const finishGesture of [
    f => f.touch("touchmove", { y: 30 }),
    f => { f.results.scrollTop += 25; },
    f => f.touch("touchcancel"),
    f => f.touch("touchstart", { remaining: 2 })
  ]) {
    const f = searchFixture();
    f.touch("touchstart");
    finishGesture(f);
    assert.equal(f.touch("touchend").defaultPrevented, false);
    assert.deepEqual(f.selections, []);
    assert.equal(f.map.searchOpen, true);
    f.result.click();
    assert.deepEqual(f.selections, ["artist:focus"]);
  }
});

test("the dropdown stays open during internal focus and closes on outside focus or press", () => {
  const f = searchFixture();
  for (const relatedTarget of [null, f.result]) {
    f.emit(f.top, "focusout", { relatedTarget });
    assert.equal(f.map.searchOpen, true);
  }
  f.emit(f.top, "focusout", { relatedTarget: f.outside });
  assert.equal(f.map.searchOpen, false);

  f.input.dispatchEvent(new Event("focus"));
  f.emit(f.root, "pointerdown", { target: f.input });
  assert.equal(f.map.searchOpen, true);
  f.emit(f.root, "pointerdown", { target: f.outside });
  assert.equal(f.map.searchOpen, false);
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
