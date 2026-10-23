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
  const safeUrl = value => {
    try {
      const result = new URL(String(value || ""));
      return ["https:", "http:"].includes(result.protocol) ? result.href : "";
    } catch { return ""; }
  };
  const undisclosed = value => /not disclosed|undisclosed|see organizer|\btba\b|\btbd\b|secret location/i.test(String(value || ""));
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
    if (event.description) result.description = event.description;
    if (image(event)) result.image = [image(event)];
    const artists = (event.related || []).filter(item => item.kind === "artist");
    if (artists.length) result.performer = artists.map(item => ({ "@type": "Person", name: item.name }));
    // Price, tickets, and organizer are omitted unless the index actually supplies them.
    return result;
  };
  const description = event => String(event.description || "").replace(/\s+/g, " ").trim().slice(0, 180) || cleanTitle(event);
  const serialize = value => JSON.stringify(value).replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  globalThis.QDPEventMetadata = Object.freeze({ origin, cleanTitle, url, safeUrl, undisclosed,
    image, schema, description, serialize, title: event => `${cleanTitle(event)} | Queer Dance Philly` });
})();
