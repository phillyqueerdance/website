// Shared by the Pages renderer and the existing browser popup.
(() => {
  const origin = "https://queerdancephilly.com";
  const cleanTitle = event => String(event.title || "")
    .replace(/^(?:(?:🏳️‍🌈|🏳️‍⚧️|✊🏾)\s*)+/u, "").trim();
  const url = (id, base = origin) => {
    const result = new URL("/", base);
    result.searchParams.set("event", id);
    return result.href;
  };
  // Public JSON carries its source with the description. QDP renders only the
  // original event copy, including when an API result is opened from Discover.
  const sourceNotice = "Reading this outside Queer Dance Philly? You’re viewing a copy of a QDP listing. Check QDP for the full calendar and any updates or corrections.";
  const displayDescription = value => {
    const text = String(value ?? "").replace(/\r\n?/g, "\n");
    if (!text.startsWith(`${sourceNotice}\nOriginal listing: ${origin}/`)) return text;
    const start = text.indexOf("\n\n");
    return start < 0 ? "" : text.slice(start + 2);
  };
  const exportEvent = event => ({ ...event,
    description: `${sourceNotice}\nOriginal listing: ${event.eventId ? url(event.eventId) : `${origin}/`}\n\n${displayDescription(event.description)}`
  });
  const exportPayload = payload => ({ ...payload,
    ...(Array.isArray(payload.events) ? { events: payload.events.map(exportEvent) } : {}),
    ...(payload.event ? { event: exportEvent(payload.event) } : {})
  });
  const safeUrl = value => {
    try {
      const result = new URL(String(value || ""));
      return ["https:", "http:"].includes(result.protocol) ? result.href : "";
    } catch { return ""; }
  };
  const undisclosed = value => /not disclosed|undisclosed|see organizer|\btba\b|\btbd\b|secret location/i.test(String(value || ""));
  const usesValsMeltStrip = event => {
    if (String(event.partyId || "").trim().toUpperCase() !== "MELT-001") return false;
    const venueId = String(event.venueId || "").trim().toUpperCase();
    if (venueId) return venueId === "VALS-001";
    return /^val['’]?s(?: lesbian bar)?$/i.test(String(event.venue || "").trim());
  };
  const image = event => {
    const source = safeUrl(event.flyerUrl);
    if (!source) return "";
    const parsed = new URL(source);
    if (parsed.hostname === "drive.google.com") {
      const id = parsed.pathname.match(/^\/file\/d\/([\w-]+)/)?.[1] || parsed.searchParams.get("id");
      if (id && /^[\w-]+$/.test(id)) return `https://lh3.googleusercontent.com/d/${id}=w1600`;
    }
    return source;
  };
  const schema = (event, base = origin) => {
    // Missing public location data must never be replaced with a private address.
    const address = String(event.address || "").trim();
    const venue = String(event.venue || "").trim();
    if (!address || !venue || undisclosed(address) || undisclosed(venue) ||
        !cleanTitle(event) || Number.isNaN(Date.parse(event.start))) return null;
    const result = {
      "@context": "https://schema.org", "@type": "Event",
      "@id": url(event.eventId, base), url: url(event.eventId, base),
      name: cleanTitle(event), startDate: event.start,
      location: { "@type": "Place", name: venue, address: { "@type": "PostalAddress", streetAddress: address } },
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode"
    };
    if (event.end && Date.parse(event.end) >= Date.parse(event.start)) result.endDate = event.end;
    const copy = displayDescription(event.description);
    if (copy) result.description = copy;
    if (image(event)) result.image = [image(event)];
    const artists = (event.related || []).filter(item => item.kind === "artist");
    if (artists.length) result.performer = artists.map(item => ({ "@type": "Person", name: item.name }));
    // Price, tickets, and organizer are omitted unless the index actually supplies them.
    return result;
  };
  const description = event => displayDescription(event.description).replace(/\s+/g, " ").trim().slice(0, 180) || cleanTitle(event);
  const serialize = value => JSON.stringify(value).replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  globalThis.QDPEventMetadata = Object.freeze({ origin, cleanTitle, url, sourceNotice, displayDescription, exportEvent, exportPayload, safeUrl, undisclosed,
    image, schema, description, serialize, usesValsMeltStrip, title: event => `${cleanTitle(event)} | Queer Dance Philly` });
})();
