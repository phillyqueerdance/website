import "../event-metadata.js";
const meta = globalThis.QDPEventMetadata;
const escape = value => String(value ?? "").replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const dateLabel = event => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
  weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(event.start));
const timeLabel = event => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
  hour: "numeric", minute: "2-digit" }).format(new Date(event.start)).replace(":00", "").replace(" ", "");
function calendarUrl(event, origin) {
  const start = new Date(event.start);
  const supplied = new Date(event.end);
  const end = supplied > start ? supplied : new Date(start.getTime() + 3600000);
  const utc = value => value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const result = new URL("https://calendar.google.com/calendar/r/eventedit");
  result.search = new URLSearchParams({ action: "TEMPLATE", text: meta.cleanTitle(event),
    dates: `${utc(start)}/${utc(end)}`, stz: "America/New_York", etz: "America/New_York",
    location: [event.venue, event.address].filter(Boolean).join(", "),
    details: [event.description, meta.url(event.eventId, origin)].filter(Boolean).join("\n\n") }).toString();
  return result.href;
}
export function renderEventDetail(event, requestUrl) {
  const url = new URL(requestUrl);
  const back = new URL(url);
  back.searchParams.delete("event");
  const image = meta.image(event);
  const map = event.venue && !meta.undisclosed(event.venue) && !meta.undisclosed(event.address)
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([event.venue, event.address].filter(Boolean).join(", "))}` : "";
  const related = (event.related || []).map(item => {
    const target = new URL("/", url);
    target.searchParams.set("archive", item.kind);
    target.searchParams.set("id", item.id);
    const color = { artist: "red", venue: "orange", party: "purple", collective: "collective" }[item.kind];
    return `<a class="event-detail-related-bubble event-detail-related-bubble--${color}" href="${escape(target.href)}" data-archive-link>${escape(item.name)}</a>`;
  }).join("");
  const flags = [[event.queerArtist, "queer"], [event.transArtist, "trans"]]
    .filter(([enabled]) => enabled).map(([, type]) => `<span class="event-detail-flag event-detail-flag-${type}" role="img" aria-label="Features a ${type} artist"></span>`).join("");
  return `${flags}<div class="event-detail-date-badge"><span class="event-detail-date-text">${escape(dateLabel(event))}</span></div>
    <article class="event-detail-card${image ? "" : " without-flyer"}">
      ${image ? `<div class="event-detail-flyer-slot"><img class="event-detail-flyer" src="${escape(image)}" alt="Flyer for ${escape(meta.cleanTitle(event))}" referrerpolicy="no-referrer"></div>` : ""}
      <div class="event-detail-title-location"><h2 id="eventDetailTitle">${escape(meta.cleanTitle(event))}</h2>
        <p class="event-detail-venue-time">${map ? `<a href="${escape(map)}" target="_blank" rel="noopener noreferrer">${escape(event.venue)}</a>` : escape(event.venue)}
          ${event.venue ? '<span aria-hidden="true"> | </span>' : ""}<time datetime="${escape(event.start)}">${escape(timeLabel(event))}</time></p>
        ${event.address ? `<p class="event-detail-address">${escape(event.address)}</p>` : ""}</div>
      <div class="event-detail-more">${event.description ? `<p>${escape(event.description)}</p>` : ""}
        <div class="event-detail-actions"><a href="${escape(calendarUrl(event, url.origin))}" target="_blank" rel="noopener noreferrer" aria-label="Add to Google Calendar"><img class="event-detail-action-icon" src="/icons8-ios-calendar-48.png" alt=""></a></div></div>
      ${related ? `<section class="event-detail-see-more" aria-label="See More"><h3>See More</h3><div class="event-detail-see-more-links">${related}</div></section>` : ""}
    </article><a class="event-detail-back" href="${escape(back.href)}">← Back</a>`;
}

export function renderEventPage(context, page, result, id) {
  const event = result.event;
  const origin = context.env.QDP_CANONICAL_ORIGIN || meta.origin;
  let rewriter = new HTMLRewriter()
    .on("#eventStack", { element(element) { element.setAttribute("hidden", ""); element.setInnerContent(""); } })
    .on("#eventDetail", { element(element) {
      element.removeAttribute("hidden");
      element.setAttribute("class", `event-detail is-open${event?.explicitQueer ? " explicit" : ""}`);
      element.setAttribute("role", "dialog");
      element.setAttribute("aria-modal", "true");
      element.setAttribute("aria-labelledby", "eventDetailTitle");
      element.setAttribute("tabindex", "-1");
      const body = event ? renderEventDetail(event, context.request.url) :
        `<article class="event-detail-card without-flyer"><h2 id="eventDetailTitle">${escape(result.error)}</h2><a href="/">← Back to Calendar</a></article>`;
      element.setInnerContent(body, { html: true });
    } })
    .on("#qdpInitialEvent", { element(element) { element.setInnerContent(meta.serialize({ ...result, id })); } });
  if (event) {
    const values = [
      ['meta[name="description"]', meta.description(event)],
      ['meta[property="og:title"]', meta.title(event)],
      ['meta[name="twitter:title"]', meta.title(event)],
      ['meta[property="og:description"]', meta.description(event)],
      ['meta[property="og:url"]', meta.url(id, origin)],
      ['meta[property="og:image"]', meta.image(event) || new URL("/qdp-share-card.jpg", origin).href],
      ['meta[property="og:image:alt"]', meta.image(event) ? `Flyer for ${meta.cleanTitle(event)}` : 'Queer Dance Philly — find the next move'],
      ['meta[name="twitter:image"]', meta.image(event) || new URL("/qdp-share-card.jpg", origin).href]
    ];
    rewriter = rewriter.on("title", { element(element) { element.setInnerContent(meta.title(event)); } })
      .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", meta.url(id, origin)); } })
      .on('meta[property="og:image:width"], meta[property="og:image:height"], meta[property="og:image:type"]', {
        element(element) { if (meta.image(event)) element.remove(); }
      });
    for (const [selector, content] of values) rewriter = rewriter.on(selector, {
      element(element) { element.setAttribute("content", content); }
    });
    const data = meta.schema(event, origin);
    if (data) rewriter = rewriter.on("head", { element(element) {
      element.append(`<script id="qdpEventStructuredData" type="application/ld+json">${meta.serialize(data)}</script>`, { html: true });
    } });
    rewriter = rewriter.on("#dateLabel", { element(element) { element.setInnerContent(dateLabel(event)); } });
  }
  const rewritten = rewriter.transform(page);
  const headers = new Headers(rewritten.headers);
  headers.set("Cache-Control", result.status === 200 ? "public, max-age=60" : "no-store");
  headers.set("X-QDP-Event", event ? (result.indexed ? "INDEXED" : "COMPATIBILITY") : "UNAVAILABLE");
  headers.delete("Content-Length");
  headers.delete("ETag");
  if (!event) headers.set("X-Robots-Tag", "noindex");
  return new Response(rewritten.body, { status: result.status, headers });
}
