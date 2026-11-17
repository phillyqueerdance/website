const ADMIN_API_URL = "/admin/api";
const COVERAGE_DAYS = 28;
const DUPLICATE_START_WINDOW_MS = 3 * 60 * 60 * 1000;

const phillyDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});
const coverageDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric"
});
const coverageLabelFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
  month: "long",
  day: "numeric"
});

const elements = {
  refreshButton: document.getElementById("refreshButton"),
  dashboardState: document.getElementById("dashboardState"),
  dashboardContent: document.getElementById("dashboardContent"),
  reviewButtons: document.querySelectorAll(".review-row"),
  flyerCoverage: document.getElementById("flyerCoverage"),
  coverageBody: document.getElementById("coverageBody"),
  coverageDateOption: document.getElementById("coverageDateOption"),
  integrityEventOption: document.getElementById("integrityEventOption"),
  eventsPanel: document.getElementById("events"),
  pullButton: document.getElementById("pullButton"),
  pushButton: document.getElementById("pushButton"),
  syncStatusIssue: document.getElementById("syncStatusIssue"),
  saveAllButton: document.getElementById("saveAllButton"),
  unsavedSummary: document.getElementById("unsavedSummary"),
  saveAllHelp: document.getElementById("saveAllHelp"),
  syncProgress: document.getElementById("syncProgress"),
  pendingSummary: document.getElementById("pendingSummary"),
  searchInput: document.getElementById("searchInput"),
  filterSelect: document.getElementById("filterSelect"),
  loadingState: document.getElementById("loadingState"),
  eventList: document.getElementById("eventList"),
  emptyState: document.getElementById("emptyState"),
  eventCount: document.getElementById("eventCount"),
  eventTemplate: document.getElementById("eventTemplate"),
  lastPull: document.getElementById("lastPull"),
  lastPush: document.getElementById("lastPush"),
  pendingCount: document.getElementById("pendingCount"),
  outsidePendingCount: document.getElementById("outsidePendingCount"),
  websiteCount: document.getElementById("websiteCount"),
  upcomingCount: document.getElementById("upcomingCount"),
  hiddenCount: document.getElementById("hiddenCount"),
  activeCount: document.getElementById("activeCount"),
  statusUpdated: document.getElementById("statusUpdated"),
  syncWindow: document.getElementById("syncWindow"),
  cacheNote: document.getElementById("cacheNote"),
  toast: document.getElementById("toast")
};

const state = {
  events: [],
  status: null,
  artists: [],
  venues: [],
  parties: [],
  integrityEventId: "",
  artistById: new Map(),
  venueById: new Map(),
  drafts: new Map(),
  cards: new Map(),
  dashboardViews: new Map(),
  feedFlyers: new Map(),
  flyerRequest: 0,
  busy: false,
  refreshing: false,
  capabilities: {},
  referencesVersion: "",
  syncJob: null,
  syncPollTimer: null,
  syncPollFailures: 0,
  searchTimer: null,
  toastTimer: null
};

function phillyDateKey(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const parts = Object.fromEntries(
    phillyDateFormatter.formatToParts(date).map(({ type, value }) => [type, value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isUpcoming(event, todayKey = phillyDateKey(new Date())) {
  const eventKey =
    phillyDateKey(
      event.end || event.start
    );

  return Boolean(
    eventKey &&
    todayKey &&
    eventKey >= todayKey
  );
}

function normalizeListingName(value) {
  return value.normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function similarListingTitles(left, right) {
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length < 4) return false;
  if (` ${longer} `.includes(` ${shorter} `)) return true;
  if (longer.length - shorter.length > 1) return false;

  let mismatch = 0;
  while (mismatch < shorter.length && shorter[mismatch] === longer[mismatch]) {
    mismatch++;
  }

  if (shorter.length < longer.length) {
    return shorter.slice(mismatch) === longer.slice(mismatch + 1);
  }

  return shorter.slice(mismatch + 1) === longer.slice(mismatch + 1) ||
    (shorter[mismatch] === longer[mismatch + 1] &&
      shorter[mismatch + 1] === longer[mismatch] &&
      shorter.slice(mismatch + 2) === longer.slice(mismatch + 2));
}

function findPossibleDuplicates(events, today, now) {
  const { cleanTitle, undisclosed } = window.QDPEventMetadata;
  const { dayKey } = window.QDPLiveCalendar;
  const currentNight = dayKey(now);
  const byNight = new Map();
  const duplicateIds = new Set();

  for (const event of events) {
    const publicTitle = cleanTitle({ title: event.publicTitle });
    const title = normalizeListingName(publicTitle) || publicTitle.replace(/\s+/g, " ").toLowerCase();
    const start = Date.parse(event.start);
    if (!title || !Number.isFinite(start)) continue;

    const night = dayKey(start);
    if (night < currentNight && !isUpcoming(event, today)) continue;

    const place = String(event.venueName || event.location || "");
    const venueId = event.venueId?.trim().toUpperCase();
    const venueName = undisclosed(place) ? "" : normalizeListingName(place);
    const candidates = byNight.get(night) || [];

    for (const other of candidates) {
      if (Math.abs(start - other.start) > DUPLICATE_START_WINDOW_MS) continue;

      const sameVenue = venueId && other.venueId
        ? venueId === other.venueId
        : venueName && venueName === other.venueName;
      if (title === other.title || (sameVenue && similarListingTitles(title, other.title))) {
        duplicateIds.add(event.eventId);
        duplicateIds.add(other.eventId);
      }
    }

    candidates.push({ eventId: event.eventId, start, title, venueId, venueName });
    byNight.set(night, candidates);
  }

  return events.filter(event => duplicateIds.has(event.eventId));
}

function calendarCoverage(events, now) {
  const calendar = window.QDPLiveCalendar;
  const date = new Date(`${calendar.dayKey(now)}T00:00:00Z`);
  const coverage = new Map();
  for (let index = 0; index < COVERAGE_DAYS; index++) {
    coverage.set(date.toISOString().slice(0, 10), []);
    date.setUTCDate(date.getUTCDate() + 1);
  }

  for (const event of events) {
    if (!hasWebsiteListing(event)) continue;
    const listings = coverage.get(phillyDateKey(event.start));
    if (listings && calendar.isVisible(event, now.getTime())) listings.push(event);
  }
  return coverage;
}

function dashboardEventViews(events, feedFlyers, now = new Date()) {
  const active = events.filter(event => !event.removedFromSheet);
  const integrityEvents = active.filter(event => !/^\(DELETED ENTRY\)/i.test(event.publicTitle || event.title));
  const today = phillyDateKey(now);
  const upcoming = active.filter(event => isUpcoming(event, today));
  const missingFlyers = [];
  let unknownFlyers = 0;
  for (const event of integrityEvents) {
    if (!Object.hasOwn(event, "flyerUrl") && !feedFlyers.has(event.eventId)) {
      unknownFlyers++;
    } else if (!eventFlyerUrl(event, feedFlyers)) {
      missingFlyers.push(event);
    }
  }

  return {
    views: new Map([
      ["needs-push", active.filter(event => event.needsPush)],
      ["hidden-upcoming", upcoming.filter(event => !event.publishToWeb)],
      ["missing-flyer", missingFlyers],
      ["missing-venue", upcoming.filter(event => !event.venueId?.trim())],
      ["missing-description", integrityEvents.filter(event => !event.description?.trim())],
      ["possible-duplicate", findPossibleDuplicates(integrityEvents, today, now)]
    ]),
    coverage: calendarCoverage(active, now),
    integrityEvents,
    unknownFlyers
  };
}

function compareEvents(left, right) {
  const leftTime = new Date(left.start || 0).getTime();
  const rightTime = new Date(right.start || 0).getTime();
  const safeLeft = Number.isNaN(leftTime)
    ? Number.MAX_SAFE_INTEGER
    : leftTime;
  const safeRight = Number.isNaN(rightTime)
    ? Number.MAX_SAFE_INTEGER
    : rightTime;

  return safeLeft - safeRight ||
    left.publicTitle.localeCompare(right.publicTitle);
}

function hasWebsiteListing(event) {
  return Boolean(
    event.publishToWeb &&
    event.publicTitle &&
    event.start &&
    !/^\(DELETED ENTRY\)/i.test(event.publicTitle)
  );
}

function appearsOnWebsite(event) {
  return hasWebsiteListing(event) && isUpcoming(event);
}

function formatEventDate(event) {
  const start = new Date(event.start);

  if (Number.isNaN(start.getTime())) {
    return "Date unavailable";
  }

  const datePart =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: "America/New_York",
        weekday: "short",
        month: "short",
        day: "numeric"
      }
    ).format(start);

  const startTime =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit"
      }
    ).format(start);

  const end = new Date(event.end);

  if (Number.isNaN(end.getTime())) {
    return `${datePart} · ${startTime}`;
  }

  const endTime =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit"
      }
    ).format(end);

  return `${datePart} · ${startTime}–${endTime}`;
}

function formatDateTime(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Never";
  }

  return new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }
  ).format(date);
}

function operationSummary(
  operation,
  kind
) {
  if (!operation) {
    return {
      text: "Never",
      tone: ""
    };
  }

  if (operation.status === "error") {
    return {
      text:
        `${formatDateTime(operation.finishedAt)} · Failed`,
      tone: "error",
      title: operation.error || "Operation failed"
    };
  }

  const summary = operation.summary || {};
  let detail = "Complete";

  if (kind === "pull") {
    detail =
      `${summary.updated || 0} updated, ` +
      `${summary.appended || 0} added`;
  }

  if (kind === "push") {
    detail =
      `${summary.acknowledged || 0} synced, ` +
      `${summary.patched || 0} patched`;
  }

  return {
    text:
      `${formatDateTime(operation.finishedAt)} · ${detail}`,
    tone: ""
  };
}

function showToast(
  message,
  isError = false
) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle(
    "error",
    isError
  );
  elements.toast.hidden = false;

  state.toastTimer = window.setTimeout(
    () => {
      elements.toast.hidden = true;
    },
    isError ? 6500 : 3600
  );
}

async function adminRequest(
  action,
  payload = {}
) {
  const response = await fetch(
    ADMIN_API_URL,
    {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...payload,
        action
      })
    }
  );

  let body = null;

  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }

  if (
    !response.ok ||
    !body ||
    body.ok !== "yes"
  ) {
    throw new Error(
      body && body.error
        ? body.error
        : `Admin request failed (${response.status}).`
    );
  }

  return body;
}

function baseDraft(event) {
  return {
    expectedRevision: event.revision,
    publicTitle: event.publicTitle,
    description: event.description,
    publishToWeb: event.publishToWeb,
    artistIds: [...event.artistIds],
    venueId: event.venueId,
    partyId: event.partyId,
    flyerSource: event.flyerSource,
    explicitQueer: event.explicitQueer,
    explicitQueerTouched: false
  };
}

function draftFor(event) {
  return state.drafts.get(event.eventId) ||
    baseDraft(event);
}

function draftIsDirty(
  event,
  draft
) {
  return (
    draft.publicTitle !== event.publicTitle ||
    draft.description !== event.description ||
    draft.publishToWeb !== event.publishToWeb ||
    draft.venueId !== event.venueId ||
    draft.partyId !== event.partyId ||
    draft.flyerSource !== event.flyerSource ||
    (event.explicitQueerValue === "" && draft.explicitQueerTouched) ||
    draft.explicitQueer !== event.explicitQueer ||
    !sameIds(draft.artistIds, event.artistIds)
  );
}

function sameIds(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function draftMatchesEvent(draft, event) {
  const normalizedDescription = String(draft.description || "")
    .replace(/\r\n?/g, "\n")
    .trim();

  return (
    draft.publicTitle.trim() === event.publicTitle &&
    normalizedDescription === event.description &&
    draft.publishToWeb === event.publishToWeb &&
    draft.venueId === event.venueId &&
    draft.partyId === event.partyId &&
    draft.flyerSource?.trim() === event.flyerSource &&
    (event.explicitQueerValue !== "" || !draft.explicitQueerTouched) &&
    draft.explicitQueer === event.explicitQueer &&
    sameIds(draft.artistIds, event.artistIds)
  );
}

function calendarFieldsAreDirty(
  event,
  draft
) {
  return (
    draft.publicTitle !== event.publicTitle ||
    draft.description !== event.description ||
    draft.venueId !== event.venueId ||
    draft.partyId !== event.partyId ||
    draft.explicitQueer !== event.explicitQueer ||
    !sameIds(draft.artistIds, event.artistIds)
  );
}

function unsavedCount() {
  return state.events.filter(event =>
    draftIsDirty(
      event,
      draftFor(event)
    )
  ).length;
}

function setBusy(busy) {
  if (busy && state.searchTimer !== null) {
    renderEvents();
  }

  state.busy = busy;

  elements.refreshButton.classList.toggle(
    "busy",
    busy
  );

  document
    .querySelectorAll(
      "button, input, textarea, select"
    )
    .forEach(control => {
      control.disabled = busy;
    });

  document
    .querySelectorAll(".artist-picker")
    .forEach(details => {
      details.classList.toggle("is-disabled", busy);
      if (busy) {
        details.open = false;
      }
    });

  if (!busy) {
    updateGlobalControls();
    state.cards.forEach(({ card, event }) => {
      updateCardState(card, event);
    });
  }
}

function updateGlobalControls() {
  const unsaved = unsavedCount();
  const pending =
    state.status
      ? state.status.pendingPushCount
      : 0;

  const outside =
    state.status
      ? state.status.pendingOutsideWindowCount || 0
      : 0;

  const syncActive = Boolean(state.syncJob);
  const writesBlocked = state.busy || state.refreshing || syncActive;
  elements.pullButton.disabled = writesBlocked || unsaved > 0;

  elements.pushButton.disabled =
    writesBlocked || unsaved > 0;

  elements.saveAllButton.disabled = writesBlocked || !unsaved || !state.capabilities.bulkSave;
  elements.saveAllButton.textContent = unsaved ? `Save all changes (${unsaved})` : "Save all changes";
  elements.unsavedSummary.textContent = unsaved ? `${unsaved} event${unsaved === 1 ? " has" : "s have"} unsaved changes` : "No unsaved changes";
  elements.saveAllHelp.textContent = state.capabilities.bulkSave
    ? "Saves every edited event together, including edits hidden by your current filter."
    : "Bulk saving needs the updated Apps Script with Google Sheets API enabled. Individual Save remains available.";

  elements.refreshButton.disabled = state.busy || state.refreshing;
  elements.searchInput.disabled = state.busy;
  elements.filterSelect.disabled = state.busy;

  if (unsaved > 0) {
    elements.pendingSummary.textContent =
      `${unsaved} unsaved`;
    elements.pendingSummary.classList.add(
      "has-pending"
    );
    return;
  }

  elements.pendingSummary.textContent =
    outside > 0
      ? `${pending} need push · ${outside} outside window`
      : pending === 1
        ? "1 event needs push"
        : `${pending} events need push`;

  elements.pendingSummary.classList.toggle(
    "has-pending",
    pending > 0 || outside > 0
  );
}

function visibleEvents() {
  const search =
    elements.searchInput.value
      .trim()
      .toLowerCase();

  const filter = elements.filterSelect.value;
  const events = state.dashboardViews.get(filter) || state.events;

  return events.filter(event => {
    if (filter === "integrity-event") return event.eventId === state.integrityEventId;
    const draft = draftFor(event);
    const venue = state.venueById.get(draft.venueId);
    const artistText = draft.artistIds
      .map(id => {
        const artist = state.artistById.get(id);
        return artist ? `${artist.name} ${artist.id}` : id;
      })
      .join(" ");

    const matchesSearch =
      !search ||
      [
        draft.publicTitle,
        draft.description,
        venue ? venue.name : event.venueName,
        draft.venueId,
        artistText,
        event.location,
        event.address
      ]
        .join(" ")
        .toLowerCase()
        .includes(search);

    if (!matchesSearch) {
      return false;
    }

    if (filter === "upcoming") {
      return isUpcoming(event);
    }

    if (filter === "published") {
      return draft.publishToWeb;
    }

    if (filter === "hidden") {
      return !draft.publishToWeb;
    }

    return true;
  });
}

function artistSummary(artistIds) {
  if (!artistIds.length) {
    return "No artists selected";
  }

  const names = artistIds.map(id => {
    const artist = state.artistById.get(id);
    return artist ? `${artist.name} (${id})` : id;
  });

  if (names.length <= 2) {
    return names.join(", ");
  }

  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

function eventPlace(event, draft) {
  const venue = state.venueById.get(draft.venueId);

  if (venue) {
    return [venue.name, venue.address]
      .filter(Boolean)
      .join(" · ");
  }

  if (draft.venueId) {
    return draft.venueId;
  }

  return event.location || "No venue listed";
}

function externalEventUrl(event) {
  const { safeUrl } = window.QDPEventMetadata;
  for (const value of [event.eventUrl, event.externalUrl, event.sourceUrl]) {
    const url = safeUrl(value);
    if (url && new URL(url).hostname.replace(/^www\./, "") !== "queerdancephilly.com") return url;
  }
  const links = String(event.description || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
  for (const value of links) {
    const url = safeUrl(value.replace(/[.,;!?)]+$/, "").replace(/&amp;/g, "&"));
    if (!url) continue;
    const { hostname, pathname } = new URL(url);
    if ((/^(?:www\.)?instagram\.com$/i.test(hostname) && /^\/(?:p|reel|reels|tv)\//i.test(pathname)) ||
        (/^(?:www\.)?ra\.co$/i.test(hostname) && /^\/events\//i.test(pathname)) ||
        (/^(?:www\.)?partiful\.com$/i.test(hostname) && /^\/e\//i.test(pathname)) ||
        (/^(?:www\.)?eventbrite\.[a-z.]+$/i.test(hostname) && /^\/e\//i.test(pathname)) ||
        (/^(?:www\.)?dice\.fm$/i.test(hostname) && /^\/event\//i.test(pathname))) return url;
  }
  return "";
}

function updateCardState(
  card,
  event
) {
  const draft = draftFor(event);
  const viewLink = card.querySelector(".event-view-link");
  viewLink.hidden = !hasWebsiteListing(event);
  if (!viewLink.hidden) viewLink.href = window.QDPEventMetadata.url(event.eventId);
  const externalLink = card.querySelector(".event-external-link");
  const externalUrl = externalEventUrl(event);
  externalLink.hidden = !externalUrl;
  if (externalUrl) externalLink.href = externalUrl;
  else externalLink.removeAttribute("href");
  card.querySelector(".classify-standard").hidden =
    event.relevanceClassified !== false || draft.explicitQueerTouched || draft.explicitQueer;
  const dirty = draftIsDirty(event, draft);
  const calendarDirty =
    calendarFieldsAreDirty(event, draft);

  card.classList.toggle("is-dirty", dirty);
  card.classList.toggle(
    "is-explicit-queer",
    draft.explicitQueer
  );

  card.querySelector(".event-place").textContent =
    eventPlace(event, draft);

  card.querySelector(".artist-summary").textContent =
    artistSummary(draft.artistIds);

  const saveButton =
    card.querySelector(".save-button");

  const resetButton =
    card.querySelector(".reset-button");

  saveButton.disabled = state.busy || state.refreshing || Boolean(state.syncJob) || !dirty;
  resetButton.disabled = state.busy || !dirty;

  const badge =
    card.querySelector(".sync-badge");

  if (event.removedFromSheet) {
    badge.textContent = "Removed from active Sheet; keep or reset this draft";
    badge.classList.add("needs-push");
  } else if (dirty && draft.expectedRevision && draft.expectedRevision !== event.revision) {
    badge.textContent = "Changed in Sheet; review before saving";
    badge.classList.add("needs-push");
  } else if (calendarDirty) {
    badge.textContent = "Unsaved";
    badge.classList.add("needs-push");
  } else if (event.needsPush) {
    badge.textContent = event.inSyncWindow
      ? "Needs push"
      : "Outside sync window";
    badge.classList.add("needs-push");
  } else {
    badge.textContent = "Synced";
    badge.classList.remove("needs-push");
  }

  card.querySelector(
    ".publish-detail"
  ).textContent = draft.publishToWeb
    ? "Included in the website feed after Save"
    : "Hidden from the website after Save";

  card.querySelector(
    ".explicit-detail"
  ).textContent = draft.explicitQueer
    ? "Purple on the website; grape in Calendar"
    : "Standard event styling and Calendar color";
}

async function saveEvent(event) {
  if (!draftIsDirty(event, draftFor(event))) return;
  await saveChangedEvents([event], false);
}

function contentImpliesExplicitQueer(title, description) {
  const text = `${title || ""}\n${description || ""}`;
  return /\b(?:queer|gay|lgbt|lgbtq|lgbtq\+|trans|sapphic|lesbian|non[-\s\u2010-\u2015]?binary)\b/i.test(text);
}

function artistDisplayName(artist) {
  const badges = [];

  if (artist.consent && artist.queer) {
    badges.push("🏳️‍🌈");
  }

  if (artist.consent && artist.trans) {
    badges.push("🏳️‍⚧️");
  }

  return [badges.join(""), artist.name]
    .filter(Boolean)
    .join(" ");
}

function eventFlyerUrl(event, feedFlyers) {
  return window.QDPEventMetadata.image({
    flyerUrl: event.flyerUrl ?? feedFlyers.get(event.eventId)
  });
}

function renderEventFlyer(card, event) {
  const link = card.querySelector(".event-flyer-link");
  const image = link.querySelector("img");
  const status = card.querySelector(".event-flyer-status");
  const url = eventFlyerUrl(event, state.feedFlyers);
  link.hidden = !url;
  status.hidden = Boolean(url);
  status.textContent = "No flyer";
  if (!url) return;

  link.href = url;
  link.setAttribute("aria-label", "Open flyer for " + (event.publicTitle || event.title || event.eventId));
  let triedProxy = false;
  image.onerror = () => {
    if (!triedProxy && url.startsWith("https:")) {
      triedProxy = true;
      image.src = "/admin/flyer?url=" + encodeURIComponent(url);
      return;
    }
    link.hidden = true;
    status.hidden = false;
    status.textContent = "Flyer unavailable";
  };
  image.src = url.replace(/^(https:\/\/lh3\.googleusercontent\.com\/d\/[\w-]+)=w\d+$/, "$1=w640");
}

async function refreshFeedFlyers() {
  const request = ++state.flyerRequest;
  if (!state.events.some(event => !Object.hasOwn(event, "flyerUrl"))) return;
  try {
    const response = await fetch("/admin/post-data");
    if (!response.ok) return;
    const { events } = await response.json();
    if (request !== state.flyerRequest || !Array.isArray(events)) return;
    state.feedFlyers = new Map(events.map(event => [event.eventId, event.flyerUrl]));
    for (const { card, event } of state.cards.values()) {
      if (!Object.hasOwn(event, "flyerUrl")) renderEventFlyer(card, event);
    }
    renderDashboard();
    if (elements.filterSelect.value === "missing-flyer") renderEvents();
  } catch {
    // The dashboard remains editable if the public feed is unavailable.
  }
}

function createVenueOptions(venues) {
  const options = document.createDocumentFragment();
  options.append(new Option("No linked venue", ""));
  for (const venue of venues) {
    options.append(new Option(`${venue.name} · ${venue.id}`, venue.id));
  }
  return options;
}

function renderEvent(event, venueOptions) {
  const card =
    elements.eventTemplate.content
      .firstElementChild
      .cloneNode(true);

  const draft = draftFor(event);

  card.dataset.eventId = event.eventId;
  renderEventFlyer(card, event);
  card.querySelector(".event-date").textContent =
    formatEventDate(event);

  card.querySelector(".event-id").textContent =
    event.eventId;

  const publicTitleInput =
    card.querySelector(".public-title-input");

  const descriptionInput =
    card.querySelector(".description-input");

  const publishInput =
    card.querySelector(".publish-input");

  const explicitInput =
    card.querySelector(".explicit-input");

  const venueInput =
    card.querySelector(".venue-input");
  const partyInput = card.querySelector(".party-input");
  const flyerInput = card.querySelector(".flyer-source-input");
  if (typeof event.partyId === "string") {
    card.querySelector(".party-field").hidden = false;
    partyInput.append(new Option("No linked party", ""));
    for (const party of state.parties) partyInput.append(new Option(`${party.name} · ${party.id}`, party.id));
    if (draft.partyId && !state.parties.some(party => party.id === draft.partyId)) {
      partyInput.append(new Option(`Unknown PartyID · ${draft.partyId}`, draft.partyId));
    }
    partyInput.value = draft.partyId;
  }
  if (typeof event.flyerSource === "string") {
    card.querySelector(".flyer-source-field").hidden = false;
    flyerInput.value = draft.flyerSource;
  }

  const artistPicker =
    card.querySelector(".artist-picker");

  const artistOptions =
    card.querySelector(".artist-options");

  const artistSearchInput =
    card.querySelector(".artist-search-input");

  let explicitQueerTouched =
    Boolean(draft.explicitQueerTouched);

  let artistsLoaded = false;

  // Native pickers can open before focus handlers have added their options.
  venueInput.append(venueOptions.cloneNode(true));
  for (const id of new Set([event.venueId, draft.venueId])) {
    if (id && !state.venueById.has(id)) {
      venueInput.append(new Option(`Unknown VenueID · ${id}`, id));
    }
  }

  const artistEmpty = document.createElement("p");
  artistEmpty.className = "artist-empty";
  artistEmpty.textContent = "No artists match that search.";
  artistEmpty.hidden = true;
  artistOptions.append(artistEmpty);

  function loadArtistOptions() {
    if (artistsLoaded) return;
    const selectedArtistIds = new Set(draftFor(event).artistIds);
    const artistChoices = [
      ...Array.from(selectedArtistIds, id =>
        state.artistById.get(id) || {
          id,
          name: "Unknown ArtistID",
          missing: true
        }
      ),
      ...state.artists.filter(artist => !selectedArtistIds.has(artist.id))
    ];
    const options = document.createDocumentFragment();

    artistChoices.forEach(artist => {
      const optionLabel = document.createElement("label");
      optionLabel.className = "artist-option";
      optionLabel.dataset.search =
        `${artist.name} ${artist.id}`.toLowerCase();

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = artist.id;
      checkbox.checked = selectedArtistIds.has(artist.id);

      const copy = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = artistDisplayName(artist);
      const id = document.createElement("small");
      id.textContent = artist.missing
        ? `${artist.id} · not found in Artists`
        : artist.id;
      copy.append(name, id);
      optionLabel.append(checkbox, copy);
      options.append(optionLabel);
    });

    artistOptions.insertBefore(options, artistEmpty);
    artistsLoaded = true;
  }

  publicTitleInput.value = draft.publicTitle;
  descriptionInput.value = draft.description;
  publishInput.checked = draft.publishToWeb;
  explicitInput.checked = draft.explicitQueer;
  venueInput.value = draft.venueId;

  function checkedArtistIds() {
    // Editing another field before opening this picker must preserve its IDs.
    if (!artistsLoaded) return [...draftFor(event).artistIds];
    return Array.from(
      artistOptions.querySelectorAll(
        '.artist-option input[type="checkbox"]:checked'
      )
    ).map(input => input.value);
  }

  function storeDraft() {
    state.drafts.set(
      event.eventId,
      {
        expectedRevision: draftFor(event).expectedRevision || event.revision,
        publicTitle: publicTitleInput.value,
        description: descriptionInput.value,
        publishToWeb: publishInput.checked,
        artistIds: checkedArtistIds(),
        venueId: venueInput.value,
        partyId: event.partyId === undefined ? undefined : partyInput.value,
        flyerSource: event.flyerSource === undefined ? undefined : flyerInput.value,
        explicitQueer: explicitInput.checked,
        explicitQueerTouched
      }
    );

    updateCardState(card, event);
    updateGlobalControls();
  }

  publicTitleInput.addEventListener("input", storeDraft);
  partyInput.addEventListener("change", storeDraft);
  flyerInput.addEventListener("input", storeDraft);
  card.querySelector(".classify-standard").addEventListener("click", () => {
    explicitInput.checked = false;
    explicitQueerTouched = true;
    storeDraft();
  });

  descriptionInput.addEventListener(
    "input",
    () => {
      if (
        contentImpliesExplicitQueer(
          event.title,
          descriptionInput.value
        )
      ) {
        explicitInput.checked = true;
        explicitQueerTouched = false;
      }

      storeDraft();
    }
  );

  publishInput.addEventListener("change", storeDraft);

  explicitInput.addEventListener(
    "change",
    () => {
      explicitQueerTouched = true;
      storeDraft();
    }
  );

  venueInput.addEventListener(
    "change",
    () => {
      const venue = state.venueById.get(venueInput.value);

      if (venue && venue.queer) {
        explicitInput.checked = true;
        explicitQueerTouched = false;
      }

      storeDraft();
    }
  );

  artistOptions.addEventListener("change", storeDraft);

  artistSearchInput.addEventListener(
    "input",
    () => {
      const query = artistSearchInput.value
        .trim()
        .toLowerCase();
      let visibleCount = 0;

      artistOptions
        .querySelectorAll(".artist-option")
        .forEach(option => {
          const visible =
            !query || option.dataset.search.includes(query);
          option.hidden = !visible;
          if (visible) visibleCount++;
        });

      artistEmpty.hidden = visibleCount !== 0;
    }
  );

  artistPicker.addEventListener(
    "toggle",
    () => {
      if (artistPicker.open) {
        loadArtistOptions();
        artistSearchInput.focus();
      } else {
        artistSearchInput.value = "";
        artistSearchInput.dispatchEvent(new Event("input"));
      }
    }
  );

  card
    .querySelector(".reset-button")
    .addEventListener(
      "click",
      () => {
        state.drafts.delete(event.eventId);
        state.cards.delete(event.eventId);
        renderEvents();
        updateGlobalControls();
      }
    );

  card
    .querySelector(".save-button")
    .addEventListener(
      "click",
      () => saveEvent(event, card)
    );

  updateCardState(card, event);

  return card;
}

function renderEvents() {
  window.clearTimeout(state.searchTimer);
  state.searchTimer = null;
  const events = visibleEvents();
  const currentIds = new Set(state.events.map(event => event.eventId));
  state.cards.forEach((entry, id) => {
    if (!currentIds.has(id)) state.cards.delete(id);
  });

  let venueOptions;
  const cards = events.map(event => {
    let entry = state.cards.get(event.eventId);
    if (!entry || entry.event !== event) {
      venueOptions ??= createVenueOptions(state.venues);
      entry = { event, card: renderEvent(event, venueOptions) };
      state.cards.set(event.eventId, entry);
    }
    if (entry.card.parentElement !== elements.eventList) {
      // A filtered-out card may have been detached while a save was busy.
      entry.card.querySelectorAll("button, input, textarea, select")
        .forEach(control => { control.disabled = state.busy; });
      entry.card.querySelectorAll("details").forEach(details => {
        details.classList.toggle("is-disabled", state.busy);
        if (state.busy) details.open = false;
      });
      updateCardState(entry.card, event);
    }
    return entry.card;
  });
  const visibleCards = new Set(cards);
  Array.from(elements.eventList.children).forEach(card => {
    if (!visibleCards.has(card)) card.remove();
  });

  // Leave unchanged cards attached, preserving focus and unfinished edits.
  let next = elements.eventList.firstElementChild;
  cards.forEach(card => {
    if (card === next) {
      next = next.nextElementSibling;
    } else {
      elements.eventList.insertBefore(card, next);
    }
  });

  elements.loadingState.hidden = true;
  elements.eventList.hidden = events.length === 0;
  elements.emptyState.hidden = events.length !== 0;
  elements.eventCount.textContent =
    `${events.length} of ${state.events.length}`;
}

function renderCalendarCoverage(coverage, views) {
  const dates = [...coverage.keys()];
  const firstDate = new Date(`${dates[0]}T00:00:00Z`);
  const weekdayOffset = (firstDate.getUTCDay() + 6) % 7;
  const rows = document.createDocumentFragment();

  for (let index = -weekdayOffset; index < dates.length; index += 7) {
    const row = document.createElement("tr");
    for (let column = 0; column < 7; column++) {
      const cell = document.createElement("td");
      row.append(cell);

      const day = dates[index + column];
      if (!day) continue;
      const date = new Date(`${day}T00:00:00Z`);
      const listings = coverage.get(day);
      const filter = `coverage:${day}`;
      views.set(filter, listings);

      const button = document.createElement("button");
      button.className = "coverage-day";
      button.type = "button";
      button.disabled = state.busy;
      button.dataset.eventView = filter;
      button.dataset.coverageDate = coverageLabelFormatter.format(date);
      button.dataset.level = Math.min(listings.length, 4);
      button.setAttribute("aria-label",
        `${button.dataset.coverageDate}, ${listings.length} published ${listings.length === 1 ? "event" : "events"}`);
      const label = document.createElement("time");
      label.dateTime = day;
      label.textContent = coverageDateFormatter.format(date);
      const count = document.createElement("strong");
      count.textContent = listings.length;
      button.append(label, count);
      cell.append(button);
    }
    rows.append(row);
  }

  elements.coverageBody.replaceChildren(rows);
  const selectedDate = elements.coverageDateOption.value;
  if (selectedDate && !views.has(selectedDate)) {
    if (elements.filterSelect.value === selectedDate) elements.filterSelect.value = "upcoming";
    elements.coverageDateOption.value = "";
    elements.coverageDateOption.hidden = true;
  }
}

function renderDashboard() {
  const { views, coverage, integrityEvents, unknownFlyers } = dashboardEventViews(state.events, state.feedFlyers);
  state.dashboardViews = views;
  renderCalendarCoverage(coverage, views);
  for (const button of elements.reviewButtons) {
    const count = views.get(button.dataset.eventView).length;
    button.querySelector("strong").textContent = count;
    button.classList.toggle("has-items", count > 0);
  }

  elements.flyerCoverage.hidden = unknownFlyers === 0;
  elements.flyerCoverage.textContent = unknownFlyers
    ? `Flyer data unavailable for ${unknownFlyers} ${unknownFlyers === 1 ? "event" : "events"}.`
    : "";

  window.QDPAdminIntegrity?.updateEvents(integrityEvents, views, state.artistById);
  elements.dashboardState.hidden = true;
  elements.dashboardContent.hidden = false;
}

function renderOperation(
  element,
  operation,
  kind
) {
  const summary =
    operationSummary(operation, kind);

  element.textContent = summary.text;
  element.classList.toggle(
    "error",
    summary.tone === "error"
  );
  element.title = summary.title || "";
}

function renderStatus() {
  renderDashboard();
  if (!state.status) {
    elements.statusUpdated.textContent = "";
    elements.syncStatusIssue.hidden = true;
    return;
  }

  elements.syncStatusIssue.hidden = ![
    state.status.lastPull,
    state.status.lastPush
  ].some(operation => operation?.status === "error");

  renderOperation(
    elements.lastPull,
    state.status.lastPull,
    "pull"
  );

  renderOperation(
    elements.lastPush,
    state.status.lastPush,
    "push"
  );

  elements.pendingCount.textContent =
    String(state.status.pendingPushCount);

  elements.pendingCount.classList.toggle(
    "warning",
    state.status.pendingPushCount > 0
  );

  elements.outsidePendingCount.textContent =
    String(state.status.pendingOutsideWindowCount || 0);

  elements.outsidePendingCount.classList.toggle(
    "warning",
    (state.status.pendingOutsideWindowCount || 0) > 0
  );

  elements.websiteCount.textContent =
    String(state.status.websiteEventCount);

  elements.upcomingCount.textContent =
    String(state.status.upcomingSheetEventCount);

  elements.hiddenCount.textContent =
    String(state.status.hiddenUpcomingCount);

  elements.activeCount.textContent =
    String(state.status.activeSheetEventCount);

  elements.statusUpdated.textContent =
    `Updated ${formatDateTime(state.status.generatedAt)}`;

  const syncWindow = state.status.syncWindow || {};
  const outside =
    state.status.pendingOutsideWindowCount || 0;

  elements.syncWindow.textContent =
    syncWindow.start && syncWindow.endExclusive
      ? `Sync window: ${formatDateTime(syncWindow.start)} through ${formatDateTime(syncWindow.endExclusive)} (end exclusive).` +
        (outside > 0
          ? ` ${outside} saved change${outside === 1 ? " is" : "s are"} outside this range; change the Window from the QDP Sheet menu before pushing.`
          : "")
      : "Sync window unavailable.";

  elements.cacheNote.textContent =
    `“Showing on website” counts the current Sheet feed. The public site can remain cached for up to ${Math.round(state.status.websiteCacheSeconds / 60)} minutes.`;
}

function updateStatusFromEvents() {
  if (!state.status) {
    return;
  }

  const active = state.events.filter(event => !event.removedFromSheet);
  const today = phillyDateKey(new Date());
  const upcoming = active.filter(event => isUpcoming(event, today));
  const pending = active.filter(event => event.needsPush);
  const pendingInWindow = pending.filter(
    event => event.inSyncWindow
  );

  state.status = {
    ...state.status,
    generatedAt: new Date().toISOString(),
    pendingPushCount: pendingInWindow.length,
    pendingPushTotalCount: pending.length,
    pendingOutsideWindowCount:
      pending.length - pendingInWindow.length,
    activeSheetEventCount: active.length,
    upcomingSheetEventCount: upcoming.length,
    websiteEventCount:
      active.filter(appearsOnWebsite).length,
    hiddenUpcomingCount:
      upcoming.filter(event => !event.publishToWeb).length
  };
}

function applySavedEvent(result, expectedId) {
  applySavedEvents(result, [expectedId]);
}

function applyDashboard(result, { preserveDrafts = false } = {}) {
  const previous = new Map(state.events.map(event => [event.eventId, event]));
  const edited = preserveDrafts ? new Map(state.events.filter(event => draftIsDirty(event, draftFor(event)))
    .map(event => [event.eventId, draftFor(event)])) : new Map();
  state.drafts.clear();
  state.cards.clear();
  if (result.references) {
    state.artists = result.references.artists || [];
    state.venues = result.references.venues || [];
    state.parties = result.references.parties || [];
    state.artistById = new Map(state.artists.map(artist => [artist.id, artist]));
    state.venueById = new Map(state.venues.map(venue => [venue.id, venue]));
  }
  state.referencesVersion = result.referencesVersion || state.referencesVersion;
  state.capabilities = result.capabilities || {};
  state.events = Array.isArray(result.events) ? result.events : [];
  edited.forEach((draft, id) => {
    const current = state.events.find(event => event.eventId === id);
    const before = previous.get(id);
    if (current && before && draftMatchesEvent(baseDraft(before), current)) draft.expectedRevision = current.revision;
    if (!current && before) state.events.push({ ...before, removedFromSheet: true });
    state.drafts.set(id, draft);
  });
  state.events.sort(compareEvents);
  state.status = result.status || null;
  renderStatus(); renderEvents(); updateGlobalControls();
  if (result.syncJob && ['queued', 'running'].includes(result.syncJob.state)) trackSyncJob(result.syncJob);
}

async function refreshDashboard({ discardDrafts = false, preserveDrafts = false, quiet = false } = {}) {
  if (unsavedCount() && !discardDrafts && !preserveDrafts && !window.confirm('Refresh and discard your unsaved edits?')) return;
  if (quiet) { state.refreshing = true; updateGlobalControls(); state.cards.forEach(({card,event}) => updateCardState(card,event)); }
  else setBusy(true);
  try {
    const result = await adminRequest('admin.bootstrap', { referencesVersion: state.referencesVersion });
    applyDashboard(result, { preserveDrafts });
    void refreshFeedFlyers();
    void window.QDPAdminIntegrity?.refresh();
  } catch (error) {
    if (!state.dashboardViews.size) {
      elements.dashboardState.textContent = "Overview unavailable. Use Refresh to retry.";
    }
    if (!quiet) { elements.loadingState.hidden = false; elements.loadingState.textContent = error.message; }
    showToast(error.message, true);
  } finally {
    state.refreshing = false;
    if (!quiet) setBusy(false);
    else { updateGlobalControls(); state.cards.forEach(({card,event}) => updateCardState(card,event)); }
  }
}

async function runSync(kind) {
  if (unsavedCount() || state.busy || state.syncJob) {
    showToast('Save or reset your unsaved edits before syncing.', true); return;
  }
  if (kind === 'pull' && state.status?.pendingPushTotalCount > 0 &&
      !window.confirm(`${state.status.pendingPushTotalCount} saved events have changes that have not been pushed. Pulling can replace those Sheet edits with Calendar data. Pull anyway?`)) return;
  setBusy(true);
  try {
    const result = await adminRequest(`admin.${kind}`);
    if (result.job) trackSyncJob(result.job);
    else {
      applyDashboard(result);
      void refreshFeedFlyers();
      showToast(`${kind === 'pull' ? 'Pull' : 'Push'} complete.`);
    }
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(false); }
}

elements.refreshButton.addEventListener(
  "click",
  () => refreshDashboard()
);

elements.pullButton.addEventListener(
  "click",
  () => runSync("pull")
);

elements.pushButton.addEventListener(
  "click",
  () => runSync("push")
);

elements.dashboardContent.addEventListener("click", event => {
  const link = event.target.closest("a[data-integrity-event-id]");
  if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    editIntegrityEvent(link.dataset.integrityEventId);
    return;
  }
  const button = event.target.closest("button[data-event-view]");
  if (!button) return;

  elements.searchInput.value = "";
  if (button.dataset.coverageDate) {
    elements.coverageDateOption.value = button.dataset.eventView;
    elements.coverageDateOption.textContent = `Website events · ${button.dataset.coverageDate}`;
    elements.coverageDateOption.hidden = false;
  }
  elements.filterSelect.value = button.dataset.eventView;
  renderEvents();

  const card = state.cards.get(button.dataset.eventId)?.card;
  const target = card?.parentElement === elements.eventList ? card : elements.eventsPanel;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "start" });
});

function editIntegrityEvent(eventId) {
  const event = state.events.find(item => item.eventId === eventId);
  if (!event) {
    showToast("That event is no longer in Events.", true);
    return;
  }
  state.integrityEventId = eventId;
  elements.integrityEventOption.hidden = false;
  elements.integrityEventOption.textContent = event.publicTitle || eventId;
  elements.searchInput.value = "";
  elements.filterSelect.value = "integrity-event";
  renderEvents();
  const card = state.cards.get(eventId)?.card;
  const target = card?.parentElement === elements.eventList ? card : elements.eventsPanel;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "start" });
}

elements.searchInput.addEventListener(
  "input",
  () => {
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(renderEvents, 150);
  }
);

elements.filterSelect.addEventListener(
  "change",
  renderEvents
);

window.addEventListener(
  "beforeunload",
  event => {
    if (unsavedCount() > 0) {
      event.preventDefault();
      event.returnValue = "";
    }
  }
);

refreshDashboard({
  discardDrafts: true
}).then(() => {
  const eventId = new URLSearchParams(window.location.search).get("editEvent");
  if (eventId && state.dashboardViews.size) editIntegrityEvent(eventId);
});



function eventSavePayload(event) {
  const draft = draftFor(event);
  return { eventId: event.eventId, expectedRevision: draft.expectedRevision || event.revision,
    publicTitle: draft.publicTitle, description: draft.description, publishToWeb: draft.publishToWeb,
    artistIds: [...draft.artistIds], venueId: draft.venueId, partyId: draft.partyId, flyerSource: draft.flyerSource,
    explicitQueer: draft.explicitQueer, explicitQueerTouched: draft.explicitQueerTouched };
}


async function saveAllChanges() {
  if (!state.capabilities.bulkSave) {
    showToast('Install the updated Apps Script and enable Google Sheets API to save events together.', true);
    return;
  }
  const events = state.events.filter(event => draftIsDirty(event, draftFor(event)));
  if (events.length) await saveChangedEvents(events, true);
}


async function saveChangedEvents(events, batch) {
  if (state.busy || state.refreshing || state.syncJob) return;
  const changes = events.map(eventSavePayload);
  const invalid = changes.find(change => !change.publicTitle.trim());
  if (invalid) { showToast(`${invalid.eventId}: Public title cannot be blank. Nothing was saved.`, true); return; }
  if (changes.length > 500) { showToast('Save all supports up to 500 edited events. Save some individually first, then save the rest together.', true); return; }
  const payload = batch ? { changes } : changes[0];
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 2 * 1024 * 1024) {
    showToast('These edits contain too much text for one save. Save some events individually first.', true); return;
  }
  setBusy(true);
  events.forEach(event => state.cards.get(event.eventId)?.card.classList.add('is-saving'));
  try {
    const result = await adminRequest(batch ? 'admin.savebatch' : 'admin.save', payload);
    applySavedEvents(result, changes.map(change => change.eventId));
    showToast(`${changes.length === 1 ? 'Event saved' : `${changes.length} events saved together`}. Push when ready to update Calendar.`);
  } catch (error) {
    let recovered = false;
    if (/404|fetch|network|load failed|temporarily unavailable|invalid confirmation/i.test(error.message || '')) {
      try {
        const result = await adminRequest('admin.bootstrap', { referencesVersion: state.referencesVersion });
        const saved = new Map((result.events || []).map(event => [event.eventId, event]));
        if (changes.every(change => saved.has(change.eventId) && draftMatchesEvent(change, saved.get(change.eventId)))) {
          applySavedEvents({ events: changes.map(change => saved.get(change.eventId)) }, changes.map(change => change.eventId));
          recovered = true;
          showToast(`${changes.length} saved event${changes.length === 1 ? '' : 's'} confirmed after the response was interrupted.`);
        }
      } catch (_) { /* Keep every draft when confirmation is unavailable. */ }
    }
    if (!recovered) showToast(error.message, true);
  } finally {
    state.cards.forEach(({card}) => card.classList.remove('is-saving'));
    setBusy(false);
  }
}


function applySavedEvents(result, expectedIds) {
  const returned = result && (result.event ? [result.event] : result.events);
  const byId = new Map((Array.isArray(returned) ? returned : []).map(event => [event.eventId, event]));
  if (expectedIds.some(id => !byId.has(id) || !byId.get(id).revision || !state.events.some(event => event.eventId === id))) {
    throw new Error('Admin received an invalid confirmation. Your edits are being checked against the Sheet.');
  }
  const expected = new Set(expectedIds);
  state.events = state.events.map(event => expected.has(event.eventId) ? byId.get(event.eventId) : event).sort(compareEvents);
  expectedIds.forEach(id => state.drafts.delete(id));
  updateStatusFromEvents(); renderStatus(); renderEvents(); updateGlobalControls();
}


function trackSyncJob(job) {
  if (state.syncPollTimer !== null) clearTimeout(state.syncPollTimer);
  state.syncJob = job; state.syncPollFailures = 0;
  elements.syncProgress.hidden = false;
  elements.syncProgress.textContent = `${job.kind === 'pull' ? 'Pull' : 'Push'} ${job.state === 'queued' ? 'queued; waiting to start' : 'running'}. You can keep browsing and editing; save after sync finishes.`;
  updateGlobalControls(); state.cards.forEach(({card,event}) => updateCardState(card,event));
  state.syncPollTimer = setTimeout(pollSyncJob, 2000);
}


async function pollSyncJob() {
  state.syncPollTimer = null;
  if (!state.syncJob) return;
  try {
    const result = await adminRequest('admin.status');
    const job = result.job;
    if (!job || job.id !== state.syncJob.id) throw new Error('Sync status changed. Refresh Admin to check the current operation.');
    if (['queued', 'running'].includes(job.state)) { trackSyncJob(job); return; }
    state.syncJob = null;
    elements.syncProgress.textContent = job.state === 'complete'
      ? `${job.kind === 'pull' ? 'Pull' : 'Push'} complete. Your unsaved edits have been kept.`
      : `Sync stopped: ${job.error || 'Open Apps Script Executions for details.'} Your unsaved edits have been kept.`;
    await refreshDashboard({ preserveDrafts: true, quiet: true });
  } catch (error) {
    state.syncPollFailures++;
    elements.syncProgress.textContent = `Waiting for sync status: ${error.message} Your edits remain on this page.`;
    state.syncPollTimer = setTimeout(pollSyncJob, Math.min(15000, 3000 * state.syncPollFailures));
  }
}

elements.saveAllButton.addEventListener("click", saveAllChanges);
