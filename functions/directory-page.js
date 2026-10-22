import { onRequestGet as archiveData } from "./api/archive.js";
import { withKvScope, cacheResponse, freshResponse, inheritCacheDeadline } from "./kv-cache.js";
import "../event-metadata.js";
import "../profile-metadata.js";

const meta = globalThis.QDPProfileMetadata;
const escape = value => String(value ?? "").replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

// Match the existing directory's alphabet, ordering, and card treatments.
function sortName(name) {
  let key = String(name || "").trim().replace(/^\[(.*)\]$/s, "$1").trim();
  const full = key;
  while (/^The\b[\s.:-]+/i.test(key)) key = key.replace(/^The\b[\s.:-]+/i, "").trim();
  return key || full;
}

function initial(name) {
  const first = String(name || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/^[^a-z0-9]+/i, "")[0]?.toUpperCase();
  return /^[A-Z]$/.test(first || "") ? first : "#";
}

export function renderDirectory(directory, items, base) {
  const kind = meta.directories[directory].kind;
  const profiles = items.filter(item => meta.validId(item.id) && item.name).sort((a, b) => {
    const aKey = sortName(a.name), bKey = sortName(b.name);
    return collator.compare(initial(aKey), initial(bKey)) || collator.compare(aKey, bKey);
  });
  if (!profiles.length) return `<p class="event-feed-message">No ${directory} in the archive yet.</p>`;
  const sections = [];
  let letter = "", rows = [];
  const flush = () => {
    if (rows.length) sections.push(`<section class="archive-section" data-letter="${letter}" aria-label="${letter} group"><div class="event-time-group archive-group archive-directory"><div class="event-time">${letter}</div><div class="event-group-cards">${rows.join("")}</div></div></section>`);
    rows = [];
  };
  for (const item of profiles) {
    const next = initial(sortName(item.name));
    if (letter !== next) { flush(); letter = next; }
    const classification = meta.classification(kind, item);
    const classes = ["event-card", "default", "archive-card"];
    if (directory === "parties" && item.id.toUpperCase() === "MELT-001") classes.push("melt");
    if (classification) classes.push("archive-identity-card");
    const address = directory === "venues" && item.address
      ? `<span class="event-venue">${escape(item.address)}</span>` : "";
    rows.push(`<div class="event-row ${rows.length ? "same-time" : "has-time"}"><a class="${classes.join(" ")}" href="${escape(meta.url(kind, item.id, base))}" data-archive-link>${classification ? `<span class="sr-only">${classification} </span>` : ""}<span class="event-card-shape"></span><span class="event-card-content"><span class="event-title">${escape(item.name)}</span>${address}</span></a></div>`);
  }
  flush();
  return sections.join("");
}

export function renderDirectoryPage(context, page, result, directory) {
  const origin = context.env.QDP_CANONICAL_ORIGIN || meta.origin;
  const base = new URL(context.request.url).origin;
  const label = directory[0].toUpperCase() + directory.slice(1);
  const ready = result.status === 200;
  const markup = ready ? renderDirectory(directory, result.payload[directory], base)
    : `<p class="event-feed-message">${escape(result.error)}</p>`;
  let rewriter = new HTMLRewriter()
    .on("title", { element(element) { element.setInnerContent(meta.directories[directory].title); } })
    .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", meta.directoryUrl(directory, origin)); } })
    .on("html", { element(element) { element.setAttribute("class", `${element.getAttribute("class") || ""} archive-open discover-open`.trim()); } })
    .on("body", { element(element) { element.setAttribute("class", `${element.getAttribute("class") || ""} archive-mode discover-open`.trim()); } })
    .on("#archiveViewport", { element(element) { element.removeAttribute("hidden"); } })
    .on("#archivePage", { element(element) { element.setAttribute("class", "archive-page is-open"); } })
    .on("#archiveStack", { element(element) { element.setAttribute("class", "event-stack archive-stack"); element.setInnerContent(markup, { html: true }); } })
    .on("#archiveHeader", { element(element) { element.setAttribute("aria-label", label); element.setInnerContent(label); } })
    .on("#archiveMenuTrack", { element(element) { element.removeAttribute("hidden"); element.setAttribute("class", "archive-menu-track is-open"); } })
    .on("#discoverLink", { element(element) { element.setAttribute("aria-expanded", "true"); } })
    .on(`.archive-menu-badge--${directory}`, { element(element) { element.setAttribute("aria-current", "page"); } })
    .on("#qdpInitialArchive", { element(element) { element.setInnerContent(globalThis.QDPEventMetadata.serialize({ kind: directory, id: "", ...result })); } });
  if (directory === "venues") rewriter = rewriter.on("#archiveVenueMap", {
    element(element) { element.removeAttribute("hidden"); }
  });
  for (const [selector, content] of meta.directoryTags(directory, origin)) rewriter = rewriter.on(selector, {
    element(element) { element.setAttribute("content", content); }
  });
  const rewritten = rewriter.transform(page);
  const headers = new Headers(rewritten.headers);
  headers.set("Cache-Control", ready ? "public, max-age=60" : "no-store");
  headers.set("X-QDP-Directory", ready ? "PREPARED" : "UNAVAILABLE");
  headers.delete("ETag"); headers.delete("Content-Length");
  if (!ready) headers.set("X-Robots-Tag", "noindex");
  return new Response(rewritten.body, { status: result.status, headers });
}

export async function directoryPage(context, page, directory) {
  context = withKvScope(context);
  const key = new URL("/_qdp/directory-v1", context.request.url);
  key.searchParams.set("kind", directory);
  const cache = typeof caches === "undefined" ? null : caches.default;
  const cacheKey = new Request(key.href);
  const hit = freshResponse(await cache?.match(cacheKey), context);
  if (hit) return hit;
  let result;
  try {
    const url = new URL("/api/archive", context.request.url);
    url.searchParams.set("resource", directory);
    const response = await archiveData({ ...context, request: new Request(url.href) });
    inheritCacheDeadline(context, response);
    const payload = await response.json();
    result = response.ok && Array.isArray(payload[directory]) ? { status: 200, payload }
      : { status: 503, error: "Could not load these listings right now." };
  } catch (error) {
    console.error("QDP directory unavailable:", error);
    result = { status: 503, error: "Could not load these listings right now." };
  }
  const response = cacheResponse(context, renderDirectoryPage(context, page, result, directory), 60);
  if (cache && response.status === 200) {
    const write = cache.put(cacheKey, response.clone());
    if (context.waitUntil) context.waitUntil(write); else await write;
  }
  return response;
}
