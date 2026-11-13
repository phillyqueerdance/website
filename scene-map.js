import { DIRECTORY_FOR, KINDS, keyOf, participants, connectionsFor, orderSceneEvents,
  networkFor, visibleRelationships } from "./scene-map-graph.js?v=20261110-scene-map-22";
import { relationshipStrength, linkGap, keepInView, settleBubbles, orderNeighbors, placeOuterBubble,
  MIN_BUBBLE_HIT_RADIUS, SMALL_BUBBLE_LABEL_WIDTH, SMALL_BUBBLE_LABEL_GAP } from "./scene-map-layout.js?v=20261110-scene-map-12a";

const NS = "http://www.w3.org/2000/svg";
const labels = { artist: "Artist", party: "Party", venue: "Venue", collective: "Collective" };
const known = new Map(), cache = new Map();
const DESKTOP_LIMITS = { total: 16, direct: 11, context: 3 };
const MOBILE_LIMITS = { total: 10, direct: 7, context: 2 };
const AUTO_BRANCHES = 4;
const OUTSIDE_LABEL_RADIUS = 26;
const MIN_CAPTION_SIZE = 11;
const CAPTION_LINE_HEIGHT = 1.07;
const GRAPH_MOTION_MS = 260;
let captionMeasure;
const BUBBLE_ARTWORK = {
  "collective:QDP-001": { src: "/start-here-logo.png", scale: 1, replacesDisc: true },
  "party:MELT-001": { src: "/melt-logo.png", scale: .73, innerBorder: true }
};

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

function setMessage(map, text) {
  map.message.textContent = text;
  map.message.hidden = !text;
}

function sharedEvents(count) {
  return count + (count === 1 ? " shared event" : " shared events");
}

function closeDetails(map) {
  if (!map.info.hidden && window.QDPArchive) window.QDPArchive.events = [];
  map.info.hidden = true;
  map.svg.querySelector(".scene-map-node.focus")?.setAttribute("aria-expanded", "false");
}

function profileHeading(item) {
  const heading = node("div", "scene-map-profile-heading");
  const link = node("a", "scene-map-profile-link", "Visit Profile");
  link.href = window.QDPProfileMetadata.url(item.kind, item.id, location.origin);
  link.setAttribute("data-archive-link", "");
  link.setAttribute("aria-label", "Visit Profile for " + item.name);
  heading.append(node("strong", "", item.name), link);
  return heading;
}

function toggleDetails(map, bubble, keyboard = false) {
  closeRelationship(map);
  if (!map.info.hidden) {
    closeDetails(map);
    return;
  }
  const item = bubble.item;
  const events = map.scene.branches.get(item.key)?.events;
  if (!events) return;
  const heading = node("div", "scene-map-detail-heading");
  const close = node("button", "scene-map-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close profile details");
  close.onclick = () => {
    closeDetails(map);
    bubble.element.focus({ preventScroll: true });
  };
  heading.append(profileHeading(item), close);
  const list = events.length
    ? renderSceneEvents(orderSceneEvents(events), item.name + " events")
    : node("p", "scene-map-note", "No events listed.");
  map.info.replaceChildren(heading, list);
  map.info.hidden = false;
  fitPosterTitles(map.info);
  bubble.element.setAttribute("aria-expanded", "true");
  if (keyboard) close.focus({ preventScroll: true });
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

function renderSceneEvents(events, label) {
  const list = node("div", "scene-map-events");
  list.tabIndex = 0;
  list.setAttribute("role", "region");
  list.setAttribute("aria-label", label);
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
  const profiles = node("div", "scene-map-relationship-profiles");
  profiles.append(profileHeading(line.source.item), node("strong", "", "&"), profileHeading(line.target.item));
  heading.append(profiles, close);
  const link = line.link;
  const count = sharedEvents(link.count) +
    (link.upcoming ? " · " + link.upcoming + " upcoming" : "");
  map.lineInfo.replaceChildren(heading, node("p", "scene-map-note", count));
  if (link.events.length) map.lineInfo.append(renderSceneEvents(link.events, "Shared events"));
  map.lineInfo.hidden = false;
  fitPosterTitles(map.lineInfo);
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
    "stroke-width": cross ? 1.15 : 1.3 + relationshipStrength(Math.max(1, link.count)) * 1.35
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

function bindDetails(map) {
  map.root.addEventListener("pointerdown", event => {
    if (map.activeLine && !map.lineInfo.contains(event.target) && !event.target.closest(".scene-map-edge-control")) {
      closeRelationship(map);
    }
  });
  map.root.addEventListener("keydown", event => {
    if (event.key !== "Escape" || (!map.activeLine && map.info.hidden)) return;
    const popup = map.activeLine ? map.lineInfo : map.info;
    const trigger = map.activeLine?.control || map.svg.querySelector(".scene-map-node.focus");
    const restore = popup.contains(document.activeElement);
    if (map.activeLine) closeRelationship(map);
    else closeDetails(map);
    if (restore) trigger?.focus({ preventScroll: true });
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
  const photo = window.QDPProfileMetadata.profileImage(item.kind, item);
  const bubble = {
    item, element, title, circle, hit,
    opacity: map.reduceMotion.matches ? 1 : 0, phase: map.phase++ * 1.7
  };
  const artwork = photo ? null : BUBBLE_ARTWORK[item.key];
  element.append(title);
  if (photo) {
    const id = `scene-map-${item.kind}-photo-${item.id}`;
    const pattern = svgNode("pattern", { id, width: 1, height: 1, patternContentUnits: "objectBoundingBox" });
    // Only portrait images have excess height in the square crop.
    const alignment = item.kind === "artist" ? "xMidYMin" : "xMidYMid";
    const image = svgNode("image", { width: 1, height: 1, preserveAspectRatio: `${alignment} slice` });
    image.addEventListener("error", () => image.remove(), { once: true });
    image.setAttribute("href", photo.src);
    const frame = item.kind === "artist" ? window.QDPProfileMetadata.photoCropFrame(item.imageCrop) : null;
    if (frame) {
      pattern.setAttribute("viewBox", `${frame.x} ${frame.y} 1 1`);
      image.setAttribute("width", frame.width);
      image.setAttribute("height", frame.height);
      image.setAttribute("preserveAspectRatio", "none");
    } else if (item.kind === "artist") {
      import("./scene-map-photo-crop.js?v=20261111-artist-map-photos-2")
        .then(({ applyArtistPhotoCrop }) => applyArtistPhotoCrop(pattern, image, photo.src))
        .catch(() => {});
    }
    pattern.append(image);
    const defs = svgNode("defs");
    defs.append(pattern);
    bubble.photo = svgNode("circle", { fill: `url(#${id})` });
    const photoGroup = svgNode("g", { class: "scene-map-node-photo", "aria-hidden": "true" });
    photoGroup.append(circle, bubble.photo);
    element.append(defs, photoGroup);
  } else element.append(circle);
  element.append(hit);
  if (artwork) {
    bubble.logo = svgNode("image", { class: "scene-map-node-logo", href: artwork.src, "aria-hidden": "true" });
    bubble.logoScale = artwork.scale;
    if (artwork.replacesDisc) element.classList.add("scene-map-node-globe");
    if (artwork.innerBorder) {
      bubble.ring = svgNode("circle", { class: "scene-map-node-ring", "aria-hidden": "true" });
      element.append(bubble.ring);
    }
    element.append(bubble.logo);
  } else {
    const caption = svgNode("text", { class: "scene-map-caption", "aria-hidden": "true" });
    const captionLines = [svgNode("tspan", { x: 0 }), svgNode("tspan", { x: 0 })];
    caption.append(...captionLines);
    const captionHit = svgNode("rect", { class: "scene-map-caption-hit", "aria-hidden": "true" });
    element.append(captionHit, caption);
    Object.assign(bubble, { caption, captionLines, captionHit });
  }
  element.addEventListener("click", event => {
    if (!map.skipClick || event.detail === 0) activateBubble(map, bubble, event.detail === 0);
  });
  element.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateBubble(map, bubble, true);
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
  bubble.radius = bubble.link ? shortSide * .116 * Math.sqrt(Math.max(1, bubble.link.count)) * scale : shortSide * .148;
  if (bubble.caption) fitCaption(bubble, labelWidth);
  paintRadius(bubble, bubble.drawRadius ?? bubble.radius * bubble.opacity);
}

function paintRadius(bubble, radius) {
  bubble.drawRadius = radius;
  bubble.circle.setAttribute("r", radius);
  bubble.hit.setAttribute("r", Math.max(radius, MIN_BUBBLE_HIT_RADIUS));
  const borderScale = bubble.depth === 0 ? 1 : .82;
  if (bubble.photo) bubble.photo.setAttribute("r", radius - Math.min(8, radius * .23) * borderScale);
  if (bubble.ring) {
    bubble.ring.setAttribute("r", radius * .9);
    bubble.ring.setAttribute("stroke-width", Math.min(6, radius * .18) * borderScale);
  }
  if (bubble.logo) {
    const halfSize = radius * bubble.logoScale;
    bubble.logo.setAttribute("x", -halfSize);
    bubble.logo.setAttribute("y", -halfSize);
    bubble.logo.setAttribute("width", halfSize * 2);
    bubble.logo.setAttribute("height", halfSize * 2);
  } else {
    paintCaption(bubble, radius);
  }
}

function paintCaption(bubble, radius) {
  const { caption, captionHit, captionLines: [first, second], labelOutside, labelFontSize,
    labelWidth, labelAscent, labelDescent } = bubble;
  const scale = labelOutside ? 1 : radius / bubble.radius;
  const size = labelFontSize * scale;
  const lineHeight = size * CAPTION_LINE_HEIGHT;
  const height = (labelAscent + labelDescent) * scale;
  const top = labelOutside ? radius + SMALL_BUBBLE_LABEL_GAP : -height / 2;
  const baseline = top + labelAscent * scale;
  caption.style.fontSize = size + "px";
  caption.setAttribute("data-outside", labelOutside);
  first.setAttribute("y", baseline);
  second.setAttribute("y", baseline + lineHeight);
  captionHit.setAttribute("width", labelOutside ? labelWidth : 0);
  if (labelOutside) {
    captionHit.setAttribute("x", -labelWidth / 2);
    captionHit.setAttribute("y", top);
    captionHit.setAttribute("height", Math.max(height, lineHeight));
  }
}

function splitCaption(name, measure) {
  const words = name.split(" ");
  if (words.length < 2) return null;
  let best = null;
  for (let split = 1; split < words.length; split++) {
    const first = words.slice(0, split).join(" ");
    const second = words.slice(split).join(" ");
    const width = Math.max(measure.measureText(first).width, measure.measureText(second).width);
    if (!best || width < best.width) best = { lines: [first, second], width };
  }
  return best;
}

function fitCaption(bubble, maxLabelWidth) {
  const { caption, captionLines: [first, second], radius } = bubble;
  const name = bubble.item.name.replace(/\s+/g, " ").trim();
  if (first.textContent !== name) first.textContent = name;
  if (second.textContent) second.textContent = "";
  const base = Math.max(MIN_CAPTION_SIZE, Math.min(25, radius * .39));
  caption.style.fontSize = base + "px";
  const width = radius * 1.65;
  const fullWidth = first.getComputedTextLength();
  const measure = captionMeasure ||= document.createElement("canvas").getContext("2d");
  const { fontWeight, fontFamily } = getComputedStyle(caption);
  let insideSize = fullWidth > width ? base * width / fullWidth - .25 : base;
  let lines;
  if (measure && !bubble.photo && radius >= OUTSIDE_LABEL_RADIUS && insideSize < base) {
    measure.font = `${fontWeight} ${base}px ${fontFamily}`;
    const split = splitCaption(name, measure);
    if (split) {
      const heightLimit = (radius - 2) / (2 * CAPTION_LINE_HEIGHT);
      const twoLineSize = Math.min(base, base * (width - 2) / split.width, heightLimit);
      if (twoLineSize >= MIN_CAPTION_SIZE && (insideSize < MIN_CAPTION_SIZE || twoLineSize >= insideSize + 1.5)) {
        lines = split.lines;
        insideSize = twoLineSize;
      }
    }
  }
  bubble.labelOutside = Boolean(bubble.photo) || radius < OUTSIDE_LABEL_RADIUS || insideSize < MIN_CAPTION_SIZE;
  bubble.labelFontSize = Math.max(1, insideSize);
  if (bubble.labelOutside) {
    const naturalWidth = fullWidth * 12 / base;
    bubble.labelWidth = Math.min(maxLabelWidth, Math.max(SMALL_BUBBLE_LABEL_WIDTH, Math.ceil(naturalWidth) + 2));
    bubble.labelFontSize = naturalWidth > bubble.labelWidth
      ? Math.max(1, 12 * (bubble.labelWidth - 2) / naturalWidth) : 12;
  } else if (lines) {
    first.textContent = lines[0];
    second.textContent = lines[1];
  }
  caption.style.fontSize = bubble.labelFontSize + "px";
  const fittedWidth = Math.max(first.getComputedTextLength(), second.getComputedTextLength());
  const availableWidth = bubble.labelOutside ? bubble.labelWidth : width;
  if (fittedWidth > availableWidth) {
    bubble.labelFontSize = Math.max(1, bubble.labelFontSize * availableWidth / fittedWidth - .25);
  }

  // Measure the ink above and below the alphabetic baseline once per layout.
  const size = bubble.labelFontSize;
  if (measure) measure.font = `${fontWeight} ${size}px ${fontFamily}`;
  const firstBounds = measure?.measureText(first.textContent);
  bubble.labelAscent = firstBounds?.actualBoundingBoxAscent ?? size * .75;
  bubble.labelDescent = firstBounds?.actualBoundingBoxDescent ?? size * .25;
  if (second.textContent) {
    const secondBounds = measure?.measureText(second.textContent);
    const offset = size * CAPTION_LINE_HEIGHT;
    bubble.labelAscent = Math.max(bubble.labelAscent, (secondBounds?.actualBoundingBoxAscent ?? size * .75) - offset);
    bubble.labelDescent = Math.max(bubble.labelDescent, offset + (secondBounds?.actualBoundingBoxDescent ?? size * .25));
  }
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
  return networkFor(scene.origin, scene.branches, item => visibleConnection(map, item), map.limits);
}

function addVisibleConnections(map, scene) {
  const existing = new Map(map.lines.map(line => [line.key, line]));
  for (const [key, { source, target, link, cross, associated }] of visibleRelationships(map.bubbles, scene.branches)) {
    let line = existing.get(key);
    if (!line) {
      map.retiringLines.get(key)?.control.remove();
      map.retiringLines.delete(key);
      line = createLine(map, map.bubbles.get(source), map.bubbles.get(target), link, cross);
      line.key = key;
      map.lines.push(line);
      if (cross) map.edgeLayer.prepend(line.control);
      else map.edgeLayer.append(line.control);
    }
    line.element.classList.toggle("scene-map-edge-associated", associated);
    if (associated) line.control.setAttribute("aria-description", "Profile association");
  }
}

function renderMap(map, reflow = false) {
  const previousLine = map.activeLine;
  const restoreLineFocus = previousLine?.control === document.activeElement;
  const scene = map.scene;
  const events = scene?.branches.get(scene.origin.key)?.events;
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
  if (events) map.filters.hidden = false;
  map.svg.setAttribute("aria-hidden", String(!bubbles.size));
  layoutGraph(map, reflow);
  if (map.pendingScene && map.pendingScene !== scene) setMessage(map, "Loading " + map.pendingScene.origin.name + "…");
  else if (!scene) setMessage(map, "");
  else if (!events) setMessage(map, "Loading " + scene.origin.name + "…");
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
    branch.links = connectionsFor({ ...item, related: data.profile.related }, data.events, known);
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
  const limits = map.limits;
  const direct = [...buildNetwork(map, scene).values()].filter(vertex => vertex.depth === 1);
  const arrival = direct.find(vertex => vertex.item.key === scene.arrival);
  const first = [...new Set([...(arrival ? [arrival] : []), ...direct])].slice(0, AUTO_BRANCHES);
  await Promise.allSettled(first.map(vertex => loadBranch(scene, vertex.item, 1)));
  if (!map.root.isConnected || (map.scene !== scene && map.pendingScene !== scene)) return;
  if (map.limits !== limits) return addSecondHop(map, scene);
  const current = [...buildNetwork(map, scene).values()];
  if (current.some(vertex => vertex.depth === 2)) return;
  const rest = current.filter(vertex => vertex.depth === 1 && !first.some(seen => seen.item.key === vertex.item.key));
  await Promise.allSettled(rest.map(vertex => loadBranch(scene, vertex.item, 1)));
}

async function refreshNetwork(map) {
  renderMap(map, true);
  const scene = map.scene;
  if (!scene?.branches.get(scene.origin.key)?.links) return;
  await addSecondHop(map, scene);
  if (!map.root.isConnected || map.scene !== scene) return;
  renderMap(map, true);
  void loadVisibleConnections(map, scene);
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
    await loadBranch(scene, item, 0);
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

function activateBubble(map, bubble, keyboard = false) {
  if (!map.scene || map.bubbles.get(bubble.item.key) !== bubble) return;
  if (bubble.depth === 0) toggleDetails(map, bubble, keyboard);
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
      if (!map.searchOpen || !map.results.contains(button)) return;
      map.search.value = "";
      closeSearch(map);
      map.search.blur();
      void startScene(map, item);
    };
    map.results.append(button);
  }
}

function closeSearch(map) {
  map.searchOpen = false;
  map.results.replaceChildren();
}

function bindSearch(map, top) {
  const { search: input, results, root } = map;
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
      results.querySelector("button")?.focus();
      event.preventDefault();
    }
  });

  // Activate a completed tap before the browser's synthesized click.
  // Leave scrolling and canceled gestures to the browser.
  let tap = null;
  const changedTouch = event => Array.from(event.changedTouches).find(touch => touch.identifier === tap.touch.identifier);
  const moved = touch => Math.hypot(touch.clientX - tap.touch.clientX, touch.clientY - tap.touch.clientY) > 10;
  results.addEventListener("touchstart", event => {
    const button = event.target.closest?.(".scene-map-result");
    tap = button && event.touches.length === 1
      ? { button, touch: event.changedTouches[0], scrollTop: results.scrollTop } : null;
  }, { passive: true });
  results.addEventListener("touchmove", event => {
    const touch = tap && changedTouch(event);
    if (touch && moved(touch)) tap = null;
  }, { passive: true });
  results.addEventListener("touchcancel", () => { tap = null; }, { passive: true });
  results.addEventListener("touchend", event => {
    const touch = tap && changedTouch(event);
    if (!touch) return;
    const { button, scrollTop } = tap;
    const select = !event.touches.length && !moved(touch) && results.scrollTop === scrollTop && results.contains(button);
    tap = null;
    if (select) {
      if (event.cancelable) event.preventDefault();
      button.click();
    }
  }, { passive: false });

  top.addEventListener("focusout", event => {
    if (!tap && event.relatedTarget && !top.contains(event.relatedTarget)) closeSearch(map);
  });
  root.addEventListener("pointerdown", event => {
    if (top.contains(event.target)) return;
    tap = null;
    closeSearch(map);
  });
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
  const top = node("div", "scene-map-top archive-search-bar");
  const input = node("input", "archive-search");
  input.type = "search";
  input.placeholder = "What will you find?";
  input.disabled = true;
  input.setAttribute("aria-label", "Search artists, parties, venues and collectives");
  const results = node("div", "scene-map-results");
  const filters = node("div", "scene-map-filters");
  filters.hidden = true;
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
  const svg = svgNode("svg", {
    class: "scene-map-canvas", role: "group", "aria-label": "Scene connections", "aria-hidden": "true"
  });
  const graph = svgNode("g"), edgeLayer = svgNode("g"), nodeLayer = svgNode("g");
  graph.append(edgeLayer, nodeLayer);
  svg.append(graph);
  const message = node("p", "scene-map-message");
  message.hidden = true;
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

  const mobile = window.matchMedia("(max-width: 760px)");
  const map = { root, wrap, svg, graph, edgeLayer, nodeLayer, info, lineInfo, message, search: input, results, filters,
    scene: null, pendingScene: null, bubbles: new Map(), lines: [], retiringBubbles: new Map(), retiringLines: new Map(),
    phase: 0, allowed: new Set(KINDS), queerOnly: false,
    dx: 0, dy: 0, width: 0, height: 0, frameRequest: 0, dragged: null, hovered: null, skipClick: false,
    activeLine: null, searchOpen: false,
    limits: mobile.matches ? MOBILE_LIMITS : DESKTOP_LIMITS,
    reduceMotion: window.matchMedia("(prefers-reduced-motion: reduce)") };
  bindSearch(map, top);
  filters.addEventListener("change", () => {
    map.allowed = new Set([...filters.querySelectorAll("label[data-kind] input:checked")].map(box => box.value));
    map.queerOnly = queerToggle.checked;
    if (map.scene && !matchesQueerFilter(map, map.scene.origin)) map.scene = null;
    if (map.pendingScene && !matchesQueerFilter(map, map.pendingScene.origin)) map.pendingScene = null;
    closeDetails(map);
    search(map);
    if (!input.disabled) void refreshNetwork(map);
  });
  bindDrag(map);
  bindDetails(map);
  const changeDensity = ({ matches }) => {
    if (!root.isConnected) return;
    map.limits = matches ? MOBILE_LIMITS : DESKTOP_LIMITS;
    void refreshNetwork(map);
  };
  mobile.addEventListener("change", changeDensity);
  const resize = new ResizeObserver(() => {
    if (root.isConnected) layoutGraph(map);
    else {
      mobile.removeEventListener("change", changeDensity);
      resize.disconnect();
    }
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
