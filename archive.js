// The archive is a view inside the existing poster, not a set of HTML pages.
// Data arrives only after entering the archive, through /api/archive.
(function () {
  const menu = document.getElementById("archiveMenu");
  const menuTrack = document.getElementById("archiveMenuTrack");
  const discoverLink = document.getElementById("discoverLink");
  const alphabet = document.getElementById("archiveAlphabet");
  const venueMap = document.getElementById("archiveVenueMap");
  const menuProfile = document.getElementById("archiveMenuProfile");
  const archiveViewport = document.getElementById("archiveViewport");
  const archivePage = document.getElementById("archivePage");
  const archiveStack = document.getElementById("archiveStack");
  const archiveHeader = document.getElementById("archiveHeader");
  const archiveBack = document.getElementById("archiveBack");
  const headerLabel = node("span", "archive-header-label");
  const incomingYear = node("span", "archive-header-incoming");
  incomingYear.hidden = true;
  incomingYear.setAttribute("aria-hidden", "true");
  archiveHeader.append(headerLabel, incomingYear);
  let profileName = "";
  let yearHeadings = [];
  let yearEndSpacer = null;
  let exitTimer = 0;
  let menuMotionSerial = 0;
  const cache = new Map();
  const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  const profileViews = { artist: "artists", venue: "venues", party: "parties",
    collective: "collectives" };
  const directoryViews = new Set(["artists", "venues", "parties", "collectives"]);
  const validViews = new Set([...directoryViews, ...Object.keys(profileViews), "events"]);
  let renderedKey = "";
  let loadingKey = "";
  let requestNumber = 0;
  let pageExitTimer = 0;
  let cards = [];
  let corners = [];
  let profileNavigation = null;

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
    if (profileViews[view]) url.searchParams.set("id", value);
    if (view === "events" && value) url.searchParams.set("month", value);
    return url;
  }

  function node(tag, className = "", label = "") {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (label) result.textContent = label;
    return result;
  }

  for (const letter of "#ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const button = node("button", "archive-alphabet-letter", letter);
    button.type = "button";
    button.dataset.letter = letter;
    button.disabled = true;
    alphabet.appendChild(button);
  }
  const tabColors = { artists: "red", venues: "orange", parties: "purple", collectives: "collective", events: "past" };
  menu.querySelectorAll(".archive-menu-badge").forEach(badge => {
    badge.dataset.tabColor = tabColors[new URL(badge.href).searchParams.get("archive")];
  });

  function message(label) {
    archiveStack.replaceChildren(node("p", "event-feed-message", label));
    profileName = "";
    yearHeadings = [];
    yearEndSpacer = null;
    cards = [];
    corners = [];
    archive.events = [];
    archive.updateControls();
  }

  function header(label) {
    headerLabel.textContent = label;
    headerLabel.style.transform = "";
    incomingYear.textContent = "";
    incomingYear.hidden = true;
    archiveHeader.setAttribute("aria-label", label);
    fitDateText(headerLabel, archiveHeader);
  }

  function fitProfileHeaders() {
    if (!profileName) return;
    fitDateText(headerLabel, archiveHeader);
    const size = getComputedStyle(dateButton).fontSize;
    incomingYear.style.fontSize = size;
    yearHeadings.forEach(({ marker }) => {
      marker.style.fontSize = size;
    });
  }

  function measureYearEndSpacer() {
    if (!yearEndSpacer || !yearHeadings.length) return;
    yearEndSpacer.style.height = "0px";
    const naturalEnd = offset(yearEndSpacer);
    if (naturalEnd <= archiveStack.clientHeight) return;
    const last = yearHeadings[yearHeadings.length - 1].marker;
    const target = offset(last) + archiveHeader.getBoundingClientRect().height;
    yearEndSpacer.style.height = Math.max(0,
      target + archiveStack.clientHeight - naturalEnd + 2) + "px";
  }

  function syncYearHeadings() {
    if (!profileName) return;
    const top = archiveStack.getBoundingClientRect().top;
    const height = archiveHeader.getBoundingClientRect().height - 2;
    if (height <= 0) return;
    let active = profileName;
    let transition = null;
    yearHeadings.forEach(({ year, marker }) => {
      const markerTop = marker.getBoundingClientRect().top - top;
      marker.style.opacity = markerTop <= 0 ? "0" : "";
      if (markerTop <= -height) active = year;
      else if (markerTop <= 0 && !transition && year !== active) {
        transition = { previous: active, next: year, progress: -markerTop / height };
      }
    });
    if (!transition) {
      header(active);
      fitProfileHeaders();
      return;
    }
    const { previous, next, progress } = transition;
    headerLabel.textContent = previous;
    incomingYear.textContent = next;
    incomingYear.hidden = false;
    headerLabel.style.transform = `translateY(${-progress * height}px)`;
    incomingYear.style.transform = `translateY(${(1 - progress) * height}px)`;
    archiveHeader.setAttribute("aria-label", progress < .5 ? previous : next);
  }

  function positionMenu() {
    const leftLinks = document.getElementById("siteMenuLinks");
    const leftLink = leftLinks?.querySelector("a");
    if (leftLink) {
      menuTrack.style.setProperty("--archive-nav-font-size", getComputedStyle(leftLink).fontSize);
      menuTrack.style.setProperty("--archive-nav-gap", getComputedStyle(leftLinks).rowGap);
      const sideWidth = parseFloat(getComputedStyle(document.querySelector(".side-nav")).width);
      const posterBox = document.querySelector(".poster").getBoundingClientRect();
      const posterWidth = posterBox.width;
      const purpleBorder = 1586 / 1727;
      // Begin behind the last pixels of the outer red line, so both rails
      // emerge directly from the frame once the artwork is layered above them.
      const menuInset = posterWidth * (1653 - 1586) / 1727;
      const overlap = posterWidth * (1 - purpleBorder);
      const room = window.innerWidth - menuTrack.getBoundingClientRect().left - menuInset - 20;
      const expandedWidth = Math.max(sideWidth, Math.min(sideWidth + 64, room));
      menuTrack.style.setProperty("--archive-nav-expanded-width", `${expandedWidth}px`);
      menuTrack.style.setProperty("--archive-menu-inset", `${menuInset}px`);
      menuTrack.style.setProperty("--archive-overlap", `${overlap}px`);
      menuTrack.style.setProperty("--archive-badge-label-x", `${menuInset + 14}px`);
      // Anchor Discover to the frame; shorter site navigation must not lower it.
      menuTrack.style.setProperty("--archive-nav-top", `${posterBox.height * .068}px`);
      menuTrack.style.setProperty("--archive-alphabet-top", `${menu.offsetTop + menu.offsetHeight + 8}px`);
      if (!menuTrack.hidden) {
        const labels = menu.querySelectorAll(".archive-menu-badge-label");
        const labelWidth = Math.ceil(Math.max(...[...labels].map(label => label.scrollWidth))) + 22.8;
        menuTrack.style.setProperty("--archive-tab-label-width", `${labelWidth}px`);
        menuTrack.style.setProperty("--archive-tab-length", `${labelWidth + menuInset + 7.6}px`);
        menuTrack.style.setProperty("--archive-nav-compact-width", `${Math.min(expandedWidth, labelWidth + 30.4)}px`);
      }
    }
  }

  function showMenu(view = "", restart = false) {
    const motion = ++menuMotionSerial;
    clearTimeout(exitTimer);
    if (restart) menuTrack.classList.remove("is-open");
    menuTrack.hidden = false;
    document.documentElement.classList.add("discover-open");
    document.body.classList.add("discover-open");
    discoverLink.setAttribute("aria-expanded", "true");
    venueMap.hidden = view !== "venue" && view !== "venues";
    alphabet.hidden = !directoryViews.has(view);
    if (!alphabet.hidden) {
      alphabet.setAttribute("aria-label", `${view[0].toUpperCase() + view.slice(1)} alphabet`);
      alphabet.querySelectorAll("button").forEach(button => {
        if (alphabet.dataset.view !== view) button.disabled = true;
        button.setAttribute("aria-label", `Jump to ${button.dataset.letter} in ${view}`);
      });
      alphabet.dataset.view = view;
    }
    menu.querySelectorAll("a").forEach(link => {
      const target = new URL(link.href).searchParams.get("archive") || "";
      if ((view && target === view) || profileViews[view] === target) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    });
    positionMenu();
    if (restart) void menuTrack.offsetHeight;
    requestAnimationFrame(() => {
      if (motion === menuMotionSerial) menuTrack.classList.add("is-open");
    });
  }

  function hideMenu() {
    window.QDPMobile?.closeDiscover({ restoreFocus: false });
    menuMotionSerial++;
    menuTrack.classList.remove("is-open");
    document.documentElement.classList.remove("discover-open");
    document.body.classList.remove("discover-open");
    discoverLink.setAttribute("aria-expanded", "false");
    clearTimeout(exitTimer);
    exitTimer = setTimeout(() => {
      if (!menuTrack.classList.contains("is-open")) menuTrack.hidden = true;
    }, 500);
  }

  function setProfile(kind, person = null) {
    menu.classList.remove("has-profile");
    menuProfile.replaceChildren();
    menuProfile.hidden = !person;
    if (person) {
      const badge = menu.querySelector(`.archive-menu-badge--${profileViews[kind]}`);
      (kind === "venue" && !venueMap.hidden ? venueMap : badge).after(menuProfile);
      const badgeStyle = getComputedStyle(badge);
      menuProfile.style.setProperty("--archive-profile-accent",
        kind === "collective" ? badgeStyle.color : badgeStyle.backgroundColor);
      menuProfile.appendChild(profileInfo(kind, person));
      requestAnimationFrame(() => {
        if (menuProfile.firstChild) menu.classList.add("has-profile");
      });
    }
  }

  function leave() {
    requestNumber++;
    if (!archive.active) {
      window.QDPEnsureLiveEvents?.();
      return;
    }
    if (!eventDetail.hidden) hideEventDetail({ restoreFocus: false });
    archive.active = false;
    archive.events = [];
    renderedKey = "";
    loadingKey = "";
    cards = [];
    corners = [];
    profileNavigation = null;
    archiveBack.hidden = true;
    archivePage.classList.remove("is-open");
    clearTimeout(pageExitTimer);
    pageExitTimer = setTimeout(() => {
      if (!archive.active) archiveViewport.hidden = true;
    }, 500);
    setProfile("");
    document.body.classList.remove("archive-mode");
    document.documentElement.classList.remove("archive-open");
    hideMenu();
    document.title = "Queer Dance Philly";
    if (posterPages.length) {
      renderPoster();
      requestAnimationFrame(() => syncEventFromUrl());
    } else {
      showEventFeedMessage("No upcoming listings right now.");
      previousPoster.disabled = true;
      nextPoster.disabled = true;
    }
    window.QDPEnsureLiveEvents?.();
  }

  function endpoint(resource, value = "") {
    const url = new URL("/api/archive", location.origin);
    url.searchParams.set("resource", resource);
    if (profileViews[resource]) url.searchParams.set("id", value);
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

  function directorySortName(name, kind) {
    let key = String(name || "").trim().replace(/^\[(.*)\]$/s, "$1").trim();
    const fullName = key;
    const prefix = kind === "artists" ? /^(?:DJ|The)\b[\s.:-]+/i : /^The\b[\s.:-]+/i;
    while (prefix.test(key)) key = key.replace(prefix, "").trim();
    return key || fullName;
  }

  function sortProfiles(items, kind) {
    return [...items].filter(item => item.id && item.name).sort((a, b) => {
      const aKey = directorySortName(a.name, kind);
      const bKey = directorySortName(b.name, kind);
      return collator.compare(initial(aKey), initial(bKey)) || collator.compare(aKey, bKey);
    });
  }

  function initial(name) {
    const first = String(name || "").normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/^[^a-z0-9]+/i, "")[0]?.toUpperCase();
    return /^[A-Z]$/.test(first || "") ? first : "#";
  }

  function group(label, extra = "", parent = archiveStack) {
    const section = node("section", "archive-section");
    section.setAttribute("aria-label", `${label} group`);
    const wrapper = node("div", `event-time-group archive-group ${extra}`.trim());
    const badge = node("div", "event-time", label);
    const list = node("div", "event-group-cards");
    wrapper.append(badge, list);
    section.appendChild(wrapper);
    parent.appendChild(section);
    return { section, badge, list, last: null, count: 0 };
  }

  function addCard(grouping, card, day = "") {
    const row = node("div", `event-row ${grouping.count ? "same-time" : "has-time"}`);
    if (day) row.appendChild(node("span", "archive-day-chip", day));
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
    archiveStack.replaceChildren();
    cards = [];
    corners = [];
    const profiles = sortProfiles(items, kind);
    let lastLetter = "";
    let current = null;
    for (const item of profiles) {
      const letter = initial(directorySortName(item.name, kind));
      if (letter !== lastLetter) {
        finishGroup(current);
        current = group(letter, "archive-directory");
        current.section.dataset.letter = letter;
        lastLetter = letter;
      }
      const subtitle = kind === "venues" ? item.address || "" : "";
      const singular = { artists: "artist", venues: "venue", parties: "party",
        collectives: "collective" }[kind];
      const card = stripCard(item.name, subtitle,
        archiveUrl(singular, item.id).href);
      if ((kind === "artists" && (item.queerArtist || item.transArtist)) ||
          (kind === "venues" && item.queerVenue) ||
          (kind === "parties" && item.queerParty) ||
          (kind === "collectives" && item.queerCollective)) {
        card.classList.add("archive-identity-card");
      }
      addCard(current, card);
    }
    finishGroup(current);
    const available = new Set([...archiveStack.querySelectorAll(".archive-section[data-letter]")]
      .map(section => section.dataset.letter));
    alphabet.querySelectorAll("button").forEach(button => {
      button.disabled = !available.has(button.dataset.letter);
      button.setAttribute("aria-label", `Jump to ${button.dataset.letter} in ${kind}`);
    });
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
    archiveStack.replaceChildren();
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
    const info = node("section", "archive-profile-info");
    info.setAttribute("aria-label", `${kind[0].toUpperCase() + kind.slice(1)} information`);
    info.appendChild(node("h2", "archive-profile-heading", person.name));
    if (kind === "venue" && person.address) info.appendChild(node("address", "", person.address));
    if (person.bio) info.appendChild(node("p", "", person.bio));
    if (Array.isArray(person.related) && person.related.length) {
      const colors = { artist: "red", venue: "orange", party: "purple", collective: "collective" };
      const more = node("section", "archive-profile-related");
      more.appendChild(node("h3", "", "See More"));
      const bubbles = node("div", "archive-profile-related-links");
      for (const item of person.related) {
        if (!colors[item.kind] || !/^[\w-]{1,80}$/.test(item.id) || !item.name) continue;
        const link = node("a", `event-detail-related-bubble event-detail-related-bubble--${colors[item.kind]}`, item.name);
        link.href = archiveUrl(item.kind, item.id).href;
        link.setAttribute("data-archive-link", "");
        bubbles.appendChild(link);
      }
      if (bubbles.childElementCount) {
        more.appendChild(bubbles);
        info.appendChild(more);
      }
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

  function renderEvents(items, person = null, kind = "") {
    if (!Array.isArray(items)) throw new Error("Invalid archive events");
    archiveStack.replaceChildren();
    cards = [];
    corners = [];
    profileName = person?.name || "";
    yearHeadings = [];
    yearEndSpacer = null;
    const events = sortEvents(items.filter(item => item.eventId && !Number.isNaN(Date.parse(item.start))));
    const now = Date.now();
    const upcoming = [];
    const past = [];
    events.forEach(event => {
      const start = Date.parse(event.start);
      const end = Date.parse(event.end);
      const cutoff = Number.isFinite(end) && end >= start ? end : start;
      (cutoff >= now ? upcoming : past).push(event);
    });
    past.reverse();
    archive.events = person ? [...upcoming, ...past] : [...events].reverse();
    setProfile(kind, person);
    if (person) {
      const summary = node("section", "mobile-profile-summary");
      summary.style.setProperty("--archive-profile-accent", menuProfile.style.getPropertyValue("--archive-profile-accent"));
      summary.appendChild(profileInfo(kind, person));
      archiveStack.appendChild(summary);
    }
    let renderedYear = "";
    function renderRows(events, parent, periodHeader = null) {
      let day = "";
      let currentMonth = "";
      let current = null;
      for (const event of events) {
        const eventDay = dateKey(new Date(event.start));
        const year = eventDay.slice(0, 4);
        if (person && year !== renderedYear) {
          finishGroup(current);
          current = null;
          renderedYear = year;
          const marker = node("h2", "date-heading archive-year-heading", year);
          (periodHeader && event === events[0] ? periodHeader : parent).appendChild(marker);
          yearHeadings.push({ year, marker });
        }
        if (person && eventDay.slice(0, 7) !== currentMonth) {
          finishGroup(current);
          currentMonth = eventDay.slice(0, 7);
          current = group(monthName(currentMonth).slice(0, 3), "archive-profile-month", parent);
          current.badge.setAttribute("aria-label", `${monthName(currentMonth)} ${year}`);
        }
        if (!person && eventDay !== day) {
          finishGroup(current);
          day = eventDay;
          current = group("", "archive-event-day", parent);
          current.badge.classList.add("archive-date-badge");
          current.badge.setAttribute("aria-label", `${formatPosterDate(day)}, ${day.slice(0, 4)}`);
          const weekday = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York", weekday: "short"
          }).format(dateFromKey(day));
          const date = `${Number(day.slice(5, 7))}/${Number(day.slice(-2))}`;
          current.badge.dataset.navigationLabel = `${weekday} ${date}`;
          current.badge.append(
            node("span", "", weekday),
            node("span", "archive-date-number", date)
          );
        }
        const card = createEventCard(event);
        if (kind === "venue") {
          card.querySelectorAll(".event-venue, .event-address").forEach(part => part.remove());
        }
        const ordinalDay = Number(eventDay.slice(-2));
        addCard(current, card, person ? `${ordinalDay}${ordinalSuffix(ordinalDay)}` : "");
      }
      finishGroup(current);
    }
    if (person) {
      for (const [period, label, events] of [["upcoming", "Upcoming", upcoming],
        ["past", "Older", past]]) {
        if (!events.length) continue;
        if (period === "past" && upcoming.length) {
          archiveStack.appendChild(node("hr", "archive-period-divider"));
        }
        const section = node("section", "archive-event-period");
        section.dataset.period = period;
        const heading = node("h2", "archive-period-heading", label);
        heading.id = `archive-${period}-heading`;
        section.setAttribute("aria-labelledby", heading.id);
        const periodHeader = node("div", "archive-period-header");
        periodHeader.appendChild(heading);
        section.appendChild(periodHeader);
        archiveStack.appendChild(section);
        renderRows(events, section, periodHeader);
      }
      if (!archive.events.length) {
        archiveStack.appendChild(node("p", "event-feed-message", "No events here yet."));
      }
      yearEndSpacer = node("div", "date-end-spacer");
      yearEndSpacer.setAttribute("aria-hidden", "true");
      archiveStack.appendChild(yearEndSpacer);
    } else {
      renderRows(archive.events, archiveStack);
      if (!archive.events.length) {
        archiveStack.appendChild(node("p", "event-feed-message", "No events here yet."));
      }
    }
    archive.updateLayout();
  }

  async function route() {
    const params = routeParams();
    if (!params.view) {
      if (!new Set(["#about", "#melt"]).has(location.hash)) {
        window.QDPInfoView?.close({ historyEntry: false });
      }
      leave();
      return;
    }
    if (!validViews.has(params.view) ||
        (profileViews[params.view] && !/^[\w-]{1,80}$/.test(params.id)) ||
        (params.view === "events" && params.month && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(params.month))) {
      history.replaceState(null, "", "/");
      leave();
      return;
    }

    if (archive.active && renderedKey === params.key) {
      if (window.QDPInfoView?.active && !["#about", "#melt"].includes(location.hash)) {
        window.QDPInfoView.close({ historyEntry: false });
      }
      if (loadingKey !== params.key) syncPopup();
      return;
    }
    const serial = ++requestNumber;
    profileNavigation = null;
    const directory = profileViews[params.view];
    archiveBack.hidden = !directory && !(params.view === "events" && params.month);
    if (!archiveBack.hidden) {
      const destination = directory || "events";
      archiveBack.href = archiveUrl(destination).href;
      archiveBack.textContent = `← Back to ${destination === "events" ? "Past Events" :
        destination[0].toUpperCase() + destination.slice(1)}`;
    }
    const directoryPromise = directory ? load(directory).catch(() => null) : null;
    if (!eventDetail.hidden) hideEventDetail({ restoreFocus: false });
    if (!["#about", "#melt"].includes(location.hash)) {
      window.QDPInfoView?.close({ historyEntry: false, preserveMenu: true });
    }
    archive.active = true;
    renderedKey = params.key;
    loadingKey = params.key;
    document.body.classList.add("archive-mode");
    document.documentElement.classList.add("archive-open");
    archiveStack.classList.toggle("profile-events", Boolean(profileViews[params.view]));
    setProfile("");
    archiveViewport.hidden = false;
    clearTimeout(pageExitTimer);
    archivePage.style.transition = "none";
    archivePage.classList.remove("is-open");
    showMenu(params.view, menuTrack.hidden || !menuTrack.classList.contains("is-open"));
    if (window.QDPInfoView?.active) hideMenu();
    void archivePage.offsetHeight;
    archivePage.style.transition = "";
    requestAnimationFrame(() => {
      if (serial === requestNumber) archivePage.classList.add("is-open");
    });
    closeDatePopover();
    archiveStack.hidden = false;
    header(params.view === "events" ?
      (params.month ? `${monthName(params.month)} ${params.month.slice(0, 4)}` : "Past Events") :
      params.view[0].toUpperCase() + params.view.slice(1));
    if (!window.QDPInfoView?.active) document.title = `${archiveHeader.textContent} | Queer Dance Philly`;
    message("Loading archive…");

    const resource = params.view === "events" ? (params.month ? "month" : "months") : params.view;
    const value = params.id || params.month;
    try {
      const data = await load(resource, value);
      if (serial !== requestNumber) return;
      if (directoryViews.has(resource)) renderDirectory(resource, data[resource]);
      else if (resource === "months") renderMonths(data.months);
      else if (resource === "month") renderEvents(data.events);
      else {
        if (!data.profile || data.profile.id !== params.id) throw new Error("Profile not found");
        header(data.profile.name);
        renderEvents(data.events, data.profile, resource);
        if (!window.QDPInfoView?.active) document.title = `${data.profile.name} | Queer Dance Philly`;
      }
      archiveStack.scrollTop = 0;
      syncYearHeadings();
      loadingKey = "";
      archive.updateControls();
      syncPopup();
      if (directoryPromise) {
        directoryPromise.then(directoryData => {
          if (serial !== requestNumber || !Array.isArray(directoryData?.[directory])) return;
          const profiles = sortProfiles(directoryData[directory], directory);
          const index = profiles.findIndex(item => item.id === params.id);
          if (index < 0) return;
          profileNavigation = { kind: params.view, profiles, index };
          archive.updateControls();
        });
      }
    } catch (error) {
      if (serial !== requestNumber) return;
      loadingKey = "";
      console.error("Could not load QDP archive:", error);
      message(directoryViews.has(params.view) && ["parties", "collectives"].includes(params.view)
        ? `${params.view[0].toUpperCase() + params.view.slice(1)} are waiting for the sheet to be published.`
        : "Archive feed is not connected yet. The calendar remains available.");
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
      if (card) archiveStack.scrollTo({ top: offset(card), behavior: "auto" });
      this.updateControls();
    },
    move(direction) {
      if (profileViews[routeParams().view]) {
        if (!profileNavigation) return;
        const target = profileNavigation.profiles[profileNavigation.index + direction];
        if (target) {
          history.pushState({ qdpArchive: true }, "", archiveUrl(profileNavigation.kind, target.id));
          route();
        }
        return;
      }
      const { groups, index } = navigationGroups();
      const target = groups[index + direction];
      if (target) archiveStack.scrollTo({ top: offset(target), behavior: "smooth" });
    },
    updateControls() {
      if (!this.active || archiveStack.hidden) return;
      if (corners.length) {
        const radius = parseFloat(getComputedStyle(corners[0].card).borderBottomRightRadius) || 0;
        for (const { time, card } of corners) {
          const bottom = time.getBoundingClientRect().bottom;
          const box = card.getBoundingClientRect();
          const progress = Math.max(0, Math.min(1,
            (bottom - (box.top + box.height / 2)) / (box.height / 2)));
          card.style.setProperty("--qdp-tail-radius", `${radius * (1 - progress)}px`);
          card.parentElement.style.setProperty("--qdp-tail-radius", `${radius * (1 - progress)}px`);
        }
      }
      // Popup arrows belong to the open event, even while its feed scrolls.
      if (!eventDetail.hidden) return;
      if (profileViews[routeParams().view]) {
        const label = routeParams().view;
        const previous = profileNavigation?.profiles[profileNavigation.index - 1];
        const next = profileNavigation?.profiles[profileNavigation.index + 1];
        previousPoster.setAttribute("aria-label", `Previous ${label}${previous ? ": " + previous.name : ""}`);
        nextPoster.setAttribute("aria-label", `Next ${label}${next ? ": " + next.name : ""}`);
        previousPoster.disabled = !previous;
        nextPoster.disabled = !next;
        return;
      }
      const { groups, index } = navigationGroups();
      const kind = directoryViews.has(routeParams().view) ? "letter" : "group";
      const label = section => {
        const badge = section?.querySelector(".event-time");
        return badge?.dataset.navigationLabel || badge?.textContent || "";
      };
      previousPoster.setAttribute("aria-label", `Previous ${kind}${groups[index - 1] ? ": " + label(groups[index - 1]) : ""}`);
      nextPoster.setAttribute("aria-label", `Next ${kind}${groups[index + 1] ? ": " + label(groups[index + 1]) : ""}`);
      previousPoster.disabled = !groups.length || index === 0;
      nextPoster.disabled = !groups.length || index === groups.length - 1;
    },
    updateLayout() {
      fitPosterTitles(archiveStack);
      fitProfileHeaders();
      measureYearEndSpacer();
      syncYearHeadings();
      this.updateControls();
    }
  };
  function navigationGroups() {
    const groups = [...archiveStack.querySelectorAll(".archive-section")];
    const top = archiveStack.scrollTop + 2;
    let index = 0;
    groups.forEach((section, candidate) => {
      if (offset(section) <= top) index = candidate;
    });
    return { groups, index };
  }
  function offset(card) {
    return card.getBoundingClientRect().top - archiveStack.getBoundingClientRect().top + archiveStack.scrollTop;
  }
  archive.showMenu = showMenu;
  archive.hideMenu = hideMenu;
  archive.isMenuOpen = () => discoverLink.getAttribute("aria-expanded") === "true";
  window.QDPArchive = archive;

  discoverLink.addEventListener("click", event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (window.QDPMobile?.active) {
      window.QDPMobile.openDiscover();
      return;
    }
    if (window.QDPInfoView?.active) {
      const url = new URL(location.href);
      url.hash = "";
      const { qdpInfo, ...returnState } = history.state || {};
      history.replaceState(returnState, "", url);
      window.QDPInfoView.close({ historyEntry: false, preserveMenu: true });
    }
    showMenu(routeParams().view, !archive.isMenuOpen());
    requestAnimationFrame(() => {
      positionMenu();
      if (window.matchMedia("(max-width: 760px)").matches) {
        menuTrack.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });
  });

  archiveStack.addEventListener("scroll", () => {
    syncYearHeadings();
    archive.updateControls();
  }, { passive: true });

  alphabet.addEventListener("click", event => {
    const button = event.target.closest("button[data-letter]");
    if (!button || button.disabled) return;
    const section = [...archiveStack.querySelectorAll(".archive-section[data-letter]")]
      .find(item => item.dataset.letter === button.dataset.letter);
    if (section) archiveStack.scrollTo({ top: offset(section), behavior: "smooth" });
  });

  document.addEventListener("click", event => {
    const anchor = event.target.closest?.("a[data-archive-link]");
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey ||
        event.ctrlKey || event.shiftKey || event.altKey) return;
    const url = new URL(anchor.href);
    if (url.origin !== location.origin) return;
    event.preventDefault();
    if (url.href !== location.href) history.pushState({ qdpArchive: true }, "", url);
    route();
    if (!url.searchParams.has("archive")) hideMenu();
  });
  window.addEventListener("popstate", route);
  window.addEventListener("resize", () => {
    if (menuTrack.hidden) return;
    positionMenu();
    if (!archive.active) return;
    archive.updateLayout();
  });
  if (routeParams().view) route();
})();
