import { onRequestGet as archiveData } from "./api/archive.js";
import { renderEventCard } from "./live-poster.js";
import "../event-metadata.js";
import "../profile-metadata.js";

const meta = globalThis.QDPProfileMetadata;
const escape = value => String(value ?? "").replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const colors = { artist: "red", venue: "orange", party: "purple", collective: "collective" };
const accents = { artist: "#fa2b5a", venue: "#ff7945", party: "#922185", collective: "#f06eb1" };
const dateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
});
const monthFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long" });
const suffix = day => day % 100 >= 11 && day % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[day % 10] || "th");

export function renderProfileInfo(kind, profile, base) {
  const related = (profile.related || []).filter(item => colors[item.kind] && meta.validId(item.id) && item.name)
    .map(item => `<a class="event-detail-related-bubble event-detail-related-bubble--${colors[item.kind]}" href="${escape(meta.url(item.kind, item.id, base))}" data-archive-link>${escape(item.name)}</a>`).join("");
  const links = [["maps", "Map"], ["website", "Website"], ["instagram", "Instagram"], ["music", "Music"]]
    .map(([key, label]) => {
      const href = globalThis.QDPEventMetadata.safeUrl(profile[key]);
      return href ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : "";
    }).join("");
  return `<section class="archive-profile-info" aria-label="${kind[0].toUpperCase() + kind.slice(1)} information">
    <h2 class="archive-profile-heading">${escape(profile.name)}</h2>
    ${meta.classification(kind, profile) ? `<span class="sr-only">${meta.classification(kind, profile)}</span>` : ""}
    ${kind === "venue" && profile.address ? `<address>${escape(profile.address)}</address>` : ""}
    ${profile.bio ? `<p>${escape(profile.bio)}</p>` : ""}
    ${related ? `<section class="archive-profile-related"><h3>See More</h3><div class="archive-profile-related-links">${related}</div></section>` : ""}
    ${links ? `<div class="archive-profile-links">${links}</div>` : ""}</section>`;
}

export function renderProfileEvents(kind, profile, items, base, now = Date.now()) {
  const sorted = [...items].filter(event => event.eventId && Number.isFinite(Date.parse(event.start)))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) ||
      globalThis.QDPEventMetadata.cleanTitle(a).localeCompare(globalThis.QDPEventMetadata.cleanTitle(b), undefined, { sensitivity: "base" }));
  const upcoming = [], past = [];
  for (const event of sorted) {
    const start = Date.parse(event.start), end = Date.parse(event.end);
    ((Number.isFinite(end) && end >= start ? end : start) >= now ? upcoming : past).push(event);
  }
  past.reverse();
  let renderedYear = "";
  const parts = [];
  for (const [period, label, events] of [["upcoming", "Upcoming", upcoming], ["past", "Older", past]]) {
    if (!events.length) continue;
    if (period === "past" && upcoming.length) parts.push('<hr class="archive-period-divider">');
    let firstYear = "", currentMonth = "", rows = [], blocks = [];
    const flush = () => {
      if (!rows.length) return;
      const month = monthFormat.format(new Date(`${currentMonth}-15T12:00:00Z`));
      blocks.push(`<section class="archive-section" aria-label="${month.slice(0, 3)} group"><div class="event-time-group archive-group archive-profile-month"><div class="event-time" aria-label="${month} ${currentMonth.slice(0, 4)}">${month.slice(0, 3)}</div><div class="event-group-cards">${rows.join("")}</div></div></section>`);
      rows = [];
    };
    for (const [index, event] of events.entries()) {
      const date = dateFormat.format(new Date(event.start)), year = date.slice(0, 4), month = date.slice(0, 7);
      if (year !== renderedYear) {
        flush();
        renderedYear = year;
        const heading = `<h2 class="date-heading archive-year-heading">${year}</h2>`;
        if (!index) firstYear = heading; else blocks.push(heading);
      }
      if (month !== currentMonth) { flush(); currentMonth = month; }
      const href = new URL(meta.url(kind, profile.id, base));
      href.searchParams.set("event", event.eventId);
      const day = Number(date.slice(-2));
      rows.push(`<div class="event-row ${rows.length ? "same-time" : "has-time"}"><time class="archive-day-chip" datetime="${escape(event.start)}">${day}${suffix(day)}</time>${renderEventCard(event, { href: href.href, hideLocation: kind === "venue" })}</div>`);
    }
    flush();
    parts.push(`<section class="archive-event-period" data-period="${period}" aria-labelledby="archive-${period}-heading"><div class="archive-period-header"><h2 id="archive-${period}-heading" class="archive-period-heading">${label}</h2>${firstYear}</div>${blocks.join("")}</section>`);
  }
  if (!sorted.length) parts.push('<p class="event-feed-message">No events here yet.</p>');
  parts.push('<div class="date-end-spacer" aria-hidden="true"></div>');
  return parts.join("");
}

export function renderProfilePage(context, page, result, kind, id) {
  const profile = result.payload?.profile;
  const origin = context.env.QDP_CANONICAL_ORIGIN || meta.origin;
  const base = new URL(context.request.url).origin;
  const info = profile ? renderProfileInfo(kind, profile, base) : "";
  const markup = profile
    ? `<section class="mobile-profile-summary" style="--archive-profile-accent:${accents[kind]}">${info}</section>` + renderProfileEvents(kind, profile, result.payload.events, base)
    : `<p class="event-feed-message">${escape(result.error)}</p>`;
  const directory = meta.kinds[kind];
  const label = directory[0].toUpperCase() + directory.slice(1);
  let rewriter = new HTMLRewriter()
    .on("html", { element(element) { element.setAttribute("class", `${element.getAttribute("class") || ""} archive-open${profile ? " discover-open" : ""}`.trim()); } })
    .on("body", { element(element) { element.setAttribute("class", `${element.getAttribute("class") || ""} archive-mode${profile ? " discover-open" : ""}`.trim()); } })
    .on("#archiveViewport", { element(element) { element.removeAttribute("hidden"); } })
    .on("#archivePage", { element(element) { element.setAttribute("class", "archive-page is-open"); } })
    .on("#archiveStack", { element(element) { element.setAttribute("class", "event-stack archive-stack profile-events"); element.setInnerContent(markup, { html: true }); } })
    .on("#archiveHeader", { element(element) { element.setAttribute("aria-label", profile?.name || label); element.setInnerContent(profile?.name || label); } })
    .on("#archiveBack", { element(element) { element.removeAttribute("hidden"); element.setAttribute("href", new URL(`/?archive=${directory}`, base).href); element.setInnerContent(`← Back to ${label}`); } })
    .on("#qdpInitialArchive", { element(element) { element.setInnerContent(globalThis.QDPEventMetadata.serialize({ kind, id, ...result })); } });
  if (profile) {
    rewriter = rewriter
      .on("title", { element(element) { element.setInnerContent(meta.title(profile)); } })
      .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", meta.url(kind, id, origin)); } })
      .on("#archiveMenuTrack", { element(element) { element.removeAttribute("hidden"); element.setAttribute("class", "archive-menu-track is-open"); } })
      .on("#archiveMenu", { element(element) { element.setAttribute("class", "archive-menu has-profile"); } })
      .on("#archiveMenuProfile", { element(element) { element.removeAttribute("hidden"); element.setAttribute("style", `--archive-profile-accent:${accents[kind]}`); element.setInnerContent(info, { html: true }); } })
      .on(`.archive-menu-badge--${directory}`, { element(element) { element.setAttribute("aria-current", "page"); } });
    for (const [selector, content] of meta.tags(kind, profile, origin)) rewriter = rewriter.on(selector, {
      element(element) { element.setAttribute("content", content); }
    });
  }
  const rewritten = rewriter.transform(page);
  const headers = new Headers(rewritten.headers);
  headers.set("Cache-Control", result.status === 200 ? "public, max-age=60" : "no-store");
  headers.set("X-QDP-Profile", profile ? "PREPARED" : "UNAVAILABLE");
  headers.delete("ETag"); headers.delete("Content-Length");
  if (!profile) headers.set("X-Robots-Tag", "noindex");
  return new Response(rewritten.body, { status: result.status, headers });
}

export async function profilePage(context, page, kind, id) {
  if (!meta.validId(id)) return renderProfilePage(context, page, { status: 404, error: "This page is no longer available." }, kind, id);
  const key = new URL("/_qdp/profile", context.request.url);
  key.searchParams.set("kind", kind); key.searchParams.set("id", id);
  const cache = typeof caches === "undefined" ? null : caches.default;
  const cacheKey = new Request(key.href);
  const hit = await cache?.match(cacheKey);
  if (hit) return hit;
  let result;
  try {
    const url = new URL("/api/archive", context.request.url);
    url.searchParams.set("resource", kind); url.searchParams.set("id", id);
    const response = await archiveData({ ...context, request: new Request(url.href) });
    const payload = await response.json();
    if (response.ok && payload.profile?.id === id && Array.isArray(payload.events)) result = { status: 200, payload };
    else result = { status: response.status === 404 ? 404 : 503, error: response.status === 404
      ? "This page is no longer available." : "Could not load these listings right now." };
  } catch (error) {
    console.error("QDP profile unavailable:", error);
    result = { status: 503, error: "Could not load these listings right now." };
  }
  const response = renderProfilePage(context, page, result, kind, id);
  if (cache && response.status === 200) {
    const write = cache.put(cacheKey, response.clone());
    if (context.waitUntil) context.waitUntil(write); else await write;
  }
  return response;
}
