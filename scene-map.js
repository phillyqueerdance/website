import { DIRECTORY_FOR, KINDS, keyOf, connectionsFor, pickConnections, upcomingFor,
  relationshipText } from "./scene-map-graph.js?v=20261110-scene-map-4";

const NS = "http://www.w3.org/2000/svg";
const labels = { artist: "Artist", party: "Party", venue: "Venue", collective: "Collective" };
const known = new Map(), cache = new Map();

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

function closeDetails(map) {
  map.info.hidden = true;
  map.svg.querySelector(".scene-map-node.focus")?.setAttribute("aria-expanded", "false");
}

function toggleDetails(map, item, bubble) {
  if (!map.info.hidden) {
    closeDetails(map);
    return;
  }
  const heading = node("div", "scene-map-detail-heading");
  const close = node("button", "scene-map-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close profile details");
  close.onclick = () => {
    closeDetails(map);
    map.svg.querySelector(".scene-map-node.focus")?.focus();
  };
  heading.append(node("strong", "", item.name), typePill(item.kind), close);
  map.info.replaceChildren(heading);

  const edge = map.links.find(link => link.key === map.path.at(-2)?.key);
  if (edge) {
    map.info.append(node("p", "scene-map-note", edge.name + " · " + relationshipText(item, edge)));
    for (const event of edge.examples.slice(0, 2)) {
      map.info.append(anchor(event.title, qdpUrl({ id: event.id }, true)));
    }
  }
  const upcoming = upcomingFor(item, map.events, Date.now(), 2);
  for (const event of upcoming) map.info.append(anchor("Upcoming: " + event.title, qdpUrl(event, true)));
  if (!upcoming.length) map.info.append(node("p", "scene-map-note", "No upcoming events listed here."));
  map.info.append(anchor("View QDP profile", qdpUrl(item)));
  map.info.hidden = false;
  bubble.setAttribute("aria-expanded", "true");
}

function drawBubble(map, item, x, y, radius, selected = false) {
  const countText = selected ? "" : item.count + (item.count === 1 ? " shared event" : " shared events");
  const bubble = svgNode("g", {
    class: "scene-map-node" + (selected ? " focus" : ""),
    "data-kind": item.kind,
    transform: "translate(" + x + " " + y + ")",
    role: "button",
    tabindex: "0",
    "aria-label": (selected ? "Details for " : "Explore ") + item.name
  });
  if (selected) bubble.setAttribute("aria-expanded", String(!map.info.hidden));
  else bubble.setAttribute("aria-description", countText);
  bubble.append(svgNode("title", {}, [item.name, labels[item.kind], countText].filter(Boolean).join(" · ")));
  bubble.append(svgNode("circle", { r: radius }));

  const caption = svgNode("foreignObject", {
    class: "scene-map-caption", "aria-hidden": "true",
    x: -radius * .88, y: -radius * .68, width: radius * 1.76, height: radius * 1.36
  });
  const captionBody = node("div", "scene-map-caption-body");
  captionBody.style.fontSize = Math.max(11, Math.min(25, radius * .39)) + "px";
  captionBody.append(node("span", "scene-map-caption-name", item.name));
  caption.append(captionBody);
  bubble.append(caption);

  const activate = () => selected ? toggleDetails(map, item, bubble) : visit(map, item);
  bubble.addEventListener("click", activate);
  bubble.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  });
  map.graph.append(bubble);
}

function draw(map) {
  map.svg.replaceChildren();
  map.graph = null;
  const width = map.wrap.clientWidth, height = map.wrap.clientHeight;
  if (!map.focus || !width || !height) return;

  map.svg.setAttribute("viewBox", "0 0 " + width + " " + height);
  map.graph = svgNode("g", { transform: "translate(" + map.dx + " " + map.dy + ")" });
  map.svg.append(map.graph);

  const eligible = map.links.filter(item => visibleConnection(map, item));
  const links = pickConnections(eligible, 9, map.path.at(-2)?.key);
  const shortSide = Math.min(width, height);
  const centerX = width / 2, centerY = height / 2;
  const minRadius = shortSide * .075;
  const maxRadius = shortSide * (links.length > 6 ? .112 : .136);
  const maxCount = Math.max(4, ...links.map(item => item.count));
  const padding = Math.min(8, shortSide * .02);
  const arcX = centerX - maxRadius - padding, arcY = centerY - maxRadius - padding;
  const startAngle = links.length < 3 && width >= height ? 0 : -Math.PI / 2;
  const points = links.map((item, index) => {
    const angle = startAngle + (2 * Math.PI * index) / links.length;
    // Keep the size differences between the first few counts easy to see
    // while allowing a heavily repeated relationship to fit in the frame.
    const strength = Math.log(item.count) / Math.log(maxCount);
    return {
      item, strength,
      x: centerX + Math.cos(angle) * arcX,
      y: centerY + Math.sin(angle) * arcY,
      radius: minRadius + (maxRadius - minRadius) * strength
    };
  });
  for (const point of points) {
    map.graph.append(svgNode("line", {
      x1: centerX, y1: centerY, x2: point.x, y2: point.y,
      class: "scene-map-edge", "stroke-width": 2 + point.strength * 4
    }));
  }
  for (const point of points) drawBubble(map, point.item, point.x, point.y, point.radius);
  drawBubble(map, map.focus, centerX, centerY, shortSide * .16, true);
}

function renderMap(map) {
  draw(map);
  if (!map.focus) {
    setMessage(map, "Search for something you know to begin.");
    return;
  }
  setMessage(map, map.links.some(item => visibleConnection(map, item)) ? "" : "No connections match these filters.");
}

function historyPath(map) {
  map.crumbs.replaceChildren();
  map.path.forEach((item, index) => {
    if (index) map.crumbs.append(node("span", "", "›"));
    const button = node("button", "", item.name);
    button.type = "button";
    button.onclick = () => visit(map, item, index);
    map.crumbs.append(button);
  });
  map.crumbs.hidden = !map.path.length;
}

async function visit(map, item, pathIndex) {
  if (map.busy || !matchesQueerFilter(map, item)) return;
  map.busy = true;
  closeDetails(map);
  setMessage(map, "Loading " + item.name + "…");
  try {
    const data = await profile(item);
    if (!map.root.isConnected || !matchesQueerFilter(map, item)) return;
    map.focus = item;
    map.events = data.events;
    map.links = connectionsFor(item, data.events, known);
    map.dx = map.dy = 0;
    const previousIndex = pathIndex === undefined ? -1 : map.path.lastIndexOf(item, pathIndex);
    if (previousIndex >= 0) map.path = map.path.slice(0, previousIndex + 1);
    if (map.path.at(-1)?.key !== item.key) map.path.push(item);
    historyPath(map);
    renderMap(map);
  } catch (error) {
    if (map.root.isConnected && matchesQueerFilter(map, item)) setMessage(map, error.message);
  } finally {
    map.busy = false;
  }
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
      visit(map, item);
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

function bindPan(map) {
  let pan = null;
  map.svg.addEventListener("pointerdown", event => {
    if (!map.graph || event.button !== 0 || pan || event.target.closest(".scene-map-node")) return;
    pan = { pointerId: event.pointerId, x: event.clientX - map.dx, y: event.clientY - map.dy };
    map.svg.setPointerCapture(event.pointerId);
  });
  map.svg.addEventListener("pointermove", event => {
    if (!pan || pan.pointerId !== event.pointerId || !map.graph) return;
    const limitX = map.wrap.clientWidth * .4, limitY = map.wrap.clientHeight * .4;
    map.dx = Math.max(-limitX, Math.min(limitX, event.clientX - pan.x));
    map.dy = Math.max(-limitY, Math.min(limitY, event.clientY - pan.y));
    map.graph.setAttribute("transform", "translate(" + map.dx + " " + map.dy + ")");
  });
  map.svg.addEventListener("lostpointercapture", () => { pan = null; });
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
  const message = node("p", "scene-map-message", "Loading public QDP directory…");
  message.setAttribute("role", "status");
  const info = node("section", "scene-map-detail");
  info.hidden = true;
  info.setAttribute("aria-label", "Profile details");
  wrap.append(svg, message, info);
  root.append(top, crumbs, wrap);
  host.replaceChildren(root);

  const map = { root, wrap, svg, graph: null, info, message, crumbs, search: input, results,
    focus: null, events: [], links: [], path: [], allowed: new Set(KINDS), queerOnly: false, dx: 0, dy: 0, busy: false };
  input.addEventListener("input", () => search(map));
  filters.addEventListener("change", () => {
    map.allowed = new Set([...filters.querySelectorAll("label[data-kind] input:checked")].map(box => box.value));
    map.queerOnly = queerToggle.checked;
    if (map.queerOnly) {
      map.path = map.path.filter(isQueer);
      if (map.focus && !isQueer(map.focus)) {
        map.focus = null;
        map.events = [];
        map.links = [];
        map.path = [];
      }
    }
    closeDetails(map);
    historyPath(map);
    search(map);
    if (!input.disabled) renderMap(map);
  });
  bindPan(map);
  const resize = new ResizeObserver(() => {
    if (root.isConnected) draw(map);
    else resize.disconnect();
  });
  resize.observe(wrap);

  try {
    await loadDirectories();
    if (!root.isConnected) return;
    input.disabled = false;
    const focus = known.get(new URL(location.href).searchParams.get("focus"));
    if (focus && matchesQueerFilter(map, focus)) await visit(map, focus);
    else renderMap(map);
  } catch (error) {
    if (root.isConnected) setMessage(map, error.message);
  }
}
