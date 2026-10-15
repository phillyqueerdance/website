const ADMIN_API_URL = "/admin/api";

const elements = {
  refreshButton: document.getElementById("refreshButton"),
  pullButton: document.getElementById("pullButton"),
  pushButton: document.getElementById("pushButton"),
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
  artistById: new Map(),
  venueById: new Map(),
  drafts: new Map(),
  cards: new Map(),
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
    expectedRevision: event.revision,
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
    .querySelectorAll("details")
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

  let venuesLoaded = false;
  let artistsLoaded = false;

  function addVenueOption(id) {
    const venue = state.venueById.get(id);
    const option = document.createElement("option");
    option.value = id;
    option.textContent = !id
      ? "No linked venue"
      : venue
        ? `${venue.name} · ${id}`
        : `Unknown VenueID · ${id}`;
    venueInput.append(option);
  }

  addVenueOption("");
  if (draft.venueId) addVenueOption(draft.venueId);

  function loadVenueOptions() {
    if (venuesLoaded) return;
    const selected = venueInput.value;
    venueInput.replaceChildren();
    addVenueOption("");
    if (selected && !state.venueById.has(selected)) {
      addVenueOption(selected);
    }
    state.venues.forEach(venue => addVenueOption(venue.id));
    venueInput.value = selected;
    venuesLoaded = true;
  }

  venueInput.addEventListener("focus", loadVenueOptions);
  venueInput.addEventListener("pointerdown", loadVenueOptions);

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

  const cards = events.map(event => {
    let entry = state.cards.get(event.eventId);
    if (!entry || entry.event !== event) {
      entry = { event, card: renderEvent(event) };
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
  renderEvents(); renderStatus(); updateGlobalControls();
  if (result.syncJob && ['queued', 'running'].includes(result.syncJob.state)) trackSyncJob(result.syncJob);
}

async function refreshDashboard({ discardDrafts = false, preserveDrafts = false, quiet = false } = {}) {
  if (unsavedCount() && !discardDrafts && !preserveDrafts && !window.confirm('Refresh and discard your unsaved edits?')) return;
  if (quiet) { state.refreshing = true; updateGlobalControls(); state.cards.forEach(({card,event}) => updateCardState(card,event)); }
  else setBusy(true);
  try {
    const result = await adminRequest('admin.bootstrap', { referencesVersion: state.referencesVersion });
    applyDashboard(result, { preserveDrafts });
  } catch (error) {
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
    else { applyDashboard(result); showToast(`${kind === 'pull' ? 'Pull' : 'Push'} complete.`); }
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
});



function eventSavePayload(event) {
  const draft = draftFor(event);
  return { eventId: event.eventId, expectedRevision: draft.expectedRevision || event.revision,
    publicTitle: draft.publicTitle, description: draft.description, publishToWeb: draft.publishToWeb,
    artistIds: [...draft.artistIds], venueId: draft.venueId,
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
  updateStatusFromEvents(); renderEvents(); renderStatus(); updateGlobalControls();
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
