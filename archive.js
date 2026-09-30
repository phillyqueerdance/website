// The archive is a view inside the existing poster, not a set of HTML pages.
// Data arrives only after entering the archive, through /api/archive.
(function () {
  const menu = document.getElementById("archiveMenu");
  const menuTrack = document.getElementById("archiveMenuTrack");
  const venueMap = document.getElementById("archiveVenueMap");
  const menuProfile = document.getElementById("archiveMenuProfile");
  const archiveViewport = document.getElementById("archiveViewport");
  const archivePage = document.getElementById("archivePage");
  const archiveStack = document.getElementById("archiveStack");
  const archiveHeader = document.getElementById("archiveHeader");
  let exitTimer = 0;
  let menuMotionSerial = 0;
  const cache = new Map();
  const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  const validViews = new Set(["artists", "venues", "artist", "venue", "events"]);
  let renderedKey = "";
  let loadingKey = "";
  let requestNumber = 0;
  let pageExitTimer = 0;
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
    archiveStack.replaceChildren(node("p", "event-feed-message", label));
    cards = [];
    corners = [];
    archive.events = [];
    archive.updateControls();
  }

  function header(label) {
    archiveHeader.textContent = label;
    fitDateText(archiveHeader, archiveHeader);
  }

  function syncYearHeadings() {
    const boundary = archiveHeader.getBoundingClientRect().bottom + 2;
    archiveStack.querySelectorAll(".archive-year-heading").forEach(heading => {
      const box = heading.getBoundingClientRect();
      const clipped = Math.max(0, Math.min(box.height, boundary - box.top));
      heading.style.setProperty("--archive-year-clip", `${clipped}px`);
    });
  }

  function syncMenuStems() {
    if (menuTrack.hidden) return;
    const trackTop = menuTrack.getBoundingClientRect().top;
    for (const view of ["artists", "venues", "events"]) {
      const badge = menu.querySelector(`.archive-menu-badge--${view}`);
      const stem = menuTrack.querySelector(`.archive-menu-stem--${view}`);
      stem.style.top = `${badge.getBoundingClientRect().top - trackTop}px`;
      stem.style.height = `${badge.offsetHeight}px`;
    }
  }

  function positionMenu() {
    const leftLinks = document.getElementById("siteMenuLinks");
    const leftLink = leftLinks?.querySelector("a");
    if (leftLink) {
      menuTrack.style.setProperty("--archive-nav-font-size", getComputedStyle(leftLink).fontSize);
      menuTrack.style.setProperty("--archive-nav-gap", getComputedStyle(leftLinks).rowGap);
      menuTrack.style.setProperty("--archive-nav-width", getComputedStyle(document.querySelector(".side-nav")).width);
      const posterWidth = document.querySelector(".poster").getBoundingClientRect().width;
      menuTrack.style.setProperty("--archive-menu-inset", `${posterWidth * .043}px`);
      menuTrack.style.setProperty("--archive-red-stem", `${posterWidth * .010}px`);
      menuTrack.style.setProperty("--archive-orange-stem", `${posterWidth * .026}px`);
      menuTrack.style.setProperty("--archive-purple-stem", `${posterWidth * .043}px`);
      const frameStripes = { artists: 1642, venues: 1614, events: 1586 };
      const stripe = frameStripes[menuTrack.dataset.activeView];
      if (stripe) {
        menuTrack.style.setProperty("--archive-frame-line-left", `${posterWidth * (stripe / 1727 - .917)}px`);
        menuTrack.style.setProperty("--archive-frame-line-width", `${posterWidth * 13 / 1727}px`);
      }
      const shell = document.querySelector(".site-shell");
      const menuStyle = getComputedStyle(menu);
      const linkTop = leftLink.getBoundingClientRect().top - shell.getBoundingClientRect().top;
      const menuInset = parseFloat(menuStyle.paddingTop) + parseFloat(menuStyle.borderTopWidth) + 5;
      menuTrack.style.setProperty("--archive-nav-top", `${Math.max(0, linkTop - menuInset)}px`);
      if (!menuTrack.hidden) {
        const labels = menu.querySelectorAll(".archive-menu-badge-label");
        const labelWidth = Math.ceil(Math.max(...[...labels].map(label => label.getBoundingClientRect().width))) + 24;
        menuTrack.style.setProperty("--archive-tab-label-width", `${labelWidth}px`);
        menuTrack.style.setProperty("--archive-tab-length", `${labelWidth + posterWidth * .043}px`);
        syncMenuStems();
      }
    }
  }

  function showMenu(view = "", restart = false) {
    const motion = ++menuMotionSerial;
    clearTimeout(exitTimer);
    if (restart) menuTrack.classList.remove("is-open");
    menuTrack.hidden = false;
    menuTrack.dataset.activeView = view === "artist" ? "artists" : view === "venue" ? "venues" : view;
    venueMap.hidden = view !== "venue" && view !== "venues";
    menu.querySelectorAll("a").forEach(link => {
      const target = new URL(link.href).searchParams.get("archive") || "";
      if ((view && target === view) || (view === "artist" && target === "artists") ||
          (view === "venue" && target === "venues")) {
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
    menuMotionSerial++;
    menuTrack.classList.remove("is-open");
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
      const badge = menu.querySelector(`.archive-menu-badge--${kind === "venue" ? "venues" : "artists"}`);
      (kind === "venue" && !venueMap.hidden ? venueMap : badge).after(menuProfile);
      menuProfile.appendChild(profileInfo(kind, person));
      requestAnimationFrame(() => {
        if (menuProfile.firstChild) {
          menu.classList.add("has-profile");
          syncMenuStems();
        }
      });
    }
    requestAnimationFrame(syncMenuStems);
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
    archivePage.classList.remove("is-open");
    clearTimeout(pageExitTimer);
    pageExitTimer = setTimeout(() => {
      if (!archive.active) archiveViewport.hidden = true;
    }, 500);
    setProfile("");
    document.body.classList.remove("archive-mode");
    document.documentElement.classList.remove("archive-open");
    if (window.QDPInfoView?.active) showMenu();
    else hideMenu();
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

  function directorySortName(name, kind) {
    let key = String(name || "").trim().replace(/^\[(.*)\]$/s, "$1").trim();
    const fullName = key;
    const prefix = kind === "artists" ? /^(?:DJ|The)\b[\s.:-]+/i : /^The\b[\s.:-]+/i;
    while (prefix.test(key)) key = key.replace(prefix, "").trim();
    return key || fullName;
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
    return { badge, list, last: null, count: 0 };
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
    const profiles = [...items].filter(item => item.id && item.name).sort((a, b) => {
      const aKey = directorySortName(a.name, kind);
      const bKey = directorySortName(b.name, kind);
      return collator.compare(initial(aKey), initial(bKey)) || collator.compare(aKey, bKey);
    });
    let lastLetter = "";
    let current = null;
    for (const item of profiles) {
      const letter = initial(directorySortName(item.name, kind));
      if (letter !== lastLetter) {
        finishGroup(current);
        current = group(letter, "archive-directory");
        lastLetter = letter;
      }
      const subtitle = kind === "venues" ? item.address || "" : "";
      const card = stripCard(item.name, subtitle,
        archiveUrl(kind === "artists" ? "artist" : "venue", item.id).href);
      if (kind === "artists" && (item.queerArtist || item.transArtist)) {
        card.classList.add("archive-identity-card");
      }
      addCard(current, card);
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
    info.setAttribute("aria-label", `${kind === "venue" ? "Venue" : "Artist"} information`);
    info.appendChild(node("h2", "archive-profile-heading", person.name));
    if (kind === "venue" && person.address) info.appendChild(node("address", "", person.address));
    if (person.bio) info.appendChild(node("p", "", person.bio));
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
    archiveStack.replaceChildren();
    cards = [];
    corners = [];
    archive.events = sortEvents(items.filter(item => item.eventId && !Number.isNaN(Date.parse(item.start)))).reverse();
    setProfile(kind, person);
    if (month) {
      const heading = node("div", "date-heading", `${monthName(month)} ${month.slice(0, 4)}`);
      archiveStack.appendChild(heading);
    }

    let day = "";
    let year = "";
    let currentMonth = "";
    let current = null;
    for (const event of archive.events) {
      const eventDay = dateKey(new Date(event.start));
      if (person && eventDay.slice(0, 4) !== year) {
        finishGroup(current);
        current = null;
        year = eventDay.slice(0, 4);
        archiveStack.appendChild(node("h2", "archive-year-heading", year));
      }
      if (person && eventDay.slice(0, 7) !== currentMonth) {
        finishGroup(current);
        currentMonth = eventDay.slice(0, 7);
        current = group(monthName(currentMonth).slice(0, 3), "archive-profile-month");
        current.badge.setAttribute("aria-label", `${monthName(currentMonth)} ${year}`);
      }
      if (!person && eventDay !== day) {
        finishGroup(current);
        day = eventDay;
        current = group("", "archive-event-day");
        current.badge.classList.add("archive-date-badge");
        current.badge.setAttribute("aria-label", `${formatPosterDate(day)}, ${day.slice(0, 4)}`);
        const weekday = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York", weekday: "short"
        }).format(dateFromKey(day));
        current.badge.append(
          node("span", "", weekday),
          node("span", "archive-date-number", `${Number(day.slice(5, 7))}/${Number(day.slice(-2))}`),
          node("span", "archive-date-year", day.slice(0, 4))
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
    if (!archive.events.length) {
      archiveStack.appendChild(node("p", "event-feed-message", "No archived events here yet."));
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
    window.QDPInfoView?.close({ historyEntry: false, preserveMenu: true });
    archive.active = true;
    renderedKey = params.key;
    loadingKey = params.key;
    document.body.classList.add("archive-mode");
    document.documentElement.classList.add("archive-open");
    archiveStack.classList.toggle("profile-events", params.view === "artist" || params.view === "venue");
    setProfile("");
    archiveViewport.hidden = false;
    clearTimeout(pageExitTimer);
    archivePage.style.transition = "none";
    archivePage.classList.remove("is-open");
    showMenu(params.view, menuTrack.hidden || !menuTrack.classList.contains("is-open"));
    void archivePage.offsetHeight;
    archivePage.style.transition = "";
    requestAnimationFrame(() => {
      if (serial === requestNumber) archivePage.classList.add("is-open");
    });
    closeDatePopover();
    archiveStack.hidden = false;
    header(params.view === "artist" ? "Artist" : params.view === "venue" ? "Venue" :
      params.view === "artists" ? "Artists" : params.view === "venues" ? "Venues" : "Past Events");
    document.title = `${archiveHeader.textContent} | Queer Dance Philly`;
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
        header(data.profile.name);
        document.title = `${data.profile.name} | Queer Dance Philly`;
      }
      archiveStack.scrollTop = 0;
      syncYearHeadings();
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
      if (card) archiveStack.scrollTo({ top: offset(card), behavior: "auto" });
      this.updateControls();
    },
    move(direction) {
      if (!cards.length) return;
      const top = archiveStack.scrollTop + 2;
      let index = 0;
      cards.forEach((card, candidate) => {
        if (offset(card) <= top) index = candidate;
      });
      const target = cards[Math.max(0, Math.min(cards.length - 1, index + direction))];
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
      const top = archiveStack.scrollTop + 2;
      let index = 0;
      cards.forEach((card, candidate) => {
        if (offset(card) <= top) index = candidate;
      });
      previousPoster.disabled = !cards.length || index === 0;
      nextPoster.disabled = !cards.length || index === cards.length - 1;
    },
    updateLayout() {
      fitPosterTitles(archiveStack);
      syncYearHeadings();
      this.updateControls();
    }
  };
  function offset(card) {
    return card.getBoundingClientRect().top - archiveStack.getBoundingClientRect().top + archiveStack.scrollTop;
  }
  archive.showMenu = showMenu;
  archive.hideMenu = hideMenu;
  window.QDPArchive = archive;

  new ResizeObserver(() => requestAnimationFrame(syncMenuStems)).observe(menu);

  archiveStack.addEventListener("scroll", () => {
    syncYearHeadings();
    archive.updateControls();
  }, { passive: true });

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
  window.addEventListener("resize", () => {
    if (menuTrack.hidden) return;
    positionMenu();
    if (!archive.active) return;
    archive.updateLayout();
  });
  if (routeParams().view) route();
})();
