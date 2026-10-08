// The first page uses the same date, time, and card structure as app.js.
// Keep this small renderer in sync when changing the live poster markup.
const dateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
});
const timeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "numeric", minute: "2-digit"
});
const weekdayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "long"
});
const monthFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", month: "long"
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function displayTitle(event) {
  const title = String(event.title || "");
  return title.replace(/^(?:(?:🏳️‍🌈|🏳️‍⚧️|✊🏾)\s*)+/u, "").trim() || title;
}

function formatDate(key) {
  const date = new Date(`${key}T12:00:00-04:00`);
  const day = Number(key.slice(-2));
  const suffix = day % 100 >= 11 && day % 100 <= 13
    ? "th" : ["th", "st", "nd", "rd"][Math.min(day % 10, 4)] || "th";
  return `${weekdayFormat.format(date)}, ${monthFormat.format(date)} ${day}${suffix}`;
}

export function renderEventCard(event, { href, hideLocation = false } = {}) {
  const id = String(event.eventId ?? event.EventID ?? "").trim();
  const flags = `${event.queerArtist ? '<span class="card-flag card-flag-queer" aria-label="Features a queer artist" role="img"></span>' : ""}${event.transArtist ? '<span class="card-flag card-flag-trans" aria-label="Features a trans artist" role="img"></span>' : ""}`;
  const classification = event.explicitQueer ? '<span class="sr-only">Queer event. </span>' : "";
  const location = (field, value) => `<div class="${field}"${value ? "" : " hidden"}>${escapeHtml(value)}</div>`;
  return `<a class="event-card ${event.explicitQueer ? "explicit" : "default"}${event.queerArtist || event.transArtist ? " has-flags" : ""}" data-event-id="${escapeHtml(id)}" href="${escapeHtml(href || `/?event=${encodeURIComponent(id)}`)}">${classification}${flags}<span class="event-card-shape" aria-hidden="true"></span><span class="event-card-content"><div class="event-title">${escapeHtml(displayTitle(event))}</div>${hideLocation ? "" : location("event-venue", String(event.venue || "").trim()) + location("event-address", String(event.address || "").trim())}</span></a>`;
}

export function renderLivePoster(events, now = new Date()) {
  const dates = new Map();
  const sorted = [...events].sort((a, b) =>
    new Date(a.start) - new Date(b.start) ||
    String(a.title || "").replace(/🏳️‍🌈|🏳️‍⚧️|✊🏾/gu, "").trim()
      .localeCompare(String(b.title || "").replace(/🏳️‍🌈|🏳️‍⚧️|✊🏾/gu, "").trim(),
        undefined, { sensitivity: "base" })
  );
  for (const event of sorted) {
    const key = dateFormat.format(new Date(event.start));
    if (!dates.has(key)) dates.set(key, new Map());
    const times = dates.get(key);
    const timeKey = new Date(event.start).getTime();
    if (!times.has(timeKey)) times.set(timeKey, []);
    times.get(timeKey).push(event);
  }

  if (!dates.size) {
    return { markup: '<p class="event-feed-message">No upcoming listings right now.</p>', dateLabel: "" };
  }

  const today = dateFormat.format(now);
  const keys = [...dates.keys()].sort();
  const current = keys.find(key => key >= today) || keys[0];
  const markup = keys.map((key, index) => {
    const title = formatDate(key);
    const heading = index ? `<div class="date-heading">${escapeHtml(title)}</div>` : "";
    const groups = [...dates.get(key).values()].map(eventsAtTime => {
      const formatted = timeFormat.format(new Date(eventsAtTime[0].start)).replace(":00", "").replace(" ", "");
      const number = formatted.replace(/[AP]M$/, "");
      const meridiem = formatted.match(/[AP]M$/)?.[0] || "";
      const rows = eventsAtTime.map((event, rowIndex) =>
        `<div class="event-row ${rowIndex ? "same-time" : "has-time"}">${renderEventCard(event)}</div>`
      ).join("");
      return `<div class="event-time-group"><div class="event-time"><span>${escapeHtml(number)}</span><span class="event-time-meridiem">${escapeHtml(meridiem)}</span></div><div class="event-group-cards">${rows}</div></div>`;
    }).join("");
    const spacer = index === keys.length - 1 ? '<div class="date-end-spacer" aria-hidden="true"></div>' : "";
    return `<section class="date-section" aria-label="${escapeHtml(title)}">${heading}${groups}${spacer}</section>`;
  }).join("");
  return { markup, dateLabel: formatDate(current) };
}
