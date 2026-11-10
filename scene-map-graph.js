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

export function connects(kindA, kindB) {
  // Co-appearing artist IDs never establish a social or collaborative
  // relationship. Only different entity types are connected by a shared
  // published event: artist–party, artist–venue, party–venue, etc.
  return kindA !== kindB;
}

export function prominence(item) {
  // Not popularity or a subjective "importance" score. Size reflects
  // repeated appearances together, with a smaller contribution from
  // each entity's documented overall activity in the public directory.
  const shared = Math.max(0, Number(item.count) || 0);
  const history = Math.max(0, Number(item.profileCount) || 0);
  return Math.min(1, (Math.log2(shared + 1) * 0.75 +
    Math.log2(history + 1) * 0.25) / 5.5);
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
      if (!connects(focus.kind, target.kind)) continue;
      let link = found.get(member);
      if (!link) {
        link = { ...target, key: member, profileCount: target.count, count: 0, upcoming: 0,
          recent: 0, examples: [] };
        found.set(member, link);
      }
      link.count++;
      const start = Date.parse(event.start);
      if (Number.isFinite(start)) {
        link.recent = Math.max(link.recent, start);
        if (start >= now) link.upcoming++;
      }
      if (link.examples.length < 3) {
        link.examples.push({ id: event.eventId, title: event.title || "Event",
          start: event.start || "" });
      }
    }
  }
  return [...found.values()].sort((a, b) =>
    b.count - a.count || b.upcoming - a.upcoming ||
    b.recent - a.recent || a.name.localeCompare(b.name));
}

export function pickConnections(connections, limit = 12, previousKey = "") {
  const result = [];
  const used = new Set();
  const add = item => {
    if (item && !used.has(item.key) && result.length < limit) {
      result.push(item); used.add(item.key);
    }
  };
  if (previousKey) add(connections.find(item => item.key === previousKey));
  // Put different corners of the scene in view instead of letting a huge
  // venue or a frequently billed artist crowd out everything else.
  for (const kind of ["artist", "party", "venue", "collective"]) {
    add(connections.find(item => item.kind === kind));
  }
  for (const item of connections) add(item);
  return result;
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
    "artist+venue": "Performed at",
    "artist+party": "Appeared at",
    "artist+collective": "Appeared on an event with",
    "party+venue": "Hosted at",
    "collective+party": "Appeared together at",
    "collective+venue": "Appeared together at"
  };
  return `${labels[pair] || "Connected through"} ${appearances}`;
}
