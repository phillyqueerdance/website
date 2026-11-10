// Pure, public-data-only relationship helpers for the experimental QDP Scene Map.
export const DIRECTORY_FOR = Object.freeze({
  artist: "artists", party: "parties", venue: "venues", collective: "collectives"
});
export const KINDS = Object.keys(DIRECTORY_FOR);
export const keyOf = (kind, id) => `${kind}:${id}`;

export function participants(event) {
  const nodes = [];
  for (const id of Array.isArray(event.artistIds) ? event.artistIds : []) {
    if (id) nodes.push(keyOf("artist", id));
  }
  if (event.partyId) nodes.push(keyOf("party", event.partyId));
  if (event.venueId) nodes.push(keyOf("venue", event.venueId));
  for (const id of Array.isArray(event.collectiveIds) ? event.collectiveIds : []) {
    if (id) nodes.push(keyOf("collective", id));
  }
  return [...new Set(nodes)];
}

export function connects(kindA, kindB, event = {}) {
  if (kindA !== kindB) return true;
  if (kindA !== "artist") return false;
  const { start, end } = event;
  if (!start || !end) return true;
  // A full-day schedule groups separate slots. Artist pairs use individual listings.
  const fullDay = Date.parse(end) - Date.parse(start) >= 24 * 60 * 60 * 1000;
  const midnightToMidnight = start.slice(11, 16) === "00:00" && end.slice(11, 16) === "00:00" &&
    start.slice(0, 10) !== end.slice(0, 10);
  return !fullDay && !midnightToMidnight;
}

export function connectionsFor(focus, events, known, now = Date.now()) {
  const found = new Map();
  const seenEvents = new Set();
  for (const event of events || []) {
    if (!event || !event.eventId || seenEvents.has(event.eventId)) continue;
    seenEvents.add(event.eventId);
    const members = participants(event);
    if (!members.includes(focus.key)) continue;
    for (const member of members) {
      if (member === focus.key || !known.has(member)) continue;
      const target = known.get(member);
      if (!connects(focus.kind, target.kind, event)) continue;
      let link = found.get(member);
      if (!link) {
        link = { ...target, key: member, count: 0, upcoming: 0,
          recent: 0, examples: [] };
        found.set(member, link);
      }
      link.count++;
      const start = Date.parse(event.start);
      if (Number.isFinite(start)) {
        link.recent = Math.max(link.recent, start);
        if (start >= now) link.upcoming++;
      }
      link.examples.push({ id: event.eventId, title: event.title || "Event", start: event.start || "" });
      link.examples.sort((a, b) => {
        const first = Date.parse(a.start) || 0, second = Date.parse(b.start) || 0;
        if (first >= now || second >= now) {
          if (first < now) return 1;
          if (second < now) return -1;
          return first - second;
        }
        return second - first;
      });
      if (link.examples.length > 3) link.examples.pop();
    }
  }
  return [...found.values()].sort((a, b) =>
    b.count - a.count || b.upcoming - a.upcoming ||
    b.recent - a.recent || a.name.localeCompare(b.name));
}

export function pickConnections(connections, limit = 12, preferred = []) {
  const result = [];
  const used = new Set();
  const add = item => {
    if (item && !used.has(item.key) && result.length < limit) {
      result.push(item); used.add(item.key);
    }
  };
  for (const key of preferred) add(connections.find(item => item.key === key));
  // Put different corners of the scene in view instead of letting a huge
  // venue or a frequently billed artist crowd out everything else.
  for (const kind of ["artist", "party", "venue", "collective"]) {
    add(connections.find(item => item.kind === kind));
  }
  for (const item of connections) add(item);
  return result;
}

export function networkFor(origin, branches, eligible, maxBubbles) {
  const nodes = new Map([[origin.key, { item: origin, parent: null, link: null, depth: 0 }]]);
  const root = branches.get(origin.key);
  const direct = new Map((root?.links || []).map(link => [link.key, link]));
  const sharesBill = link => origin.kind === "artist" && link.kind === "artist";
  // Map iteration includes added entries, so direct links are placed before
  // their branches. Each published profile gets one bubble.
  for (const vertex of nodes.values()) {
    const branch = branches.get(vertex.item.key);
    if (vertex.depth >= 2 || !branch?.links || !branch.limit || nodes.size >= maxBubbles) continue;
    const candidates = branch.links.filter(link => !nodes.has(link.key) && eligible(link) &&
      (vertex.depth === 0 || !direct.has(link.key) || sharesBill(link)));
    const contextual = candidates.filter(link => link.kind !== vertex.item.kind || branch.preferred?.includes(link.key));
    const limit = Math.min(branch.limit, maxBubbles - nodes.size);
    for (const link of pickConnections(contextual.length ? contextual : candidates, limit, branch.preferred)) {
      nodes.set(link.key, { item: link, parent: vertex.item.key, link, depth: vertex.depth + 1 });
    }
  }
  // Keep party and venue context in the neighborhood, then promote any
  // visible co-bill to the direct level with its own evidence and weight.
  let firstHop = 0;
  for (const [key, vertex] of nodes) {
    const link = direct.get(key);
    if (!link) continue;
    Object.assign(vertex, { item: link, parent: origin.key, link, depth: 1 });
    firstHop++;
  }
  const available = Math.min((root?.limit || 0) - firstHop, maxBubbles - nodes.size);
  if (available > 0) {
    const more = [...direct.values()].filter(link => sharesBill(link) && eligible(link) && !nodes.has(link.key));
    for (const link of more.slice(0, available)) {
      nodes.set(link.key, { item: link, parent: origin.key, link, depth: 1 });
    }
  }
  return nodes;
}

export function visibleRelationships(nodes, branches) {
  const edges = new Map();
  const add = (source, target, link, cross) => {
    const key = source < target ? source + "|" + target : target + "|" + source;
    if (!edges.has(key)) edges.set(key, { source, target, link, cross });
  };
  // Preserve layout parents first, then add every proven pair among these bubbles.
  for (const [key, vertex] of nodes) {
    if (vertex.parent) add(vertex.parent, key, vertex.link, false);
  }
  for (const key of nodes.keys()) {
    for (const link of branches.get(key)?.links || []) {
      if (nodes.has(link.key)) add(key, link.key, link, true);
    }
  }
  return edges;
}

export function upcomingFor(focus, events, now = Date.now(), max = 5) {
  return [...new Map((events || []).filter(event => event?.eventId &&
    participants(event).includes(focus.key) &&
    Number.isFinite(Date.parse(event.start)) && Date.parse(event.start) >= now)
    .map(event => [event.eventId, event])).values()]
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(0, max);
}

export function relationshipText(source, target) {
  const pair = [source.kind, target.kind].sort().join("+");
  const n = target.count;
  const appearances = `${n} documented ${n === 1 ? "event" : "events"}`;
  const labels = {
    "artist+artist": "Listed together at",
    "artist+venue": "Performed at",
    "artist+party": "Appeared at",
    "artist+collective": "Appeared on an event with",
    "party+venue": "Hosted at",
    "collective+party": "Appeared together at",
    "collective+venue": "Appeared together at"
  };
  return `${labels[pair] || "Connected through"} ${appearances}`;
}
