import { onRequestGet as getEventFeed } from "./functions/api/events.js";

const SITE_ORIGIN = "https://queerdancephilly.com";

export function eventIdOf(event) {
  return String(event.eventId ?? event.EventID ?? "").trim();
}

export function eventSlug(event) {
  return eventIdOf(event).toLowerCase();
}

export function eventPath(event) {
  return `/event/${encodeURIComponent(eventSlug(event))}`;
}

export function canonicalEventUrl(event) {
  return SITE_ORIGIN + eventPath(event);
}

export function publicEventTitle(event) {
  const title = String(event.title || "");
  return title.replace(/^(?:(?:🏳️‍🌈|🏳️‍⚧️|✊🏾)\s*)+/u, "").trim() || title;
}

export function usableVenue(event) {
  const venue = String(event.venue || "").trim();
  return /^(?:location not disclosed|outdoor location|philadelphia, location tba)$/i.test(venue)
    ? "" : venue;
}

function publicDescription(event) {
  const text = String(event.description || "").replace(/\r\n?/g, "\n");
  const footerStart = text.search(
    /^\s*(?:-{3,}|—+)\s*QDP (?:WEB|IDs)\s*(?:-{3,}|—+)\s*$/im
  );
  return (footerStart >= 0 ? text.slice(0, footerStart) : text).trim();
}

function eventImage(event) {
  const value = String(event.flyerUrl || "").trim();
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? value : "";
  } catch {
    return "";
  }
}

export function eventBrowserTitle(event) {
  const date = new Date(event.start);
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric"
  }).format(date);
  const venue = usableVenue(event);
  return `${publicEventTitle(event)} ${venue ? `at ${venue}` : "in Philadelphia"} – ${dateLabel} | Queer Dance Philly`;
}

export function eventJsonLd(event) {
  const data = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: publicEventTitle(event),
    startDate: event.start,
    url: canonicalEventUrl(event)
  };
  if (event.end) data.endDate = event.end;
  const description = publicDescription(event);
  if (description) data.description = description;
  const image = eventImage(event);
  if (image) data.image = image;
  const venue = usableVenue(event);
  const address = String(event.address || "").trim();
  if (venue || (address && !/^see organizer for details\.?$/i.test(address))) {
    data.location = { "@type": "Place" };
    if (venue) data.location.name = venue;
    if (address && !/^see organizer for details\.?$/i.test(address)) {
      data.location.address = { "@type": "PostalAddress", streetAddress: address };
    }
  }
  return data;
}

export async function publicEvents(context) {
  const feed = await getEventFeed({
    request: new Request(new URL("/api/events", context.request.url)),
    waitUntil: task => context.waitUntil(task)
  });
  if (!feed.ok) return null;
  const payload = await feed.json();
  return Array.isArray(payload.events) ? payload.events : null;
}

export function eventResponse(page, event) {
  const title = publicEventTitle(event);
  const shareTitle = `Check out ${title} on Queer Dance Philly`;
  const canonical = canonicalEventUrl(event);
  const description = publicDescription(event);
  const image = eventImage(event);
  const json = JSON.stringify(eventJsonLd(event)).replace(/</g, "\\u003c");

  const setContent = value => ({
    element(element) { element.setAttribute("content", value); }
  });
  const setImage = {
    element(element) {
      if (image) element.setAttribute("content", image);
      else element.remove();
    }
  };
  const rewritten = new HTMLRewriter()
    .on("title", {
      element(element) { element.setInnerContent(eventBrowserTitle(event)); }
    })
    .on('meta[name="description"]', setContent(description))
    .on('meta[property="og:title"]', setContent(shareTitle))
    .on('meta[name="twitter:title"]', setContent(shareTitle))
    .on('meta[property="og:description"]', setContent(description))
    .on('meta[property="og:url"]', setContent(canonical))
    .on('link[rel="canonical"]', {
      element(element) { element.setAttribute("href", canonical); }
    })
    .on('meta[property="og:image"]', setImage)
    .on('meta[name="twitter:image"]', setImage)
    .on('meta[property="og:image:type"]', { element(element) { element.remove(); } })
    .on('meta[property="og:image:width"]', { element(element) { element.remove(); } })
    .on('meta[property="og:image:height"]', { element(element) { element.remove(); } })
    .on('meta[property="og:image:alt"]', { element(element) { element.remove(); } })
    .on("head", {
      element(element) {
        element.append(`<script type="application/ld+json" data-qdp-event>${json}</script>`, { html: true });
      }
    })
    .transform(page);

  const headers = new Headers(rewritten.headers);
  headers.set("Cache-Control", "public, max-age=300");
  headers.delete("ETag");
  headers.delete("Content-Length");
  return new Response(rewritten.body, {
    status: rewritten.status, statusText: rewritten.statusText, headers
  });
}
