import { DIRECTORY_FOR, KINDS, keyOf, participants, connectionsFor, upcomingFor,
  networkFor, visibleRelationships, relationshipText } from "./scene-map-graph.js?v=20261110-scene-map-11";
import { relationshipStrength, linkGap, keepInView, settleBubbles, orderNeighbors, placeOuterBubble,
  MIN_BUBBLE_HIT_RADIUS, SMALL_BUBBLE_LABEL_WIDTH, SMALL_BUBBLE_LABEL_HEIGHT,
  SMALL_BUBBLE_LABEL_GAP } from "./scene-map-layout.js?v=20261110-scene-map-12a";

const NS = "http://www.w3.org/2000/svg";
const labels = { artist: "Artist", party: "Party", venue: "Venue", collective: "Collective" };
const known = new Map(), cache = new Map();
const ROOT_LINKS = 9;
const AUTO_BRANCHES = 4;
const MAX_BUBBLES = 1 + ROOT_LINKS + AUTO_BRANCHES;
const OUTSIDE_LABEL_RADIUS = 26;
const GRAPH_MOTION_MS = 260;

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
    for (const event of arrival.events.slice(0, 2)) {
      map.info.append(anchor(event.title, qdpUrl(event, true)));
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
  if (map.activeLine) {
    map.activeLine.control.setAttribute("aria-expanded", "false");
    if (window.QDPArchive) window.QDPArchive.events = [];
  }
  map.activeLine = null;
  map.lineInfo.hidden = true;
}

function positionRelationship(map) {
  const line = map.activeLine;
  if (!line) return;
  const popup = map.lineInfo;
  const x = line.midX + map.dx, y = line.midY + map.dy;
  const margin = 8, gap = 14;
  const width = popup.offsetWidth, height = popup.offsetHeight;
  const leftOfLine = x - width - gap, rightOfLine = x + gap;
  const aboveLine = y - height - gap, belowLine = y + gap;
  const options = [
    [rightOfLine, y - height / 2], [leftOfLine, y - height / 2],
    [x - width / 2, aboveLine], [x - width / 2, belowLine],
    [rightOfLine, aboveLine], [leftOfLine, aboveLine], [rightOfLine, belowLine], [leftOfLine, belowLine]
  ];
  let best = { score: Infinity };
  for (const [candidateX, candidateY] of options) {
    const left = Math.max(margin, Math.min(map.width - width - margin, candidateX));
    const top = Math.max(margin, Math.min(map.height - height - margin, candidateY));
    const right = left + width, bottom = top + height;
    let score = 0;
    for (const bubble of map.bubbles.values()) {
      const bx = bubble.x + map.dx, by = bubble.y + map.dy, r = bubble.drawRadius;
      const overlapX = Math.max(0, Math.min(right, bx + r) - Math.max(left, bx - r));
      const overlapY = Math.max(0, Math.min(bottom, by + r) - Math.max(top, by - r));
      score += overlapX * overlapY * (bubble.depth === 0 ? 3 : 1);
    }
    for (const connector of map.lines) {
      const cx = connector.midX + map.dx, cy = connector.midY + map.dy;
      if (cx > left && cx < right && cy > top && cy < bottom) {
        score += connector === line ? width * height : 700;
      }
    }
    if (score < best.score) best = { left, top, score };
  }
  popup.style.left = best.left + "px";
  popup.style.top = best.top + "px";
}

function renderRelationshipEvents(events) {
  const list = node("div", "scene-map-relationship-events");
  list.tabIndex = 0;
  list.setAttribute("role", "region");
  list.setAttribute("aria-label", "Shared events");
  const days = new Map();
  for (const event of events) {
    const date = dateKey(new Date(event.start));
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(event);
  }

  const ordered = [];
  for (const [date, dayEvents] of days) {
    const section = node("section", "scene-map-event-day");
    section.append(node("h3", "date-heading", formatPosterDate(date) + ", " + date.slice(0, 4)));
    const sorted = sortEvents(dayEvents);
    ordered.push(...sorted);
    for (const atTime of groupEventsByStartTime(sorted)) {
      const group = node("div", "event-time-group");
      const time = node("div", "event-time");
      appendStartTime(time, atTime[0]);
      const cards = node("div", "event-group-cards");
      for (const [index, event] of atTime.entries()) {
        const row = node("div", index === 0 ? "event-row has-time" : "event-row same-time");
        row.append(createEventCard(event));
        cards.append(row);
      }
      group.append(time, cards);
      section.append(group);
    }
    list.append(section);
  }
  if (window.QDPArchive) window.QDPArchive.events = ordered;
  return list;
}

function toggleRelationship(map, line, keyboard = false) {
  if (map.activeLine === line) {
    closeRelationship(map);
    return;
  }
  closeRelationship(map);
  closeDetails(map);
  map.activeLine = line;
  line.control.setAttribute("aria-expanded", "true");

  const heading = node("div", "scene-map-detail-heading");
  const close = node("button", "scene-map-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close relationship details");
  close.onclick = () => {
    const control = map.activeLine?.control;
    closeRelationship(map);
    control?.focus({ preventScroll: true });
  };
  heading.append(node("strong", "", line.source.item.name + " · " + line.target.item.name), close);
  const link = line.link;
  const count = sharedEvents(link.count) + (link.upcoming ? " · " + link.upcoming + " upcoming" : "");
  const events = renderRelationshipEvents(link.events);
  map.lineInfo.replaceChildren(heading, node("p", "scene-map-note", count), events);
  map.lineInfo.hidden = false;
  fitPosterTitles(events);
  positionRelationship(map);
  if (keyboard) close.focus();
}

function createLine(map, source, target, link, cross) {
  const control = svgNode("g", {
    class: "scene-map-edge-control", role: "button", tabindex: "0",
    "aria-label": source.item.name + " and " + target.item.name + ", " + sharedEvents(link.count),
    "aria-controls": map.lineInfo.id, "aria-expanded": "false"
  });
  const element = svgNode("line", {
    class: cross ? "scene-map-edge scene-map-edge-cross" : "scene-map-edge",
    "data-depth": Math.max(source.depth, target.depth),
    "stroke-width": cross ? 1.15 : 1.3 + relationshipStrength(link.count) * 1.35
  });
  const hit = svgNode("line", { class: "scene-map-edge-hit", "aria-hidden": "true" });
  control.append(element, hit);
  const line = { control, element, hit, source, target, link, midX: 0, midY: 0 };
  control.addEventListener("click", event => {
    if (!map.skipClick || event.detail === 0) toggleRelationship(map, line);
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
  const captionName = node("span", "scene-map-caption-name", item.name);
  captionBody.append(captionName);
  caption.append(captionBody);
  element.append(title, circle, hit, caption);
  const bubble = {
    item, element, title, circle, hit, caption, captionBody, captionName,
    opacity: map.reduceMotion.matches ? 1 : 0, phase: map.phase++ * 1.7
  };
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
}

function resizeBubble(bubble, shortSide, maxDirect, maxIndirect, labelWidth) {
  // Circle area encodes the count, with a smaller scale for second-degree links.
  const indirect = bubble.depth === 2;
  const scale = indirect ? .82 / Math.sqrt(Math.max(maxDirect, maxIndirect)) : 1 / Math.sqrt(maxDirect);
  bubble.radius = bubble.link ? shortSide * .116 * Math.sqrt(bubble.link.count) * scale : shortSide * .148;
  bubble.labelOutside = bubble.radius < OUTSIDE_LABEL_RADIUS;
  if (bubble.drawRadius === undefined) paintRadius(bubble, bubble.radius * bubble.opacity);
  fitCaption(bubble, labelWidth);
}

function paintRadius(bubble, radius) {
  bubble.drawRadius = radius;
  bubble.circle.setAttribute("r", radius);
  bubble.hit.setAttribute("r", Math.max(radius, MIN_BUBBLE_HIT_RADIUS));
  paintCaption(bubble, radius);
}

function paintCaption(bubble, radius) {
  const outside = bubble.labelOutside;
  const width = outside ? bubble.labelWidth || SMALL_BUBBLE_LABEL_WIDTH : radius * 1.65;
  const height = outside ? SMALL_BUBBLE_LABEL_HEIGHT : radius;
  bubble.caption.setAttribute("data-outside", outside);
  bubble.caption.setAttribute("x", -width / 2);
  bubble.caption.setAttribute("y", outside ? radius + SMALL_BUBBLE_LABEL_GAP : -height / 2);
  bubble.caption.setAttribute("width", width);
  bubble.caption.setAttribute("height", height);
  let size = Math.max(11, Math.min(25, radius * .39));
  if (bubble.labelFontSize) {
    size = outside ? bubble.labelFontSize : bubble.labelFontSize * radius / bubble.radius;
  }
  bubble.captionBody.style.fontSize = size + "px";
}

function fitCaption(bubble, maxLabelWidth) {
  const { captionBody, captionName, radius, drawRadius } = bubble;
  bubble.labelOutside = false;
  bubble.labelFontSize = null;
  paintCaption(bubble, radius);
  const base = parseFloat(captionBody.style.fontSize);
  const width = captionBody.clientWidth;
  const fullWidth = captionName.scrollWidth || width;
  const insideSize = fullWidth > width && width ? base * width / fullWidth - .25 : base;
  bubble.labelOutside = radius < OUTSIDE_LABEL_RADIUS || insideSize < 11;
  bubble.labelFontSize = Math.max(1, insideSize);
  if (bubble.labelOutside) {
    const naturalWidth = fullWidth * 12 / base;
    bubble.labelWidth = Math.min(maxLabelWidth, Math.max(SMALL_BUBBLE_LABEL_WIDTH, Math.ceil(naturalWidth) + 2));
    bubble.labelFontSize = naturalWidth > bubble.labelWidth
      ? Math.max(1, 12 * (bubble.labelWidth - 2) / naturalWidth) : 12;
  }
  paintCaption(bubble, radius);
  if (captionBody.clientWidth && captionName.scrollWidth > captionBody.clientWidth) {
    bubble.labelFontSize = Math.max(1, bubble.labelFontSize * captionBody.clientWidth / captionName.scrollWidth - .25);
  }
  paintCaption(bubble, drawRadius);
}

function positionNewBubbles(map) {
  const bubbles = [...map.bubbles.values()];
  if (bubbles.every(bubble => Number.isFinite(bubble.targetX))) return;
  const { width, height } = map;
  const center = bubbles[0];
  if (!Number.isFinite(center.targetX)) {
    center.targetX = width / 2;
    center.targetY = height / 2;
  }
  const neighbors = orderNeighbors(bubbles.filter(bubble => bubble.depth === 1), map.lines);
  const spread = Math.min(1, .58 + .055 * neighbors.length);
  const orbitX = Math.min(width * .31, height * .54) * spread;
  const orbitY = Math.min(height * .31, width * .47) * spread;
  for (const [index, bubble] of neighbors.entries()) {
    if (Number.isFinite(bubble.targetX)) continue;
    const angle = -Math.PI / 2 + 2 * Math.PI * index / neighbors.length;
    const dx = orbitX * Math.cos(angle), dy = orbitY * Math.sin(angle);
    const clearance = center.radius + bubble.radius + linkGap(width, height);
    const scale = Math.max(1, clearance / Math.hypot(dx, dy));
    bubble.targetX = center.targetX + dx * scale;
    bubble.targetY = center.targetY + dy * scale;
    keepInView(bubble, width, height);
  }
  for (const bubble of bubbles) {
    const parent = map.bubbles.get(bubble.parent);
    if (bubble.depth === 2 && !Number.isFinite(bubble.targetX)) {
      placeOuterBubble(bubble, parent, center, bubbles, width, height);
    }
    const x = parent?.x ?? bubble.targetX, y = parent?.y ?? bubble.targetY;
    bubble.x ??= x + (bubble.targetX - x) * .22;
    bubble.y ??= y + (bubble.targetY - y) * .22;
  }
}

function paintBubble(bubble) {
  bubble.element.setAttribute("transform", "translate(" + bubble.x.toFixed(2) + " " + bubble.y.toFixed(2) + ")");
  bubble.element.style.opacity = bubble.opacity;
  bubble.element.classList.toggle("is-arriving", bubble.opacity < .35);
}

function paintGraph(map, time) {
  if (!map.width || !map.height) return;
  const reduced = map.reduceMotion.matches;
  let movement = 0;
  if (time !== undefined) {
    const elapsed = Math.min(64, time - (map.lastFrameTime ?? time - 1000 / 60));
    movement = 1 - Math.exp(-elapsed / GRAPH_MOTION_MS);
    map.lastFrameTime = time;
  }
  for (const bubble of map.bubbles.values()) {
    if (reduced) {
      bubble.x = bubble.targetX;
      bubble.y = bubble.targetY;
      bubble.opacity = 1;
      if (bubble.drawRadius !== bubble.radius) paintRadius(bubble, bubble.radius);
    } else if (movement) {
      if (bubble !== map.dragged) {
        const steady = bubble.depth === 0 || bubble === map.hovered || bubble.element === document.activeElement ||
          bubble === map.activeLine?.source || bubble === map.activeLine?.target;
        const float = steady ? 0 : 4;
        const x = bubble.targetX + float * Math.sin(time / 1600 + bubble.phase);
        const y = bubble.targetY + float * Math.cos(time / 1900 + bubble.phase);
        bubble.x += (x - bubble.x) * movement;
        bubble.y += (y - bubble.y) * movement;
      }
      bubble.opacity = bubble.opacity > .98 ? 1 : bubble.opacity + (1 - bubble.opacity) * movement;
      if (bubble.drawRadius !== bubble.radius) {
        const change = bubble.radius - bubble.drawRadius;
        paintRadius(bubble, Math.abs(change) < .2 ? bubble.radius : bubble.drawRadius + change * movement);
      }
    }
    paintBubble(bubble);
  }
  for (const [key, bubble] of map.retiringBubbles) {
    bubble.opacity *= 1 - movement;
    if (reduced || bubble.opacity < .02) {
      bubble.element.remove();
      map.retiringBubbles.delete(key);
      continue;
    }
    if (movement) {
      const parent = map.bubbles.get(bubble.parent) || map.bubbles.get(map.scene?.origin.key);
      bubble.x += ((parent?.x ?? map.width / 2) - bubble.x) * movement;
      bubble.y += ((parent?.y ?? map.height / 2) - bubble.y) * movement;
      paintRadius(bubble, bubble.drawRadius * (1 - movement));
    }
    paintBubble(bubble);
  }
  for (const line of [...map.retiringLines.values(), ...map.lines]) {
    const { control, element, hit, source, target } = line;
    if (map.retiringLines.has(line.key) && (!source.element.isConnected || !target.element.isConnected ||
        (!map.retiringBubbles.has(source.item.key) && !map.retiringBubbles.has(target.item.key)))) {
      control.remove();
      map.retiringLines.delete(line.key);
      continue;
    }
    const dx = target.x - source.x, dy = target.y - source.y;
    const distance = Math.hypot(dx, dy) || 1;
    const gap = distance - source.drawRadius - target.drawRadius;
    const opacity = gap > 0 ? Math.min(source.opacity, target.opacity) : 0;
    control.style.opacity = opacity;
    control.classList.toggle("is-arriving", opacity < .35);
    const trim = Math.max(0, Math.min(3, gap / 2));
    const start = (source.drawRadius + trim) / distance, end = (target.drawRadius + trim) / distance;
    const x1 = source.x + dx * start, y1 = source.y + dy * start;
    const x2 = target.x - dx * end, y2 = target.y - dy * end;
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
  const visible = () => map.bubbles.size || map.retiringBubbles.size;
  if (map.frameRequest || map.reduceMotion.matches || !map.width || !map.height || !visible()) return;
  map.lastFrameTime = undefined;
  const tick = time => {
    map.frameRequest = 0;
    if (!map.root.isConnected || !map.width || !map.height || !visible()) return;
    paintGraph(map, time);
    if (!map.reduceMotion.matches && visible()) map.frameRequest = requestAnimationFrame(tick);
  };
  map.frameRequest = requestAnimationFrame(tick);
}

function layoutGraph(map, reflow = false) {
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
    if (!bubble.link) continue;
    maxCounts[bubble.depth] = Math.max(maxCounts[bubble.depth], bubble.link.count);
    if (bubble.depth === 2) {
      // Use the branch's scale so a second-degree bubble can grow on recentering.
      const branch = map.scene.branches.get(bubble.parent);
      const strongest = branch?.links?.find(item => visibleConnection(map, item));
      if (strongest) maxCounts[2] = Math.max(maxCounts[2], strongest.count);
    }
  }
  for (const bubble of map.bubbles.values()) {
    resizeBubble(bubble, Math.min(width, height), maxCounts[1], maxCounts[2], Math.min(240, width - 24));
    if (Number.isFinite(bubble.x)) {
      bubble.x *= scaleX;
      bubble.y *= scaleY;
      bubble.targetX = reflow ? undefined : bubble.targetX * scaleX;
      bubble.targetY = reflow ? undefined : bubble.targetY * scaleY;
    }
  }
  for (const bubble of map.retiringBubbles.values()) {
    bubble.x *= scaleX;
    bubble.y *= scaleY;
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

function addVisibleConnections(map, scene) {
  const seen = new Set(map.lines.map(line => line.key));
  for (const [key, { source, target, link, cross }] of visibleRelationships(map.bubbles, scene.branches)) {
    if (seen.has(key)) continue;
    map.retiringLines.get(key)?.control.remove();
    map.retiringLines.delete(key);
    const line = createLine(map, map.bubbles.get(source), map.bubbles.get(target), link, cross);
    line.key = key;
    map.lines.push(line);
    if (cross) map.edgeLayer.prepend(line.control);
    else map.edgeLayer.append(line.control);
  }
}

function renderMap(map, reflow = false) {
  const previousLine = map.activeLine;
  const restoreLineFocus = previousLine?.control === document.activeElement;
  const scene = map.scene;
  const network = scene ? buildNetwork(map, scene) : new Map();
  const bubbles = new Map();
  for (const [key, vertex] of network) {
    const retiring = map.retiringBubbles.get(key);
    const bubble = map.bubbles.get(key) || retiring || createBubble(map, vertex.item);
    if (retiring) {
      map.retiringBubbles.delete(key);
      bubble.element.classList.remove("is-retiring");
      bubble.element.removeAttribute("aria-hidden");
      bubble.element.setAttribute("tabindex", "0");
    }
    Object.assign(bubble, vertex);
    bubbles.set(key, bubble);
  }
  for (const [key, bubble] of map.bubbles) {
    if (bubbles.has(key)) continue;
    if (map.hovered === bubble) map.hovered = null;
    if (map.reduceMotion.matches || !Number.isFinite(bubble.x)) {
      bubble.element.remove();
      continue;
    }
    bubble.element.classList.add("is-retiring");
    bubble.element.setAttribute("aria-hidden", "true");
    bubble.element.setAttribute("tabindex", "-1");
    map.nodeLayer.prepend(bubble.element);
    map.retiringBubbles.set(key, bubble);
  }
  map.bubbles = bubbles;
  const previousLines = map.lines;
  map.lines = [];
  if (scene) addVisibleConnections(map, scene);
  const visibleLines = new Set(map.lines.map(line => line.key));
  for (const line of previousLines) {
    const retiring = map.retiringBubbles.has(line.source.item.key) || map.retiringBubbles.has(line.target.item.key);
    if (!retiring || visibleLines.has(line.key)) {
      line.control.remove();
      continue;
    }
    line.control.classList.add("is-retiring");
    line.control.setAttribute("aria-hidden", "true");
    line.control.setAttribute("tabindex", "-1");
    map.edgeLayer.prepend(line.control);
    map.retiringLines.set(line.key, line);
  }
  if (previousLine) {
    const currentLine = map.lines.find(line => line.key === previousLine.key && line.link === previousLine.link);
    if (currentLine) {
      map.activeLine = currentLine;
      currentLine.control.setAttribute("aria-expanded", "true");
      if (restoreLineFocus) currentLine.control.focus({ preventScroll: true });
    } else closeRelationship(map);
  }
  updateBubbles(map);
  layoutGraph(map, reflow);
  if (map.pendingScene && map.pendingScene !== scene) setMessage(map, "Loading " + map.pendingScene.origin.name + "…");
  else if (!scene) setMessage(map, "Search for something you know to begin.");
  else if (!scene.branches.get(scene.origin.key)?.events) setMessage(map, "Loading " + scene.origin.name + "…");
  else setMessage(map, bubbles.size > 1 ? "" : "No connections match these filters.");
}


async function loadBranch(scene, item, limit) {
  if (!scene.branches.has(item.key)) {
    scene.branches.set(item.key, { limit, preferred: scene.preferred.get(item.key) });
  }
  const branch = scene.branches.get(item.key);
  branch.limit = Math.max(branch.limit, limit);
  if (branch.links) return;
  const data = await profile(item);
  if (!branch.links) {
    branch.events = data.events;
    branch.links = connectionsFor(item, data.events, known);
  }
}

async function loadVisibleConnections(map, scene) {
  const missing = [...map.bubbles.values()].filter(bubble => !scene.branches.get(bubble.item.key)?.links);
  const isCurrent = () => map.root.isConnected && map.scene === scene && !map.pendingScene;
  // Fill in connections between visible bubbles without adding another level.
  for (let index = 0; index < missing.length && isCurrent(); index += AUTO_BRANCHES) {
    const batch = missing.slice(index, index + AUTO_BRANCHES);
    await Promise.allSettled(batch.map(bubble => loadBranch(scene, bubble.item, 0)));
    if (!isCurrent()) return;
    addVisibleConnections(map, scene);
    paintGraph(map);
  }
}

async function addSecondHop(map, scene) {
  const direct = [...buildNetwork(map, scene).values()].filter(vertex => vertex.depth === 1);
  const arrival = direct.find(vertex => vertex.item.key === scene.arrival);
  const first = [...new Set([...(arrival ? [arrival] : []), ...direct])].slice(0, AUTO_BRANCHES);
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
    const neighbors = new Set();
    for (const line of map.lines) {
      if (line.source.item.key === item.key) neighbors.add(line.target.item.key);
      else if (line.target.item.key === item.key) neighbors.add(line.source.item.key);
    }
    const formerPeers = visible.filter(bubble => bubble.parent === previousKey && bubble.item.key !== item.key);
    const commonMembers = new Set();
    for (const event of previous.branches.get(previousKey)?.events || []) {
      const members = participants(event);
      if (members.includes(item.key)) members.forEach(key => commonMembers.add(key));
    }
    const sharedContext = formerPeers.filter(bubble => bubble.item.kind !== "artist" && commonMembers.has(bubble.item.key));
    preferred.set(item.key, [previousKey, arrival, ...sharedContext.map(bubble => bubble.item.key), ...neighbors]);
    const peerKeys = formerPeers.map(bubble => bubble.item.key);
    const retainedPeers = (previous.preferred.get(previousKey) || []).filter(key => peerKeys.includes(key));
    preferred.set(previousKey, [...retainedPeers, ...peerKeys]);
    if (arrival !== previousKey) preferred.set(arrival, [previousKey]);
  }
  const scene = { origin: item, arrival, preferred, branches: new Map() };
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
      renderMap(map, true);
      void loadVisibleConnections(map, scene);
      return;
    }
    // Preserve current screen positions while the new center animates in.
    for (const bubble of [...map.bubbles.values(), ...map.retiringBubbles.values()]) {
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
    void loadVisibleConnections(map, scene);
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
  if (!map.searchOpen || map.search.disabled) return;
  const rank = item => item.name.toLocaleLowerCase().startsWith(query) ? 0 : 1;
  const found = [...known.values()].filter(item =>
    matchesQueerFilter(map, item) && item.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  if (!found.length) map.results.append(node("p", "scene-map-note", "No matching profiles."));
  for (const item of found) {
    const button = node("button", "scene-map-result");
    button.type = "button";
    button.append(node("span", "scene-map-result-name", item.name), typePill(item.kind));
    button.onclick = () => {
      map.search.value = "";
      closeSearch(map);
      startScene(map, item);
    };
    map.results.append(button);
  }
}

function closeSearch(map) {
  map.searchOpen = false;
  map.results.replaceChildren();
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
  input.placeholder = "What will you find?";
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
  root.append(top, wrap);
  host.replaceChildren(root);

  const map = { root, wrap, svg, graph, edgeLayer, nodeLayer, info, lineInfo, message, search: input, results,
    scene: null, pendingScene: null, bubbles: new Map(), lines: [], retiringBubbles: new Map(), retiringLines: new Map(),
    phase: 0, allowed: new Set(KINDS), queerOnly: false,
    dx: 0, dy: 0, width: 0, height: 0, frameRequest: 0, dragged: null, hovered: null, skipClick: false,
    activeLine: null, searchOpen: false,
    reduceMotion: window.matchMedia("(prefers-reduced-motion: reduce)") };
  const openSearch = () => {
    if (map.searchOpen) return;
    map.searchOpen = true;
    search(map);
  };
  input.addEventListener("focus", openSearch);
  input.addEventListener("click", openSearch);
  input.addEventListener("input", () => {
    map.searchOpen = true;
    search(map);
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Escape" && map.searchOpen) {
      closeSearch(map);
      event.stopPropagation();
    }
    if (event.key === "ArrowDown") {
      openSearch();
      map.results.querySelector("button")?.focus();
      event.preventDefault();
    }
  });
  top.addEventListener("focusout", event => {
    if (!top.contains(event.relatedTarget)) closeSearch(map);
  });
  root.addEventListener("pointerdown", event => {
    if (!top.contains(event.target)) closeSearch(map);
  });
  filters.addEventListener("change", () => {
    map.allowed = new Set([...filters.querySelectorAll("label[data-kind] input:checked")].map(box => box.value));
    map.queerOnly = queerToggle.checked;
    if (map.scene && !matchesQueerFilter(map, map.scene.origin)) map.scene = null;
    if (map.pendingScene && !matchesQueerFilter(map, map.pendingScene.origin)) map.pendingScene = null;
    closeDetails(map);
    search(map);
    if (!input.disabled) {
      renderMap(map, true);
      const scene = map.scene;
      if (scene?.branches.get(scene.origin.key)?.links) {
        void addSecondHop(map, scene).then(() => {
          if (map.root.isConnected && map.scene === scene) {
            renderMap(map, true);
            void loadVisibleConnections(map, scene);
          }
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
  document.fonts?.ready.then(() => {
    if (root.isConnected) layoutGraph(map);
  });

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
