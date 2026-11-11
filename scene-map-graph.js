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

export function orderSceneEvents(events, now = Date.now()) {
  return [...events].sort((a, b) => {
    const first = Date.parse(a.start) || 0, second = Date.parse(b.start) || 0;
    return first >= now && second >= now ? first - second : second - first;
  });
}

export function connectionsFor(focus, events, known, now = Date.now()) {
  const found = new Map();
  const connection = key => {
    if (!found.has(key)) {
      found.set(key, { ...known.get(key), key, count: 0, upcoming: 0, recent: 0, events: [] });
    }
    return found.get(key);
  };
  for (const related of focus.related || []) {
    const key = keyOf(related.kind, related.id);
    if (key !== focus.key && known.has(key)) connection(key).associated = true;
  }
  const seenEvents = new Set();
  for (const event of events || []) {
    if (!event || !event.eventId || seenEvents.has(event.eventId)) continue;
    seenEvents.add(event.eventId);
    const members = participants(event);
    if (!members.includes(focus.key)) continue;
    const start = Date.parse(event.start);
    for (const member of members) {
      if (member === focus.key || !known.has(member)) continue;
      const target = known.get(member);
      if (!connects(focus.kind, target.kind, event)) continue;
      const link = connection(member);
      link.count++;
      if (Number.isFinite(start)) {
        link.recent = Math.max(link.recent, start);
        if (start >= now) link.upcoming++;
      }
      link.events.push(event);
    }
  }
  for (const link of found.values()) link.events = orderSceneEvents(link.events, now);
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
  if (!root?.links || !root.limit || maxBubbles <= 1) return nodes;
  const direct = new Map(root.links.map(link => [link.key, link]));
  const ranked = root.links.filter(eligible);
  const directLimit = Math.min(root.limit, maxBubbles - 1);
  // Shared-event counts lead. Use the remaining slots for Index associations and recent context.
  const strongest = ranked.slice(0, Math.max(1, directLimit - 3));
  const associations = ranked.filter(link => link.associated);
  const context = (root.preferred || []).map(key => direct.get(key)).filter(link => link && eligible(link));
  const neighbors = [...new Set([...strongest, ...associations, ...context, ...ranked])].slice(0, directLimit);
  for (const link of neighbors) {
    nodes.set(link.key, { item: link, parent: origin.key, link, depth: 1 });
  }
  for (const neighbor of neighbors) {
    const branch = branches.get(neighbor.key);
    if (!branch?.links || !branch.limit || nodes.size >= maxBubbles) continue;
    const candidates = branch.links.filter(link => !nodes.has(link.key) && !direct.has(link.key) && eligible(link));
    const contextual = candidates.filter(link => link.kind !== neighbor.kind || branch.preferred?.includes(link.key));
    const limit = Math.min(branch.limit, maxBubbles - nodes.size);
    for (const link of pickConnections(contextual.length ? contextual : candidates, limit, branch.preferred)) {
      nodes.set(link.key, { item: link, parent: neighbor.key, link, depth: 2 });
    }
  }
  return nodes;
}

export function visibleRelationships(nodes, branches) {
  const edges = new Map();
  const add = (source, target, link, cross) => {
    const key = source < target ? source + "|" + target : target + "|" + source;
    const edge = edges.get(key);
    if (!edge) edges.set(key, { source, target, link, cross, associated: Boolean(link.associated) });
    else if (link.associated) edge.associated = true;
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
