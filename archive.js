// The archive is a view inside the existing poster, not a set of HTML pages.
// Data arrives only after entering the archive, through /api/archive.
(function () {
  const menu = document.getElementById("archiveMenu");
  const cache = new Map();
  const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  const validViews = new Set(["artists", "venues", "artist", "venue", "events"]);
  let renderedKey = "";
  let loadingKey = "";
  let requestNumber = 0;
  let cards = [];
  let corners = [];

  function routeParams() {
    const params = new URLSearchParams(location.search);
    const view = params.get("archive") || "";
    const id = params.get("id") || "";
    const month = params.get("month") || "";
    return { view, id, month, key: [view, id, month].join("|") };
  }

  function archiveUrl(view, value = "") {
    const url = new URL("/", location.origin);
    url.searchParams.set("archive", view);
    if (["artist", "venue"].includes(view)) url.searchParams.set("id", value);
    if (view === "events" && value) url.searchParams.set("month", value);
    return url;
  }

  function node(tag, className = "", label = "") {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (label) result.textContent = label;
    return result;
  }

  function message(label) {
    eventStack.replaceChildren(node("p", "event-feed-message", label));
    cards = [];
    corners = [];
    archive.events = [];
    archive.updateControls();
  }

  function header(label) {
    dateLabel.textContent = label;
    dateLabel.style.transform = "";
    dateIncomingLabel.hidden = true;
    dateButton.setAttribute("aria-label", label);
    dateButton.setAttribute("aria-haspopup", "false");
    dateButton.tabIndex = -1;
    fitDateText(dateLabel, dateButton);
  }

  function setMenu(view) {
    menu.hidden = false;
    menu.querySelectorAll("a").forEach(link => {
      const target = new URL(link.href).searchParams.get("archive");
      if (target === view || (view === "artist" && target === "artists") ||
          (view === "venue" && target === "venues")) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    });
  }

  function leave() {
    requestNumber++;
    if (!archive.active) return;
    if (!eventDetail.hidden) hideEventDetail({ restoreFocus: false });
    archive.active = false;
    archive.events = [];
    renderedKey = "";
    loadingKey = "";
    cards = [];
    corners = [];
    document.body.classList.remove("archive-mode");
    menu.hidden = true;
    dateButton.tabIndex = 0;
    dateButton.setAttribute("aria-haspopup", "dialog");
    document.title = "Queer Dance Philly";
    if (posterPages.length) {
      renderPoster();
      requestAnimationFrame(() => syncEventFromUrl());
    } else {
      showEventFeedMessage("No upcoming listings right now.");
      previousPoster.disabled = true;
      nextPoster.disabled = true;
    }
  }

  function endpoint(resource, value = "") {
    const url = new URL("/api/archive", location.origin);
    url.searchParams.set("resource", resource);
    if (["artist", "venue"].includes(resource)) url.searchParams.set("id", value);
    if (resource === "month") url.searchParams.set("month", value);
    return url.toString();
  }

  async function load(resource, value) {
    const url = endpoint(resource, value);
    if (!cache.has(url)) {
      cache.set(url, fetch(url).then(async response => {
        const payload = await response.json();
        if (!response.ok || payload.error) throw new Error(payload.error || `Archive returned ${response.status}`);
        return payload;
      }).catch(error => {
        cache.delete(url);
        throw error;
      }));
    }
    return cache.get(url);
  }

  function initial(name) {
    const first = String(name || "").normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/^[^a-z0-9]+/i, "")[0]?.toUpperCase();
    return /^[A-Z]$/.test(first || "") ? first : "#";
  }

  function group(label, extra = "", parent = eventStack) {
    const section = node("section", "archive-section");
    section.setAttribute("aria-label", `${label} group`);
    const wrapper = node("div", `event-time-group archive-group ${extra}`.trim());
    const badge = node("div", "event-time", label);
    const list = node("div", "event-group-cards");
    wrapper.append(badge, list);
    section.appendChild(wrapper);
    parent.appendChild(section);
    return { badge, list, last: null, count: 0 };
  }

  function addCard(grouping, card) {
    const row = node("div", `event-row ${grouping.count ? "same-time" : "has-time"}`);
    row.appendChild(card);
    grouping.list.appendChild(row);
    grouping.count++;
    grouping.last = card;
    cards.push(card);
  }

  function finishGroup(grouping) {
    if (grouping?.count > 1) corners.push({ time: grouping.badge, card: grouping.last });
  }

  function stripCard(title, subtitle, href) {
    const card = node("a", "event-card default archive-card");
    card.href = href;
    card.setAttribute("data-archive-link", "");
    card.appendChild(node("span", "event-card-shape"));
    const content = node("span", "event-card-content");
    content.appendChild(node("span", "event-title", title));
    if (subtitle) content.appendChild(node("span", "event-venue", subtitle));
    card.appendChild(content);
    return card;
  }

  function renderDirectory(kind, items) {
    if (!Array.isArray(items)) throw new Error("Invalid directory feed");
    archive.events = [];
    eventStack.replaceChildren();
    cards = [];
    corners = [];
    const profiles = [...items].filter(item => item.id && item.name).sort((a, b) => {
      const aLetter = initial(a.name);
      const bLetter = initial(b.name);
      return collator.compare(aLetter, bLetter) || collator.compare(a.name, b.name);
    });
    let lastLetter = "";
    let current = null;
    for (const item of profiles) {
      const letter = initial(item.name);
      if (letter !== lastLetter) {
        finishGroup(current);
        current = group(letter, "archive-directory");
        lastLetter = letter;
      }
      const subtitle = kind === "venues" && item.neighborhood
        ? item.neighborhood
        : Number.isInteger(item.count) ? `${item.count} ${item.count === 1 ? "event" : "events"}` : "";
      addCard(current, stripCard(item.name, subtitle,
        archiveUrl(kind === "artists" ? "artist" : "venue", item.id).href));
    }
    finishGroup(current);
    if (!profiles.length) message(`No ${kind} in the archive yet.`);
    archive.updateLayout();
  }

  function monthName(month) {
    const [year, part] = month.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" })
      .format(new Date(Date.UTC(year, part - 1, 1)));
  }

  function renderMonths(months) {
    if (!Array.isArray(months)) throw new Error("Invalid archive index");
    archive.events = [];
    eventStack.replaceChildren();
    cards = [];
    corners = [];
    let year = "";
    let current = null;
    for (const item of [...months].sort((a, b) => b.month.localeCompare(a.month))) {
      if (item.month.slice(0, 4) !== year) {
        finishGroup(current);
        year = item.month.slice(0, 4);
        current = group(year, "archive-year");
      }
      const count = Number.isInteger(item.count)
        ? `${item.count} ${item.count === 1 ? "event" : "events"}` : "";
      addCard(current, stripCard(monthName(item.month), count,
        archiveUrl("events", item.month).href));
    }
    finishGroup(current);
    if (!months.length) message("No archived events yet.");
    archive.updateLayout();
  }

  function profileInfo(kind, person) {
    const info = node("div", "archive-profile-info");
    const card = node("div", "archive-profile-card");
    const name = node("h1", "", person.name);
    card.appendChild(name);
    if (Number.isInteger(person.count)) {
      card.appendChild(node("span", "event-venue", `${person.count} ${person.count === 1 ? "event" : "events"}`));
    }
    info.appendChild(card);
    if (person.bio) info.appendChild(node("p", "", person.bio));
    if (kind === "venue") {
      if (person.neighborhood) info.appendChild(node("p", "", person.neighborhood));
      if (person.address) info.appendChild(node("address", "", person.address));
    }
    const links = node("div", "archive-profile-links");
    for (const [key, label] of [["maps", "Map"], ["website", "Website"],
      ["instagram", "Instagram"], ["music", "Music"]]) {
      if (!person[key]) continue;
      const link = node("a", "", label);
      link.href = person[key];
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      links.appendChild(link);
    }
    if (links.childNodes.length) info.appendChild(links);
    return info;
  }

  function renderEvents(items, person = null, kind = "", month = "") {
    if (!Array.isArray(items)) throw new Error("Invalid archive events");
    eventStack.replaceChildren();
    cards = [];
    corners = [];
    archive.events = sortEvents(items.filter(item => item.eventId && !Number.isNaN(Date.parse(item.start)))).reverse();
    if (person) eventStack.appendChild(profileInfo(kind, person));
    if (month) {
      const heading = node("div", "date-heading", `${monthName(month)} ${month.slice(0, 4)}`);
      eventStack.appendChild(heading);
    }

    let day = "";
    let time = "";
    let current = null;
    let daySection = null;
    for (const event of archive.events) {
      const eventDay = dateKey(new Date(event.start));
      if (eventDay !== day) {
        finishGroup(current);
        current = null;
        time = "";
        day = eventDay;
        const label = node("div", "date-heading", formatPosterDate(day));
        daySection = node("section", "date-section archive-month");
        daySection.setAttribute("aria-label", formatPosterDate(day));
        daySection.appendChild(label);
        eventStack.appendChild(daySection);
      }
      if (event.start !== time) {
        finishGroup(current);
        current = group(formatStartTime(event), "", daySection);
        current.badge.replaceChildren();
        appendStartTime(current.badge, event);
        time = event.start;
      }
      const card = createEventCard(event);
      addCard(current, card);
    }
    finishGroup(current);
    if (!archive.events.length) {
      eventStack.appendChild(node("p", "event-feed-message", "No archived events here yet."));
    }
    archive.updateLayout();
  }

  async function route() {
    const params = routeParams();
    if (!params.view) { leave(); return; }
    if (!validViews.has(params.view) ||
        (["artist", "venue"].includes(params.view) && !/^[\w-]{1,80}$/.test(params.id)) ||
        (params.view === "events" && params.month && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(params.month))) {
      history.replaceState(null, "", "/");
      leave();
      return;
    }

    if (archive.active && renderedKey === params.key) {
      if (loadingKey !== params.key) syncPopup();
      return;
    }
    const serial = ++requestNumber;
    if (!eventDetail.hidden) hideEventDetail({ restoreFocus: false });
    archive.active = true;
    renderedKey = params.key;
    loadingKey = params.key;
    document.body.classList.add("archive-mode");
    setMenu(params.view);
    closeDatePopover();
    eventStack.hidden = false;
    header(params.view === "artist" ? "Artist" : params.view === "venue" ? "Venue" :
      params.view === "artists" ? "Artists" : params.view === "venues" ? "Venues" : "Archive");
    document.title = `${dateLabel.textContent} | Queer Dance Philly`;
    message("Loading archive…");

    const resource = params.view === "events" ? (params.month ? "month" : "months") : params.view;
    const value = params.id || params.month;
    try {
      const data = await load(resource, value);
      if (serial !== requestNumber) return;
      if (resource === "artists" || resource === "venues") renderDirectory(resource, data[resource]);
      else if (resource === "months") renderMonths(data.months);
      else if (resource === "month") renderEvents(data.events, null, "", params.month);
      else {
        if (!data.profile || data.profile.id !== params.id) throw new Error("Profile not found");
        renderEvents(data.events, data.profile, resource);
        document.title = `${data.profile.name} | Queer Dance Philly`;
      }
      eventStack.scrollTop = 0;
      loadingKey = "";
      archive.updateControls();
      syncPopup();
    } catch (error) {
      if (serial !== requestNumber) return;
      loadingKey = "";
      console.error("Could not load QDP archive:", error);
      message("Archive feed is not connected yet. The calendar remains available.");
    }
  }

  function syncPopup() {
    const id = new URLSearchParams(location.search).get("event") || "";
    if (!id) {
      if (!eventDetail.hidden) hideEventDetail({ restoreFocus: false });
      return;
    }
    if (activeEventId === id && !eventDetail.hidden) return;
    const event = archive.events.find(item => eventIdOf(item) === id);
    if (!event) {
      history.replaceState(null, "", archive.baseUrl());
      return;
    }
    if (!eventDetail.hidden) hideEventDetail({ restoreFocus: false });
    archive.focusEvent(event);
    openEventDetail(event, { updateHistory: false });
    eventEntryPushed = Boolean(history.state?.qdpPushed);
  }

  const archive = {
    active: false,
    events: [],
    route,
    baseUrl() {
      const url = new URL(location.href);
      url.searchParams.delete("event");
      return url.href;
    },
    eventUrl(id) {
      const url = new URL(this.baseUrl());
      url.searchParams.set("event", id);
      return url.href;
    },
    focusEvent(event) {
      const card = cards.find(item => item.dataset.eventId === eventIdOf(event));
      if (card) eventStack.scrollTo({ top: scrollOffset(card), behavior: "auto" });
      this.updateControls();
    },
    move(direction) {
      if (!cards.length) return;
      const top = eventStack.scrollTop + 2;
      let index = 0;
      cards.forEach((card, candidate) => {
        if (scrollOffset(card) <= top) index = candidate;
      });
      const target = cards[Math.max(0, Math.min(cards.length - 1, index + direction))];
      if (target) eventStack.scrollTo({ top: scrollOffset(target), behavior: "smooth" });
    },
    updateControls() {
      if (!this.active || eventStack.hidden) return;
      if (corners.length) {
        const radius = parseFloat(getComputedStyle(corners[0].card).borderBottomRightRadius) || 0;
        for (const { time, card } of corners) {
          const bottom = time.getBoundingClientRect().bottom;
          const box = card.getBoundingClientRect();
          const progress = Math.max(0, Math.min(1,
            (bottom - (box.top + box.height / 2)) / (box.height / 2)));
          card.style.setProperty("--qdp-tail-radius", `${radius * (1 - progress)}px`);
        }
      }
      const top = eventStack.scrollTop + 2;
      let index = 0;
      cards.forEach((card, candidate) => {
        if (scrollOffset(card) <= top) index = candidate;
      });
      previousPoster.disabled = !cards.length || index === 0;
      nextPoster.disabled = !cards.length || index === cards.length - 1;
    },
    updateLayout() {
      fitPosterTitles();
      this.updateControls();
    }
  };
  window.QDPArchive = archive;

  document.addEventListener("click", event => {
    const anchor = event.target.closest?.("a[data-archive-link]");
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey ||
        event.ctrlKey || event.shiftKey || event.altKey) return;
    const url = new URL(anchor.href);
    if (url.origin !== location.origin) return;
    event.preventDefault();
    if (url.href !== location.href) history.pushState({ qdpArchive: true }, "", url);
    route();
  });
  window.addEventListener("popstate", route);
  window.addEventListener("resize", () => archive.active && archive.updateLayout());
  if (routeParams().view) route();
})();
