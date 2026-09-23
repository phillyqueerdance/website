const ADMIN_API_URL = "/admin/api";

const elements = {
  refreshButton: document.getElementById("refreshButton"),
  pullButton: document.getElementById("pullButton"),
  pushButton: document.getElementById("pushButton"),
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
  artistById: new Map(),
  venueById: new Map(),
  drafts: new Map(),
  busy: false,
  toastTimer: null
};

function phillyDateKey(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).format(date);
}

function isUpcoming(event) {
  const eventKey =
    phillyDateKey(
      event.end || event.start
    );

  const todayKey =
    phillyDateKey(new Date());

  return Boolean(
    eventKey &&
    todayKey &&
    eventKey >= todayKey
  );
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

function appearsOnWebsite(event) {
  return Boolean(
    event.publishToWeb &&
    event.publicTitle &&
    event.start &&
    !/^\(DELETED ENTRY\)/i.test(event.publicTitle) &&
    isUpcoming(event)
  );
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
    publicTitle: event.publicTitle,
    description: event.description,
    publishToWeb: event.publishToWeb,
    artistIds: [...event.artistIds],
    venueId: event.venueId,
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
    .querySelectorAll("details")
    .forEach(details => {
      details.classList.toggle("is-disabled", busy);
      if (busy) {
        details.open = false;
      }
    });

  if (!busy) {
    updateGlobalControls();
    renderEvents();
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

  elements.pullButton.disabled =
    state.busy || unsaved > 0;

  elements.pushButton.disabled =
    state.busy || unsaved > 0;

  elements.refreshButton.disabled = state.busy;
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

  return state.events.filter(event => {
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

    if (filter === "needs-push") {
      return event.needsPush;
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

function updateCardState(
  card,
  event
) {
  const draft = draftFor(event);
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

  saveButton.disabled = state.busy || !dirty;
  resetButton.disabled = state.busy || !dirty;

  const badge =
    card.querySelector(".sync-badge");

  if (calendarDirty) {
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

async function saveEvent(
  event,
  card
) {
  const draft = draftFor(event);

  if (!draftIsDirty(event, draft)) {
    return;
  }

  if (!draft.publicTitle.trim()) {
    showToast("Public title cannot be blank.", true);
    card.querySelector(".public-title-input").focus();
    return;
  }

  setBusy(true);
  card.classList.add("is-saving");

  const changedCalendarFields =
    calendarFieldsAreDirty(event, draft);

  try {
    const result = await adminRequest(
      "admin.save",
      {
        eventId: event.eventId,
        expectedRevision: event.revision,
        publicTitle: draft.publicTitle,
        description: draft.description,
        publishToWeb: draft.publishToWeb,
        artistIds: draft.artistIds,
        venueId: draft.venueId,
        explicitQueer: draft.explicitQueer,
        explicitQueerTouched: draft.explicitQueerTouched
      }
    );

    applySavedEvent(result, event.eventId);

    const updatedEvent = state.events.find(
      candidate => candidate.eventId === event.eventId
    );

    showToast(
      changedCalendarFields
        ? updatedEvent && !updatedEvent.inSyncWindow
          ? "Saved to the Sheet. This event is outside the current sync window; expand the window before pushing."
          : "Saved to the Sheet. Push when you are ready to update Calendar."
        : "Website visibility saved. The public feed may take up to five minutes to refresh."
    );
  } catch (error) {
    const shouldReconcile =
      /404|fetch|network|load failed|temporarily unavailable|invalid confirmation|no longer in this Admin view/i
        .test(error.message || "");

    let recovered = false;

    if (shouldReconcile) {
      try {
        const refreshed = await adminRequest("admin.bootstrap");
        const refreshedEvent = refreshed.events.find(
          candidate => candidate.eventId === event.eventId
        );

        if (
          refreshedEvent &&
          draftMatchesEvent(draft, refreshedEvent)
        ) {
          state.drafts.delete(event.eventId);
          applyDashboard(refreshed);
          recovered = true;
        }
      } catch (refreshError) {
        recovered = false;
      }
    }

    if (recovered) {
      showToast(
        changedCalendarFields
          ? "Saved to the Sheet. The response was interrupted, so Admin refreshed and confirmed the save. Push when ready."
          : "Website visibility was saved. Admin refreshed and confirmed it."
      );
    } else {
      showToast(error.message, true);
    }
  } finally {
    setBusy(false);
  }
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

function renderEvent(event) {
  const card =
    elements.eventTemplate.content
      .firstElementChild
      .cloneNode(true);

  const draft = draftFor(event);

  card.dataset.eventId = event.eventId;
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

  const artistPicker =
    card.querySelector(".artist-picker");

  const artistOptions =
    card.querySelector(".artist-options");

  const artistSearchInput =
    card.querySelector(".artist-search-input");

  let explicitQueerTouched =
    Boolean(draft.explicitQueerTouched);

  const emptyVenueOption = document.createElement("option");
  emptyVenueOption.value = "";
  emptyVenueOption.textContent = "No linked venue";
  venueInput.append(emptyVenueOption);

  if (
    draft.venueId &&
    !state.venueById.has(draft.venueId)
  ) {
    const unknownVenueOption = document.createElement("option");
    unknownVenueOption.value = draft.venueId;
    unknownVenueOption.textContent =
      `Unknown VenueID · ${draft.venueId}`;
    venueInput.append(unknownVenueOption);
  }

  state.venues.forEach(venue => {
    const option = document.createElement("option");
    option.value = venue.id;
    option.textContent = `${venue.name} · ${venue.id}`;
    venueInput.append(option);
  });

  const selectedArtistIds = new Set(draft.artistIds);
  const artistChoices = [
    ...draft.artistIds.map(id =>
      state.artistById.get(id) || {
        id,
        name: "Unknown ArtistID",
        missing: true,
        consent: false,
        queer: false,
        trans: false
      }
    ),
    ...state.artists.filter(
      artist => !selectedArtistIds.has(artist.id)
    )
  ];

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
    artistOptions.append(optionLabel);
  });

  const artistEmpty = document.createElement("p");
  artistEmpty.className = "artist-empty";
  artistEmpty.textContent = "No artists match that search.";
  artistEmpty.hidden = true;
  artistOptions.append(artistEmpty);

  publicTitleInput.value = draft.publicTitle;
  descriptionInput.value = draft.description;
  publishInput.checked = draft.publishToWeb;
  explicitInput.checked = draft.explicitQueer;
  venueInput.value = draft.venueId;

  function checkedArtistIds() {
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
        publicTitle: publicTitleInput.value,
        description: descriptionInput.value,
        publishToWeb: publishInput.checked,
        artistIds: checkedArtistIds(),
        venueId: venueInput.value,
        explicitQueer: explicitInput.checked,
        explicitQueerTouched
      }
    );

    updateCardState(card, event);
    updateGlobalControls();
  }

  publicTitleInput.addEventListener("input", storeDraft);

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

  artistOptions
    .querySelectorAll('.artist-option input[type="checkbox"]')
    .forEach(checkbox => {
      checkbox.addEventListener("change", storeDraft);
    });

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
  const events = visibleEvents();

  elements.eventList.replaceChildren(
    ...events.map(renderEvent)
  );

  elements.loadingState.hidden = true;
  elements.eventList.hidden = events.length === 0;
  elements.emptyState.hidden = events.length !== 0;
  elements.eventCount.textContent =
    `${events.length} of ${state.events.length}`;
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
  if (!state.status) {
    return;
  }

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

  const upcoming = state.events.filter(isUpcoming);
  const pending = state.events.filter(event => event.needsPush);
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
    activeSheetEventCount: state.events.length,
    upcomingSheetEventCount: upcoming.length,
    websiteEventCount:
      state.events.filter(appearsOnWebsite).length,
    hiddenUpcomingCount:
      upcoming.filter(event => !event.publishToWeb).length
  };
}

function applySavedEvent(result, expectedEventId) {
  const savedEvent = result && result.event;

  if (
    !savedEvent ||
    savedEvent.eventId !== expectedEventId
  ) {
    throw new Error(
      "The Sheet saved, but Admin received an invalid confirmation. Refresh before editing again."
    );
  }

  const index = state.events.findIndex(
    event => event.eventId === expectedEventId
  );

  if (index === -1) {
    throw new Error(
      "The saved event is no longer in this Admin view. Refresh before editing again."
    );
  }

  state.events[index] = savedEvent;
  state.events.sort(compareEvents);
  state.drafts.delete(expectedEventId);
  updateStatusFromEvents();

  renderEvents();
  renderStatus();
  updateGlobalControls();
}

function applyDashboard(result) {
  const references = result.references || {};

  state.artists = Array.isArray(references.artists)
    ? references.artists
    : [];

  state.venues = Array.isArray(references.venues)
    ? references.venues
    : [];

  state.artistById = new Map(
    state.artists.map(artist => [artist.id, artist])
  );

  state.venueById = new Map(
    state.venues.map(venue => [venue.id, venue])
  );

  state.events = Array.isArray(result.events)
    ? result.events
    : [];

  state.status = result.status || null;

  renderEvents();
  renderStatus();
  updateGlobalControls();
}

async function refreshDashboard({
  discardDrafts = false
} = {}) {
  if (
    unsavedCount() > 0 &&
    !discardDrafts
  ) {
    const confirmed = window.confirm(
      "Refresh and discard your unsaved edits?"
    );

    if (!confirmed) {
      return;
    }
  }

  setBusy(true);

  try {
    const result = await adminRequest(
      "admin.bootstrap"
    );

    state.drafts.clear();
    applyDashboard(result);
  } catch (error) {
    elements.loadingState.hidden = false;
    elements.loadingState.textContent =
      error.message;
    showToast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function runSync(kind) {
  if (unsavedCount() > 0) {
    showToast(
      "Save or reset your unsaved edits before syncing.",
      true
    );
    return;
  }

  if (
    kind === "pull" &&
    state.status &&
    state.status.pendingPushTotalCount > 0
  ) {
    const count = state.status.pendingPushTotalCount;

    const confirmed = window.confirm(
      `${count} saved event${count === 1 ? "" : "s"} ` +
      `${count === 1 ? "has" : "have"} changes that have not been pushed. ` +
      "Pulling can replace those Sheet edits with Calendar data. Pull anyway?"
    );

    if (!confirmed) {
      return;
    }
  }

  setBusy(true);

  try {
    const result = await adminRequest(
      `admin.${kind}`
    );

    state.drafts.clear();
    applyDashboard(result);

    const summary = result.operation || {};

    if (kind === "pull") {
      showToast(
        `Pull complete: ${summary.updated || 0} updated, ` +
        `${summary.appended || 0} added.`
      );
    } else {
      const patched = summary.patched || 0;
      const acknowledged = summary.acknowledged || 0;

      showToast(
        patched > 0
          ? `Push complete: ${patched} Calendar ` +
            `event${patched === 1 ? "" : "s"} updated; ` +
            `${acknowledged} marked synced.`
          : acknowledged > 0
            ? `Push complete: ${acknowledged} event` +
              `${acknowledged === 1 ? "" : "s"} marked synced; no Calendar changes were needed.`
            : "Push complete: no Calendar changes were needed."
      );
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(false);
  }
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

elements.searchInput.addEventListener(
  "input",
  renderEvents
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
});
