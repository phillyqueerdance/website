import { DIRECTORY_FOR, KINDS, keyOf, connectionsFor, upcomingFor,
  networkFor, relationshipText } from "./scene-map-graph.js?v=20261110-scene-map-7";
import { relationshipStrength, linkGap, keepInView, settleBubbles, MIN_BUBBLE_HIT_RADIUS,
  SMALL_BUBBLE_LABEL_WIDTH, SMALL_BUBBLE_LABEL_HEIGHT, SMALL_BUBBLE_LABEL_GAP } from "./scene-map-layout.js?v=20261110-scene-map-7";

const NS = "http://www.w3.org/2000/svg";
const labels = { artist: "Artist", party: "Party", venue: "Venue", collective: "Collective" };
const known = new Map(), cache = new Map();
const ROOT_LINKS = 9;
const AUTO_BRANCHES = 4;
const MAX_BUBBLES = 1 + ROOT_LINKS + AUTO_BRANCHES;
const EVENT_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric"
});

function node(tag, className = "", value = "") {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = value;
  return element;
}

function svgNode(tag, attributes = {}, value = "") {
  const element = document.createElementNS(NS, tag);
  for (const [key, attributeValue] of Object.entries(attributes)) element.setAttribute(key, attributeValue);
  element.textContent = value;
  return element;
}

function qdpUrl(item, event = false) {
  const url = new URL("/", location.origin);
  if (event) {
    url.searchParams.set("event", item.eventId || item.id);
  } else {
    url.searchParams.set("archive", item.kind);
    url.searchParams.set("id", item.id);
  }
  return url.href;
}

async function resource(kind, id) {
  const url = new URL("/api/archive", location.origin);
  url.searchParams.set("resource", kind);
  if (id) url.searchParams.set("id", id);
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error("Public archive unavailable (" + response.status + ")");
  return response.json();
}

async function loadDirectories() {
  if (known.size) return;
  const results = await Promise.allSettled(KINDS.map(async kind => {
    const directory = DIRECTORY_FOR[kind];
    const data = await resource(directory);
    for (const profile of data[directory] || []) {
      if (!profile?.id || !profile?.name) continue;
      const profileKey = keyOf(kind, profile.id);
      known.set(profileKey, { ...profile, kind, key: profileKey });
    }
  }));
  if (!known.size) throw new Error("Public directories unavailable");
  if (results.some(result => result.status === "rejected")) {
    console.warn("A QDP directory was unavailable");
  }
}

function profile(item) {
  if (!cache.has(item.key)) {
    cache.set(item.key, resource(item.kind, item.id).then(data => {
      if (!data.profile || !Array.isArray(data.events)) throw new Error("Invalid profile");
      return data;
    }).catch(error => {
      cache.delete(item.key);
      throw error;
    }));
  }
  return cache.get(item.key);
}

function isQueer(item) {
  return window.QDPProfileMetadata.isQueer(item.kind, item) ||
    (item.kind === "artist" && item.transArtist === true);
}

function matchesQueerFilter(map, item) {
  return !map.queerOnly || isQueer(item);
}

function visibleConnection(map, item) {
  return map.allowed.has(item.kind) && matchesQueerFilter(map, item);
}

function typePill(kind) {
  const pill = node("span", "scene-map-pill", labels[kind]);
  pill.dataset.kind = kind;
  return pill;
}

function anchor(text, url) {
  const link = node("a", "scene-map-link", text);
  link.href = url;
  link.dataset.archiveLink = "";
  return link;
}

function setMessage(map, text) {
  map.message.textContent = text;
  map.message.hidden = !text;
}

function sharedEvents(count) {
  return count + (count === 1 ? " shared event" : " shared events");
}

function closeDetails(map) {
  map.info.hidden = true;
  map.svg.querySelector(".scene-map-node.focus")?.setAttribute("aria-expanded", "false");
}

function toggleDetails(map, bubble) {
  closeRelationship(map);
  if (!map.info.hidden) {
    closeDetails(map);
    return;
  }
  const item = bubble.item;
  const heading = node("div", "scene-map-detail-heading");
  const close = node("button", "scene-map-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close profile details");
  close.onclick = () => {
    closeDetails(map);
    bubble.element.focus();
  };
  heading.append(node("strong", "", item.name), typePill(item.kind), close);
  map.info.replaceChildren(heading);

  const branch = map.scene.branches.get(item.key);
  const arrival = branch?.links?.find(link => link.key === map.scene.arrival && visibleConnection(map, link));
  if (arrival) {
    map.info.append(node("p", "scene-map-note", arrival.name + " · " + relationshipText(item, arrival)));
    for (const event of arrival.examples.slice(0, 2)) {
      map.info.append(anchor(event.title, qdpUrl({ id: event.id }, true)));
    }
  }
  const events = branch?.events;
  if (events) {
    const upcoming = upcomingFor(item, events, Date.now(), 2);
    for (const event of upcoming) map.info.append(anchor("Upcoming: " + event.title, qdpUrl(event, true)));
    if (!upcoming.length) map.info.append(node("p", "scene-map-note", "No upcoming events listed here."));
  }
  map.info.append(anchor("View QDP profile", qdpUrl(item)));
  map.info.hidden = false;
  bubble.element.setAttribute("aria-expanded", "true");
}

function closeRelationship(map) {
  clearTimeout(map.lineTimer);
  if (map.activeLine) map.activeLine.control.setAttribute("aria-expanded", "false");
  map.activeLine = null;
  map.linePinned = false;
  map.lineInfo.hidden = true;
}

function scheduleRelationshipClose(map, line) {
  if (!line || map.activeLine !== line || map.linePinned) return;
  clearTimeout(map.lineTimer);
  map.lineTimer = setTimeout(() => {
    if (map.activeLine === line && !map.linePinned) closeRelationship(map);
  }, 240);
}

function positionRelationship(map) {
  const line = map.activeLine;
  if (!line) return;
  const popup = map.lineInfo;
  const x = line.midX + map.dx, y = line.midY + map.dy;
  const margin = 8, gap = 14;
  const width = popup.offsetWidth, height = popup.offsetHeight;
  const left = Math.max(margin, Math.min(map.width - width - margin, x - width / 2));
  const preferredTop = y + gap + height <= map.height - margin ? y + gap : y - gap - height;
  const top = Math.max(margin, Math.min(map.height - height - margin, preferredTop));
  popup.style.left = left + "px";
  popup.style.top = top + "px";
}

function showRelationship(map, line, pin = false) {
  clearTimeout(map.lineTimer);
  if (map.activeLine === line) {
    map.linePinned ||= pin;
    return;
  }
  closeRelationship(map);
  closeDetails(map);
  map.activeLine = line;
  map.linePinned = pin;
  line.control.setAttribute("aria-expanded", "true");

  const heading = node("div", "scene-map-detail-heading");
  const close = node("button", "scene-map-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close relationship details");
  close.onclick = () => {
    closeRelationship(map);
    line.control.focus();
  };
  heading.append(node("strong", "", line.parent.item.name + " · " + line.child.item.name), close);
  const link = line.child.link;
  const count = sharedEvents(link.count) + (link.upcoming ? " · " + link.upcoming + " upcoming" : "");
  const events = node("div", "scene-map-relationship-events");
  for (const event of link.examples) {
    const example = anchor(event.title, qdpUrl({ id: event.id }, true));
    const start = Date.parse(event.start);
    if (Number.isFinite(start)) {
      const date = (start >= Date.now() ? "Upcoming · " : "") + EVENT_DATE.format(start);
      example.append(node("span", "scene-map-relationship-date", date));
    }
    events.append(example);
  }
  map.lineInfo.replaceChildren(heading, node("p", "scene-map-note", count), events);
  map.lineInfo.hidden = false;
  positionRelationship(map);
}

function toggleRelationship(map, line, keyboard = false) {
  if (map.activeLine === line && map.linePinned) {
    closeRelationship(map);
    return;
  }
  showRelationship(map, line, true);
  if (keyboard) map.lineInfo.querySelector("button")?.focus();
}

function createLine(map, parent, child) {
  const control = svgNode("g", {
    class: "scene-map-edge-control", role: "button", tabindex: "0",
    "aria-label": parent.item.name + " and " + child.item.name + ", " + sharedEvents(child.link.count),
    "aria-controls": map.lineInfo.id, "aria-expanded": "false"
  });
  const element = svgNode("line", {
    class: "scene-map-edge", "data-depth": child.depth,
    "stroke-width": 1.6 + relationshipStrength(child.link.count) * 4
  });
  const hit = svgNode("line", { class: "scene-map-edge-hit", "aria-hidden": "true" });
  control.append(element, hit);
  const line = { control, element, hit, parent, child, midX: 0, midY: 0 };
  control.addEventListener("pointerenter", event => {
    if (event.pointerType !== "touch" && !map.svg.classList.contains("is-dragging")) showRelationship(map, line);
  });
  control.addEventListener("pointerleave", () => scheduleRelationshipClose(map, line));
  control.addEventListener("click", event => {
    if (!map.skipClick || event.detail === 0) toggleRelationship(map, line, event.detail === 0);
  });
  control.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleRelationship(map, line, true);
    }
  });
  return line;
}

function bindRelationshipDetails(map) {
  map.lineInfo.addEventListener("pointerenter", () => clearTimeout(map.lineTimer));
  map.lineInfo.addEventListener("pointerleave", () => scheduleRelationshipClose(map, map.activeLine));
  map.root.addEventListener("pointerdown", event => {
    if (map.activeLine && !map.lineInfo.contains(event.target) && !event.target.closest(".scene-map-edge-control")) {
      closeRelationship(map);
    }
  });
  map.root.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !map.activeLine) return;
    const restore = map.lineInfo.contains(document.activeElement) ? map.activeLine.control : null;
    closeRelationship(map);
    restore?.focus();
    event.stopPropagation();
    event.preventDefault();
  });
}

function createBubble(map, item) {
  const element = svgNode("g", {
    class: "scene-map-node", "data-kind": item.kind, "data-key": item.key, role: "button", tabindex: "0"
  });
  const title = svgNode("title");
  const circle = svgNode("circle", { class: "scene-map-node-disc" });
  const hit = svgNode("circle", { class: "scene-map-node-hit", "aria-hidden": "true" });
  const caption = svgNode("foreignObject", { class: "scene-map-caption", "aria-hidden": "true" });
  const captionBody = node("div", "scene-map-caption-body");
  captionBody.append(node("span", "scene-map-caption-name", item.name));
  caption.append(captionBody);
  element.append(title, circle, hit, caption);
  const bubble = { item, element, title, circle, hit, caption, captionBody, phase: map.phase++ * 1.7 };
  element.addEventListener("click", event => {
    if (!map.skipClick || event.detail === 0) activateBubble(map, bubble);
  });
  element.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateBubble(map, bubble);
    }
  });
  element.addEventListener("pointerenter", () => { map.hovered = bubble; });
  element.addEventListener("pointerleave", () => {
    if (map.hovered === bubble) map.hovered = null;
  });
  map.nodeLayer.append(element);
  return bubble;
}

function updateBubbles(map) {
  for (const bubble of map.bubbles.values()) {
    const { item, element, link } = bubble;
    const isSelected = bubble.depth === 0;
    const parent = map.bubbles.get(bubble.parent);
    const count = link ? sharedEvents(link.count) : "";
    const description = parent ? count + " with " + parent.item.name : count;
    element.classList.toggle("focus", isSelected);
    element.setAttribute("data-depth", bubble.depth);
    element.setAttribute("aria-label", (isSelected ? "Details for " : "Explore ") + item.name);
    element.setAttribute("aria-description", description);
    if (isSelected) element.setAttribute("aria-expanded", String(!map.info.hidden));
    else element.removeAttribute("aria-expanded");
    bubble.title.textContent = [item.name, labels[item.kind], description].filter(Boolean).join(" · ");
  }
  historyPath(map);
}

function resizeBubble(bubble, shortSide, maxDirect, maxIndirect) {
  // Circle area encodes the count, with a smaller scale for second-degree links.
  const indirect = bubble.depth === 2;
  const scale = indirect ? .82 / Math.sqrt(Math.max(maxDirect, maxIndirect)) : 1 / Math.sqrt(maxDirect);
  bubble.radius = bubble.link ? shortSide * .116 * Math.sqrt(bubble.link.count) * scale : shortSide * .148;
  bubble.labelOutside = bubble.radius < 22;
  if (bubble.drawRadius === undefined) paintRadius(bubble, bubble.radius);
}

function paintRadius(bubble, radius) {
  bubble.drawRadius = radius;
  bubble.circle.setAttribute("r", radius);
  bubble.hit.setAttribute("r", Math.max(radius, MIN_BUBBLE_HIT_RADIUS));
  const outside = radius < 22;
  const width = outside ? SMALL_BUBBLE_LABEL_WIDTH : radius * 1.76;
  bubble.caption.setAttribute("data-outside", outside);
  bubble.caption.setAttribute("x", -width / 2);
  bubble.caption.setAttribute("y", outside ? radius + SMALL_BUBBLE_LABEL_GAP : -radius * .68);
  bubble.caption.setAttribute("width", width);
  bubble.caption.setAttribute("height", outside ? SMALL_BUBBLE_LABEL_HEIGHT : radius * 1.36);
  bubble.captionBody.style.fontSize = Math.max(11, Math.min(25, radius * .39)) + "px";
}

function positionNewBubbles(map) {
  const siblings = new Map();
  for (const bubble of map.bubbles.values()) {
    if (!siblings.has(bubble.parent)) siblings.set(bubble.parent, []);
    siblings.get(bubble.parent).push(bubble);
  }
  for (const [parentKey, group] of siblings) {
    const parent = map.bubbles.get(parentKey);
    const grandparent = parent && map.bubbles.get(parent.parent);
    const alternatingSlots = Math.ceil(group.length / 2);
    const branchAngle = grandparent
      ? Math.atan2(parent.targetY - grandparent.targetY, parent.targetX - grandparent.targetX)
      : -Math.PI / 2;
    for (const [index, bubble] of group.entries()) {
      if (Number.isFinite(bubble.targetX)) continue;
      if (!parent) {
        bubble.targetX = map.width / 2;
        bubble.targetY = map.height / 2;
        bubble.x ??= bubble.targetX;
        bubble.y ??= bubble.targetY;
        continue;
      }
      // The first links get second-level branches. Space them around the ring.
      const slot = index < alternatingSlots ? index * 2 : (index - alternatingSlots) * 2 + 1;
      const angle = grandparent
        ? branchAngle + (index - (group.length - 1) / 2) * .82
        : branchAngle + 2 * Math.PI * slot / group.length;
      const distance = bubble.radius + parent.radius + linkGap(map.width, map.height);
      const horizontal = Math.max(1, Math.min(1.25, map.width / map.height));
      bubble.targetX = parent.targetX + Math.cos(angle) * distance * horizontal;
      bubble.targetY = parent.targetY + Math.sin(angle) * distance;
      keepInView(bubble, map.width, map.height);
      bubble.x ??= parent.x + (bubble.targetX - parent.x) * .66;
      bubble.y ??= parent.y + (bubble.targetY - parent.y) * .66;
    }
  }
}

function paintGraph(map, time) {
  if (!map.width || !map.height) return;
  for (const bubble of map.bubbles.values()) {
    if (map.reduceMotion.matches) {
      bubble.x = bubble.targetX;
      bubble.y = bubble.targetY;
      if (bubble.drawRadius !== bubble.radius) paintRadius(bubble, bubble.radius);
    } else if (time !== undefined && bubble !== map.dragged) {
      const steady = bubble.depth === 0 || bubble === map.hovered || bubble.element === document.activeElement ||
        bubble === map.activeLine?.parent || bubble === map.activeLine?.child;
      const float = steady ? 0 : 4;
      const x = bubble.targetX + float * Math.sin(time / 1600 + bubble.phase);
      const y = bubble.targetY + float * Math.cos(time / 1900 + bubble.phase);
      bubble.x += (x - bubble.x) * .16;
      bubble.y += (y - bubble.y) * .16;
      if (bubble.drawRadius !== bubble.radius) {
        const change = bubble.radius - bubble.drawRadius;
        paintRadius(bubble, Math.abs(change) < .2 ? bubble.radius : bubble.drawRadius + change * .16);
      }
    }
    bubble.element.setAttribute("transform", "translate(" + bubble.x.toFixed(2) + " " + bubble.y.toFixed(2) + ")");
  }
  for (const line of map.lines) {
    const { element, hit, parent, child } = line;
    const dx = child.x - parent.x, dy = child.y - parent.y;
    const distance = Math.hypot(dx, dy) || 1;
    const trim = Math.max(0, Math.min(3, (distance - parent.drawRadius - child.drawRadius) / 2));
    const start = (parent.drawRadius + trim) / distance, end = (child.drawRadius + trim) / distance;
    const x1 = parent.x + dx * start, y1 = parent.y + dy * start;
    const x2 = child.x - dx * end, y2 = child.y - dy * end;
    line.midX = (x1 + x2) / 2;
    line.midY = (y1 + y2) / 2;
    for (const stroke of [element, hit]) {
      stroke.setAttribute("x1", x1);
      stroke.setAttribute("y1", y1);
      stroke.setAttribute("x2", x2);
      stroke.setAttribute("y2", y2);
    }
  }
}

function animateGraph(map) {
  if (map.frameRequest || map.reduceMotion.matches || !map.width || !map.height || !map.bubbles.size) return;
  const tick = time => {
    map.frameRequest = 0;
    if (!map.root.isConnected || !map.width || !map.height || !map.bubbles.size) return;
    paintGraph(map, time);
    if (!map.reduceMotion.matches) map.frameRequest = requestAnimationFrame(tick);
  };
  map.frameRequest = requestAnimationFrame(tick);
}

function layoutGraph(map, recenter = false) {
  const width = map.wrap.clientWidth, height = map.wrap.clientHeight;
  if (!width || !height) {
    cancelAnimationFrame(map.frameRequest);
    map.frameRequest = 0;
    return;
  }
  map.svg.setAttribute("viewBox", "0 0 " + width + " " + height);
  const scaleX = width / (map.width || width), scaleY = height / (map.height || height);
  const maxCounts = [1, 1, 1];
  for (const bubble of map.bubbles.values()) {
    if (bubble.link) maxCounts[bubble.depth] = Math.max(maxCounts[bubble.depth], bubble.link.count);
  }
  for (const bubble of map.bubbles.values()) {
    resizeBubble(bubble, Math.min(width, height), maxCounts[1], maxCounts[2]);
    if (Number.isFinite(bubble.x)) {
      bubble.x *= scaleX;
      bubble.y *= scaleY;
      bubble.targetX = recenter ? undefined : bubble.targetX * scaleX;
      bubble.targetY = recenter ? undefined : bubble.targetY * scaleY;
    }
  }
  map.width = width;
  map.height = height;
  positionNewBubbles(map);
  settleBubbles(map.bubbles, width, height, map.dragged);
  paintGraph(map);
  positionRelationship(map);
  animateGraph(map);
}

function buildNetwork(map, scene) {
  return networkFor(scene.origin, scene.branches, item => visibleConnection(map, item), MAX_BUBBLES);
}

function renderMap(map, recenter = false) {
  closeRelationship(map);
  const scene = map.scene;
  const network = scene ? buildNetwork(map, scene) : new Map();
  const bubbles = new Map();
  for (const [key, vertex] of network) {
    const bubble = map.bubbles.get(key) || createBubble(map, vertex.item);
    Object.assign(bubble, vertex);
    bubbles.set(key, bubble);
  }
  for (const [key, bubble] of map.bubbles) {
    if (!bubbles.has(key)) bubble.element.remove();
  }
  map.bubbles = bubbles;
  map.lines = [];
  for (const child of bubbles.values()) {
    const parent = bubbles.get(child.parent);
    if (!parent) continue;
    map.lines.push(createLine(map, parent, child));
  }
  map.edgeLayer.replaceChildren(...map.lines.map(line => line.control));
  updateBubbles(map);
  layoutGraph(map, recenter);
  if (map.pendingScene && map.pendingScene !== scene) setMessage(map, "Loading " + map.pendingScene.origin.name + "…");
  else if (!scene) setMessage(map, "Search for something you know to begin.");
  else if (!scene.branches.get(scene.origin.key)?.events) setMessage(map, "Loading " + scene.origin.name + "…");
  else setMessage(map, bubbles.size > 1 ? "" : "No connections match these filters.");
}

function historyPath(map) {
  const path = map.scene?.trail.filter(item => matchesQueerFilter(map, item)) || [];
  map.crumbs.replaceChildren();
  for (const [index, item] of path.entries()) {
    if (index) map.crumbs.append(node("span", "", "›"));
    const button = node("button", "", item.name);
    button.type = "button";
    button.onclick = () => {
      const bubble = map.bubbles.get(item.key);
      if (bubble) activateBubble(map, bubble);
      else void startScene(map, item, true);
    };
    map.crumbs.append(button);
  }
  map.crumbs.hidden = !path.length;
}

async function loadBranch(scene, item, limit) {
  if (!scene.branches.has(item.key)) {
    scene.branches.set(item.key, { limit, preferred: scene.preferred.get(item.key) });
  }
  const branch = scene.branches.get(item.key);
  if (branch.links) return;
  const data = await profile(item);
  if (!branch.links) {
    branch.events = data.events;
    branch.links = connectionsFor(item, data.events, known);
  }
}

async function addSecondHop(map, scene) {
  const direct = [...buildNetwork(map, scene).values()].filter(vertex => vertex.depth === 1);
  const first = direct.slice(0, AUTO_BRANCHES);
  await Promise.allSettled(first.map(vertex => loadBranch(scene, vertex.item, 1)));
  if (!map.root.isConnected || (map.scene !== scene && map.pendingScene !== scene)) return;
  const current = [...buildNetwork(map, scene).values()];
  if (current.some(vertex => vertex.depth === 2)) return;
  const rest = current.filter(vertex => vertex.depth === 1 && !first.some(seen => seen.item.key === vertex.item.key));
  await Promise.allSettled(rest.map(vertex => loadBranch(scene, vertex.item, 1)));
}

async function startScene(map, item, exploring = false) {
  if (!matchesQueerFilter(map, item) || map.pendingScene?.origin.key === item.key) return;
  const previous = exploring ? map.scene : null;
  const previousKey = previous?.origin.key;
  const arrival = previous && (map.bubbles.get(item.key)?.parent || previousKey);
  const preferred = new Map();
  if (previousKey) {
    const visible = [...map.bubbles.values()];
    const children = visible.filter(bubble => bubble.parent === item.key);
    const formerPeers = visible.filter(bubble => bubble.parent === previousKey && bubble.item.key !== item.key);
    preferred.set(item.key, [previousKey, arrival, ...children.map(bubble => bubble.item.key)]);
    preferred.set(previousKey, formerPeers.map(bubble => bubble.item.key));
    if (arrival !== previousKey) preferred.set(arrival, [previousKey]);
  }
  const trail = previous?.trail || [];
  const back = trail.findIndex(profile => profile.key === item.key);
  const scene = { origin: item, arrival, preferred, branches: new Map(),
    trail: back < 0 ? [...trail, item].slice(-6) : trail.slice(0, back + 1) };
  map.pendingScene = scene;
  closeRelationship(map);
  closeDetails(map);
  setMessage(map, "Loading " + item.name + "…");
  if (!map.scene) {
    map.scene = scene;
    renderMap(map);
  }
  try {
    await loadBranch(scene, item, ROOT_LINKS);
    if (!map.root.isConnected || map.pendingScene !== scene) return;
    if (map.scene === scene) renderMap(map);
    await addSecondHop(map, scene);
    if (!map.root.isConnected || map.pendingScene !== scene) return;
    map.pendingScene = null;
    if (map.scene === scene) {
      renderMap(map);
      return;
    }
    // Preserve current screen positions while the new center animates in.
    for (const bubble of map.bubbles.values()) {
      if (!Number.isFinite(bubble.x)) continue;
      bubble.x += map.dx;
      bubble.y += map.dy;
    }
    map.dx = map.dy = 0;
    map.dragged = null;
    map.graph.removeAttribute("transform");
    map.scene = scene;
    closeDetails(map);
    renderMap(map, true);
  } catch (error) {
    if (map.root.isConnected && map.pendingScene === scene) {
      map.pendingScene = null;
      setMessage(map, error.message);
    }
  }
}

function activateBubble(map, bubble) {
  if (!map.scene || map.bubbles.get(bubble.item.key) !== bubble) return;
  if (bubble.depth === 0) toggleDetails(map, bubble);
  else void startScene(map, bubble.item, true);
}

function search(map) {
  const query = map.search.value.toLocaleLowerCase().trim();
  map.results.replaceChildren();
  if (!query || map.search.disabled) return;
  const rank = item => item.name.toLocaleLowerCase().startsWith(query) ? 0 : 1;
  const found = [...known.values()].filter(item =>
    matchesQueerFilter(map, item) && item.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, 7);

  if (!found.length) map.results.append(node("p", "scene-map-note", "No matching profiles."));
  for (const item of found) {
    const button = node("button", "scene-map-result");
    button.type = "button";
    button.append(node("span", "scene-map-result-name", item.name), typePill(item.kind));
    button.onclick = () => {
      map.search.value = "";
      map.results.replaceChildren();
      startScene(map, item);
    };
    map.results.append(button);
  }
}

function checkbox(text, value, checked) {
  const label = node("label", "scene-map-filter");
  const input = node("input");
  input.type = "checkbox";
  input.value = value;
  input.checked = checked;
  label.append(input, node("span", "", text));
  return label;
}

function bindDrag(map) {
  let gesture = null;
  map.svg.addEventListener("pointerdown", event => {
    if (!map.bubbles.size || event.button !== 0 || gesture) return;
    const key = event.target.closest(".scene-map-node")?.getAttribute("data-key");
    const bubble = map.bubbles.get(key);
    map.skipClick = false;
    gesture = {
      pointerId: event.pointerId, scene: map.scene, bubble, startX: event.clientX, startY: event.clientY,
      x: bubble?.x ?? map.dx, y: bubble?.y ?? map.dy, moved: false
    };
  });
  map.svg.addEventListener("pointermove", event => {
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.scene !== map.scene) return;
    const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY;
    if (!gesture.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      gesture.moved = true;
      map.skipClick = true;
      closeRelationship(map);
      map.dragged = gesture.bubble;
      map.svg.setPointerCapture(event.pointerId);
      map.svg.classList.add("is-dragging");
    }
    const bubble = gesture.bubble;
    if (bubble) {
      bubble.targetX = gesture.x + dx;
      bubble.targetY = gesture.y + dy;
      keepInView(bubble, map.width, map.height);
      bubble.x = bubble.targetX;
      bubble.y = bubble.targetY;
      paintGraph(map);
    } else {
      const limitX = map.width * .4, limitY = map.height * .4;
      map.dx = Math.max(-limitX, Math.min(limitX, gesture.x + dx));
      map.dy = Math.max(-limitY, Math.min(limitY, gesture.y + dy));
      map.graph.setAttribute("transform", "translate(" + map.dx + " " + map.dy + ")");
    }
  });
  const finish = event => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const bubble = map.dragged;
    gesture = null;
    map.dragged = null;
    map.svg.classList.remove("is-dragging");
    if (bubble && map.bubbles.get(bubble.item.key) === bubble) {
      settleBubbles(map.bubbles, map.width, map.height, bubble);
      paintGraph(map);
    }
  };
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) {
    map.svg.addEventListener(event, finish);
  }
  map.svg.addEventListener("pointerleave", event => {
    if (!gesture?.moved) finish(event);
  });
}

export async function mountSceneMap(host) {
  const root = node("section", "scene-map-view");
  const top = node("div", "scene-map-top");
  const input = node("input", "scene-map-search");
  input.type = "search";
  input.placeholder = "Search the scene…";
  input.disabled = true;
  input.setAttribute("aria-label", "Search artists, parties, venues and collectives");
  const results = node("div", "scene-map-results");
  const filters = node("div", "scene-map-filters");
  top.append(input, filters, results);
  for (const kind of KINDS) {
    const directory = DIRECTORY_FOR[kind];
    const label = checkbox(directory[0].toUpperCase() + directory.slice(1), kind, true);
    label.dataset.kind = kind;
    filters.append(label);
  }
  const queerLabel = checkbox("Queer only", "queer", false);
  queerLabel.classList.add("scene-map-filter-queer");
  filters.append(queerLabel);
  const queerToggle = queerLabel.querySelector("input");
  const crumbs = node("nav", "scene-map-path");
  crumbs.setAttribute("aria-label", "Exploration path");
  crumbs.hidden = true;
  const wrap = node("div", "scene-map-canvas-wrap");
  const svg = svgNode("svg", { class: "scene-map-canvas", role: "group", "aria-label": "Scene connections" });
  const graph = svgNode("g"), edgeLayer = svgNode("g"), nodeLayer = svgNode("g");
  graph.append(edgeLayer, nodeLayer);
  svg.append(graph);
  const message = node("p", "scene-map-message", "Loading public QDP directory…");
  message.setAttribute("role", "status");
  const info = node("section", "scene-map-detail");
  info.hidden = true;
  info.setAttribute("aria-label", "Profile details");
  const lineInfo = node("section", "scene-map-detail scene-map-relationship");
  lineInfo.id = "scene-map-relationship-details";
  lineInfo.hidden = true;
  lineInfo.setAttribute("aria-label", "Relationship details");
  wrap.append(svg, message, info, lineInfo);
  root.append(top, crumbs, wrap);
  host.replaceChildren(root);

  const map = { root, wrap, svg, graph, edgeLayer, nodeLayer, info, lineInfo, message, crumbs, search: input, results,
    scene: null, pendingScene: null, bubbles: new Map(), lines: [], phase: 0, allowed: new Set(KINDS), queerOnly: false,
    dx: 0, dy: 0, width: 0, height: 0, frameRequest: 0, dragged: null, hovered: null, skipClick: false,
    activeLine: null, linePinned: false, lineTimer: 0,
    reduceMotion: window.matchMedia("(prefers-reduced-motion: reduce)") };
  input.addEventListener("input", () => search(map));
  filters.addEventListener("change", () => {
    map.allowed = new Set([...filters.querySelectorAll("label[data-kind] input:checked")].map(box => box.value));
    map.queerOnly = queerToggle.checked;
    if (map.scene && !matchesQueerFilter(map, map.scene.origin)) map.scene = null;
    if (map.pendingScene && !matchesQueerFilter(map, map.pendingScene.origin)) map.pendingScene = null;
    closeDetails(map);
    search(map);
    if (!input.disabled) {
      renderMap(map);
      const scene = map.scene;
      if (scene?.branches.get(scene.origin.key)?.links) {
        void addSecondHop(map, scene).then(() => {
          if (map.root.isConnected && map.scene === scene) renderMap(map);
        });
      }
    }
  });
  bindDrag(map);
  bindRelationshipDetails(map);
  const resize = new ResizeObserver(() => {
    if (root.isConnected) layoutGraph(map);
    else resize.disconnect();
  });
  resize.observe(wrap);

  try {
    await loadDirectories();
    if (!root.isConnected) return;
    input.disabled = false;
    const focus = known.get(new URL(location.href).searchParams.get("focus"));
    if (focus && matchesQueerFilter(map, focus)) await startScene(map, focus);
    else renderMap(map);
  } catch (error) {
    if (root.isConnected) setMessage(map, error.message);
  }
}
