// Keep direct links independent of the current calendar and archive filters.
(() => {
  const meta = window.QDPEventMetadata;
  const cache = new Map();
  let initial = null;
  try {
    const text = document.getElementById("qdpInitialEvent")?.content.textContent.trim();
    if (text) initial = JSON.parse(text);
  } catch (error) { console.warn("Initial event unavailable:", error); }
  if (initial?.event) cache.set(initial.event.eventId, { at: Date.now(), promise: Promise.resolve(initial.event) });

  const selectors = [
    'meta[name="description"]', 'meta[property="og:title"]', 'meta[name="twitter:title"]',
    'meta[property="og:description"]', 'meta[name="twitter:description"]', 'meta[property="og:url"]',
    'meta[property="og:image"]', 'meta[name="twitter:image"]', 'meta[property="og:image:alt"]'
  ];
  const original = new Map(selectors.map(selector => [selector, document.querySelector(selector)?.content || ""]));
  // Direct responses contain event or profile metadata. Keep the home defaults
  // for returning to the calendar without another page request.
  if (initial?.event || document.getElementById("qdpInitialArchive")?.content.textContent.trim()) {
    original.set(selectors[0], "Find queer dance parties, DJs, venues, and nightlife in Philadelphia. Queer Dance Philly is your cheat sheet for finding the next move.");
    original.set(selectors[1], "Queer Dance Philly");
    original.set(selectors[2], "Queer Dance Philly");
    original.set(selectors[3], "Your cheat sheet for queer dance parties, DJs, venues, and nightlife in Philadelphia.");
    original.set(selectors[4], "Your cheat sheet for queer dance parties, DJs, venues, and nightlife in Philadelphia.");
    original.set(selectors[5], meta.origin + "/");
    original.set(selectors[6], meta.origin + "/qdp-share-card.jpg");
    original.set(selectors[7], meta.origin + "/qdp-share-card.jpg");
    original.set(selectors[8], "Queer Dance Philly — find the next move");
  }
  let returnTitle = null;
  const set = (selector, value) => {
    const element = document.querySelector(selector);
    if (element) element.content = value;
  };
  function apply(event) {
    if (returnTitle === null) returnTitle = initial?.event && document.title === meta.title(initial.event)
      ? "Queer Dance Philly" : document.title;
    document.title = meta.title(event);
    document.querySelector('link[rel="canonical"]')?.setAttribute("href", meta.url(event.eventId));
    set(selectors[0], meta.description(event));
    set(selectors[1], meta.title(event));
    set(selectors[2], meta.title(event));
    set(selectors[3], meta.description(event));
    set(selectors[4], meta.description(event));
    set(selectors[5], meta.url(event.eventId));
    set(selectors[6], meta.image(event) || meta.origin + "/qdp-share-card.jpg");
    set(selectors[7], meta.image(event) || meta.origin + "/qdp-share-card.jpg");
    set(selectors[8], meta.image(event) ? `Flyer for ${meta.cleanTitle(event)}` : original.get(selectors[8]));
    const data = meta.schema(event);
    let script = document.getElementById("qdpEventStructuredData");
    if (!data) { script?.remove(); return; }
    if (!script) {
      script = document.createElement("script");
      script.id = "qdpEventStructuredData";
      script.type = "application/ld+json";
      document.head.appendChild(script);
    }
    script.textContent = meta.serialize(data);
  }
  function clear() {
    if (returnTitle !== null) document.title = returnTitle;
    returnTitle = null;
    for (const [selector, content] of original) set(selector, content);
    document.querySelector('link[rel="canonical"]')?.setAttribute("href", meta.origin + "/");
    document.getElementById("qdpEventStructuredData")?.remove();
    window.QDPArchive?.restoreMetadata();
  }
  function get(id, { force = false } = {}) {
    const entry = cache.get(id);
    if (!force && entry && Date.now() - entry.at < 60000) return entry.promise;
    const promise = fetch(`/api/event?event=${encodeURIComponent(id)}`).then(async response => {
      const data = await response.json();
      if (!response.ok || data.event?.eventId !== id) {
        const error = new Error(data.error || "Event data is temporarily unavailable.");
        error.status = response.status;
        throw error;
      }
      return data.event;
    }).catch(error => { if (cache.get(id)?.promise === promise) cache.delete(id); throw error; });
    cache.set(id, { at: Date.now(), promise });
    return promise;
  }
  window.QDPEventLinks = { initial, get, apply, clear };
})();
