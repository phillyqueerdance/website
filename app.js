const EVENTS_API_URL =
  "/api/events";

const EVENTS_STORAGE_KEY =
  "qdp-public-events-v2";

const EVENTS_STORAGE_MAX_AGE_MS =
  24 * 60 * 60 * 1000;

const dateLabel = document.getElementById("dateLabel");
const eventStack = document.getElementById("eventStack");
const eventDetail = document.getElementById("eventDetail");
const dateButton = document.getElementById("dateButton");
const datePopover = document.getElementById("datePopover");
const previousPoster = document.getElementById("previousPoster");
const nextPoster = document.getElementById("nextPoster");
const poster = document.getElementById("poster");
const todayButton = document.getElementById("todayButton");
const dateIncomingLabel = document.createElement("span");
dateIncomingLabel.className = "date-scroll-label";
dateIncomingLabel.hidden = true;
dateIncomingLabel.setAttribute("aria-hidden", "true");
poster.appendChild(dateIncomingLabel);

const aboutLink = document.getElementById("aboutLink");
const aboutDialog = document.getElementById("aboutDialog");
const aboutCloseButton = document.getElementById(
  "aboutCloseButton"
);

const meltLink = document.getElementById("meltLink");
const meltDialog = document.getElementById("meltDialog");
const meltCloseButton = document.getElementById(
  "meltCloseButton"
);

const layoutEditorEnabled =
  new URLSearchParams(window.location.search)
    .get("edit") === "layout";

let posterPages = [];
let currentPosterIndex = 0;
let pickerMonth = null;
let touchStartX = null;
let touchStartY = null;
let touchDetailAtTop = false;
let pageCards = [];
let eventCardsById = new Map();
let dateSections = [];
let cornerTransitions = [];
let scrollFrame = 0;
let savedEventScrollTop = 0;
let navigationTargetIndex = null;
let detailReturnFocus = null;
let activeEventId = "";
let activeEvent = null;
let eventEntryPushed = false;
let freshEventsLoaded = false;
let activeDetailSlide = null;

previousPoster.disabled = true;
nextPoster.disabled = true;

function initializeMobileMenu() {
  const nav = document.querySelector(".side-nav");
  const button = document.getElementById(
    "mobileMenuButton"
  );
  const links = document.getElementById(
    "siteMenuLinks"
  );
  const mobileQuery = window.matchMedia(
    "(max-width: 760px)"
  );

  if (!nav || !button || !links) {
    return;
  }

  function setMenuOpen(open) {
    nav.classList.toggle("menu-open", open);
    button.setAttribute(
      "aria-expanded",
      String(open)
    );
  }

  button.addEventListener(
    "click",
    event => {
      event.stopPropagation();

      setMenuOpen(
        !nav.classList.contains("menu-open")
      );
    }
  );

  links.addEventListener(
    "click",
    event => {
      if (event.target.closest("a")) {
        setMenuOpen(false);
      }
    }
  );

  document.addEventListener(
    "click",
    event => {
      if (!nav.contains(event.target)) {
        setMenuOpen(false);
      }
    }
  );

  document.addEventListener(
    "keydown",
    event => {
      if (
        event.key !== "Escape" ||
        !nav.classList.contains("menu-open")
      ) {
        return;
      }

      setMenuOpen(false);
      button.focus();
    }
  );

  mobileQuery.addEventListener(
    "change",
    event => {
      if (!event.matches) {
        setMenuOpen(false);
      }
    }
  );
}

function dateKey(date) {
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

function dateFromKey(key) {
  return new Date(`${key}T12:00:00-04:00`);
}

function stripIdentityEmojis(title) {
  return String(title || "")
    .replace(/🏳️‍🌈/g, "")
    .replace(/🏳️‍⚧️/g, "")
    .replace(/✊🏾/g, "")
    .trim();
}

function eventLocationParts(event) {
  const venue = String(event.venue || "").trim();
  const address = String(event.address || "").trim();

  return { venue, address };
}

function eventVenue(event) {
  return eventLocationParts(event).venue;
}

function eventAddress(event) {
  return eventLocationParts(event).address;
}

function sortEvents(events) {
  return [...events].sort((a, b) => {
    const timeDifference =
      new Date(a.start) - new Date(b.start);

    if (timeDifference !== 0) {
      return timeDifference;
    }

    return stripIdentityEmojis(a.title)
      .localeCompare(
        stripIdentityEmojis(b.title),
        undefined,
        { sensitivity: "base" }
      );
  });
}

function buildPosterPages(events) {
  const grouped = new Map();

  sortEvents(events).forEach(event => {
    const key = dateKey(new Date(event.start));

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key).push(event);
  });

  return [...grouped.keys()]
    .sort()
    .map(key => ({
      date: key,
      events: sortEvents(grouped.get(key))
    }));
}

function groupEventsByStartTime(events) {
  const groups = new Map();

  events.forEach(event => {
    const key = new Date(event.start).getTime();

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(event);
  });

  return [...groups.values()];
}

function compactTime(date) {
  return new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit"
    }
  )
    .format(date)
    .replace(":00", "")
    .replace(" ", "");
}

function formatTimeRange(event) {
  let startText =
    compactTime(new Date(event.start));

  const endText = event.end
    ? compactTime(new Date(event.end))
    : "";

  if (!endText) {
    return startText;
  }

  const startMeridiem =
    startText.match(/[AP]M$/)?.[0];

  const endMeridiem =
    endText.match(/[AP]M$/)?.[0];

  if (startMeridiem === endMeridiem) {
    startText =
      startText.replace(/[AP]M$/, "");
  }

  return `${startText}–${endText}`;
}

function formatDetailDateBadge(event) {
  const start = new Date(event.start);
  return {
    date: dateKey(start) < dateKey(new Date())
      ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
        weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(start)
      : formatPosterDate(dateKey(start)),
    time: compactTime(start)
  };
}

function eventIdOf(event) {
  return String(event.eventId ?? event.EventID ?? "").trim();
}

function eventPermalink(eventId) {
  if (window.QDPArchive?.active) {
    return window.QDPArchive.eventUrl(eventId);
  }
  const url = new URL("/", window.location.origin);
  url.searchParams.set("event", eventId);
  return url.toString();
}

function eventShareUrl(eventId) {
  return window.QDPEventMetadata.url(eventId, window.location.origin);
}

function homepageUrl() {
  if (window.QDPArchive?.active) {
    return window.QDPArchive.baseUrl();
  }
  const url = new URL(window.location.href);
  url.searchParams.delete("event");
  return url.toString();
}

function requestedEventId() {
  return new URLSearchParams(window.location.search).get("event") || "";
}

function formatStartTime(event) {
  return compactTime(new Date(event.start));
}

function ordinalSuffix(day) {
  if (day % 100 >= 11 && day % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][Math.min(day % 10, 4)] || "th";
}

function displayTitle(event) {
  // Public Calendar titles keep consented emoji badges; the site uses graphic flags.
  return String(event.title || "")
    .replace(/^(?:(?:🏳️‍🌈|🏳️‍⚧️|✊🏾)\s*)+/u, "")
    .trim() || String(event.title || "");
}

function fitPosterTitles(stack = eventStack) {
  const titles = [...stack.querySelectorAll(".event-title")];
  titles.forEach(title => { title.style.fontSize = ""; });
  const adjustments = titles.map(title => {
    const available = title.clientWidth;
    const fullWidth = title.scrollWidth;
    if (available > 0 && fullWidth > available) {
      const base = parseFloat(getComputedStyle(title).fontSize);
      return [title, `${Math.max(1, base * available / fullWidth - 0.5)}px`];
    }
    return null;
  });
  adjustments.forEach(item => { if (item) item[0].style.fontSize = item[1]; });

  fitDateText(dateLabel, dateButton);
  if (!dateIncomingLabel.hidden) fitDateText(dateIncomingLabel, dateButton);
  dateSections.forEach(({ marker }) => {
    if (marker) fitDateText(marker, marker);
  });
}

function fitDateText(element, container) {
  if (!element.textContent || !container.clientWidth) return;
  const style = getComputedStyle(container);
  const base = parseFloat(getComputedStyle(dateButton).fontSize);
  const room = container.clientWidth -
    parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 4;
  const canvas = fitDateText.canvas ||
    (fitDateText.canvas = document.createElement("canvas"));
  const context = canvas.getContext("2d");
  context.font = `${style.fontWeight} ${base}px ${style.fontFamily}`;
  const width = context.measureText(element.textContent).width;
  element.style.fontSize = width > room
    ? `${Math.max(1, base * room / width - 0.5)}px`
    : `${base}px`;
}

function appendStartTime(time, event) {
  const formatted = formatStartTime(event);

  const meridiem =
    formatted.match(/[AP]M$/)?.[0] || "";

  const number =
    formatted.replace(/[AP]M$/, "");

  const numberElement =
    document.createElement("span");

  numberElement.textContent = number;

  const meridiemElement =
    document.createElement("span");

  meridiemElement.className =
    "event-time-meridiem";

  meridiemElement.textContent = meridiem;

  time.append(
    numberElement,
    meridiemElement
  );
}

function stripQdpFooter(description) {
  const text = String(description || "")
    .replace(/\r\n?/g, "\n");

  const footerStart = text.search(
    /^\s*(?:-{3,}|—+)\s*QDP (?:WEB|IDs)\s*(?:-{3,}|—+)\s*$/im
  );

  return (
    footerStart >= 0
      ? text.slice(0, footerStart)
      : text
  ).trim();
}

function normalizePublicEvents(
  events
) {
  const today =
    dateKey(new Date());

  return events
    .filter(event => {
      const endDate =
        new Date(
          event.end ||
          event.start
        );

      if (
        Number.isNaN(
          endDate.getTime()
        )
      ) {
        return false;
      }

      return (
        dateKey(endDate) >= today
      );
    })
    .map(event => ({
      ...event,

      eventId: eventIdOf(event),

      description:
        stripQdpFooter(
          event.description
        )
    }));
}

function readCachedPublicEvents() {
  try {
    const stored =
      JSON.parse(
        localStorage.getItem(
          EVENTS_STORAGE_KEY
        )
      );

    if (
      !stored ||
      !Array.isArray(
        stored.events
      ) ||
      !Number.isFinite(
        stored.savedAt
      )
    ) {
      return null;
    }

    const cacheAge =
      Date.now() -
      stored.savedAt;

    if (
      cacheAge >
      EVENTS_STORAGE_MAX_AGE_MS
    ) {
      localStorage.removeItem(
        EVENTS_STORAGE_KEY
      );

      return null;
    }

    return normalizePublicEvents(
      stored.events
    );
  } catch (error) {
    console.warn(
      "Could not read the saved event feed.",
      error
    );

    return null;
  }
}

function readInitialPublicEvents() {
  const template = document.getElementById("qdpInitialEvents");
  const content = template?.content?.textContent;
  if (!content) return null;
  try {
    const payload = JSON.parse(content);
    return Array.isArray(payload.events)
      ? normalizePublicEvents(payload.events)
      : null;
  } catch (error) {
    console.error("Could not read the events included in the page.", error);
    return null;
  }
}

function writeCachedPublicEvents(
  events
) {
  try {
    localStorage.setItem(
      EVENTS_STORAGE_KEY,

      JSON.stringify({
        savedAt: Date.now(),
        events
      })
    );
  } catch (error) {
    console.warn(
      "Could not save the event feed.",
      error
    );
  }
}

async function loadPublicEvents() {
  const response =
    await fetch(
      EVENTS_API_URL
    );

  if (!response.ok) {
    throw new Error(
      `Event feed returned ${response.status}.`
    );
  }

  const payload =
    await response.json();

  if (payload.error) {
    throw new Error(
      payload.error
    );
  }

  if (
    !Array.isArray(
      payload.events
    )
  ) {
    throw new Error(
      "The event feed returned an invalid response."
    );
  }

  return normalizePublicEvents(
    payload.events
  );
}

function showEventFeedMessage(message) {
  eventStack.hidden = Boolean(requestedEventId()) && !eventDetail.hidden;
  eventStack.innerHTML = "";

  const notice =
    document.createElement("p");

  notice.className = "event-feed-message";
  notice.textContent = message;

  eventStack.appendChild(notice);
}

function availableDateKeys() {
  return new Set(
    posterPages.map(page => page.date)
  );
}

function openDatePopover() {
  if (!posterPages.length) {
    return;
  }

  const currentDate = dateFromKey(
    posterPages[currentPosterIndex].date
  );

  pickerMonth = new Date(
    currentDate.getFullYear(),
    currentDate.getMonth(),
    1,
    12
  );

  renderDatePopover();

  datePopover.hidden = false;

  dateButton.setAttribute(
    "aria-expanded",
    "true"
  );
}

function closeDatePopover() {
  datePopover.hidden = true;

  dateButton.setAttribute(
    "aria-expanded",
    "false"
  );
}

function renderDatePopover() {
  datePopover.innerHTML = "";

  const pickerHeader =
    document.createElement("div");

  pickerHeader.className =
    "date-popover-header";

  const previousMonth =
    document.createElement("button");

  previousMonth.type = "button";

  previousMonth.className =
    "date-popover-month-button";

  previousMonth.textContent = "←";

  previousMonth.setAttribute(
    "aria-label",
    "Previous month"
  );

  previousMonth.addEventListener(
    "click",
    event => {
      event.stopPropagation();

      pickerMonth = new Date(
        pickerMonth.getFullYear(),
        pickerMonth.getMonth() - 1,
        1,
        12
      );

      renderDatePopover();
    }
  );

  const monthLabel =
    document.createElement("div");

  monthLabel.className =
    "date-popover-month-label";

  monthLabel.textContent =
    new Intl.DateTimeFormat(
      "en-US",
      {
        month: "long",
        year: "numeric"
      }
    ).format(pickerMonth);

  const nextMonth =
    document.createElement("button");

  nextMonth.type = "button";

  nextMonth.className =
    "date-popover-month-button";

  nextMonth.textContent = "→";

  nextMonth.setAttribute(
    "aria-label",
    "Next month"
  );

  nextMonth.addEventListener(
    "click",
    event => {
      event.stopPropagation();

      pickerMonth = new Date(
        pickerMonth.getFullYear(),
        pickerMonth.getMonth() + 1,
        1,
        12
      );

      renderDatePopover();
    }
  );

  pickerHeader.append(
    previousMonth,
    monthLabel,
    nextMonth
  );

  const weekdayRow =
    document.createElement("div");

  weekdayRow.className =
    "date-popover-weekdays";

  ["S", "M", "T", "W", "T", "F", "S"]
    .forEach(day => {
      const weekday =
        document.createElement("div");

      weekday.textContent = day;

      weekdayRow.appendChild(weekday);
    });

  const dayGrid =
    document.createElement("div");

  dayGrid.className =
    "date-popover-days";

  const year =
    pickerMonth.getFullYear();

  const month =
    pickerMonth.getMonth();

  const firstWeekday =
    new Date(year, month, 1).getDay();

  const daysInMonth =
    new Date(
      year,
      month + 1,
      0
    ).getDate();

  const available =
    availableDateKeys();

  const selected =
    posterPages[currentPosterIndex].date;

  for (
    let blank = 0;
    blank < firstWeekday;
    blank++
  ) {
    dayGrid.appendChild(
      document.createElement("div")
    );
  }

  for (
    let day = 1;
    day <= daysInMonth;
    day++
  ) {
    const date =
      new Date(year, month, day, 12);

    const key = dateKey(date);

    const hasEvents =
      available.has(key);

    const dayButton =
      document.createElement("button");

    dayButton.type = "button";

    dayButton.className =
      "date-popover-day";

    dayButton.textContent = day;

    dayButton.disabled = !hasEvents;

    if (key === selected) {
      dayButton.classList.add(
        "selected"
      );
    }

    if (hasEvents) {
      dayButton.addEventListener(
        "click",
        () => {
          currentPosterIndex =
            posterPages.findIndex(
              page => page.date === key
            );

          closeDatePopover();
          scrollToPage(currentPosterIndex);
        }
      );
    }

    dayGrid.appendChild(dayButton);
  }

  datePopover.append(
    pickerHeader,
    weekdayRow,
    dayGrid
  );
}

function formatPosterDate(key) {
  const date = dateFromKey(key);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "long"
  }).format(date);
  const month = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", month: "long"
  }).format(date);
  const day = Number(key.slice(-2));
  return weekday + ", " + month + " " + day + ordinalSuffix(day);
}

function createEventCard(event) {
  const card = document.createElement("a");
  card.href = eventPermalink(eventIdOf(event));
  card.dataset.eventId = eventIdOf(event);
  card.className = "event-card " +
    (event.explicitQueer ? "explicit" : "default") +
    (event.queerArtist || event.transArtist ? " has-flags" : "");

  if (event.queerArtist) {
    const flag = document.createElement("span");
    flag.className = "card-flag card-flag-queer";
    flag.setAttribute("aria-label", "Features a queer artist");
    flag.setAttribute("role", "img");
    card.appendChild(flag);
  }
  if (event.transArtist) {
    const flag = document.createElement("span");
    flag.className = "card-flag card-flag-trans";
    flag.setAttribute("aria-label", "Features a trans artist");
    flag.setAttribute("role", "img");
    card.appendChild(flag);
  }

  const shape = document.createElement("span");
  shape.className = "event-card-shape";
  shape.setAttribute("aria-hidden", "true");
  const content = document.createElement("span");
  content.className = "event-card-content";
  const title = document.createElement("div");
  title.className = "event-title";
  title.textContent = displayTitle(event);
  const venue = document.createElement("div");
  venue.className = "event-venue";
  venue.textContent = eventVenue(event);
  venue.hidden = !venue.textContent;
  const address = document.createElement("div");
  address.className = "event-address";
  address.textContent = eventAddress(event);
  address.hidden = !address.textContent;

  content.append(title, venue, address);
  card.append(shape, content);
  card.addEventListener("click", click => {
    if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
    click.preventDefault();
    openEventDetail(event);
  });
  card.addEventListener("keydown", key => {
    if (key.key !== " ") return;
    key.preventDefault();
    card.click();
  });
  return card;
}

function renderPoster() {
  if (!posterPages.length) return;

  finishDetailSlide();
  const keepDetail = Boolean(requestedEventId()) && !eventDetail.hidden;
  if (!keepDetail) {
    eventDetail.hidden = true;
    eventDetail.classList.remove("is-open", "explicit");
  }
  eventStack.hidden = keepDetail;
  eventStack.innerHTML = "";
  pageCards = new Array(posterPages.length);
  eventCardsById = new Map();
  dateSections = [];
  cornerTransitions = [];

  const dates = [];
  posterPages.forEach((page, pageIndex) => {
    let date = dates[dates.length - 1];
    if (!date || date.key !== page.date) {
      date = { key: page.date, items: [], lastPageIndex: pageIndex };
      dates.push(date);
    }
    date.lastPageIndex = pageIndex;
    page.events.forEach(event => date.items.push({ event, pageIndex }));
  });

  dates.forEach((date, dateIndex) => {
    const section = document.createElement("section");
    section.className = "date-section";
    section.setAttribute("aria-label", formatPosterDate(date.key));
    let marker = null;
    if (dateIndex > 0) {
      marker = document.createElement("div");
      marker.className = "date-heading";
      marker.textContent = formatPosterDate(date.key);
      section.appendChild(marker);
    }

    const pageForEvent = new Map(
      date.items.map(({ event, pageIndex }) => [event, pageIndex])
    );
    groupEventsByStartTime(date.items.map(item => item.event))
      .forEach(eventsAtThisTime => {
        const group = document.createElement("div");
        group.className = "event-time-group";
        const time = document.createElement("div");
        time.className = "event-time";
        appendStartTime(time, eventsAtThisTime[0]);
        const cards = document.createElement("div");
        cards.className = "event-group-cards";

        let lastCard = null;
        eventsAtThisTime.forEach((event, index) => {
          const row = document.createElement("div");
          row.className = "event-row " +
            (index === 0 ? "has-time" : "same-time");
          const card = createEventCard(event);
          if (eventIdOf(event)) eventCardsById.set(eventIdOf(event), card);
          lastCard = card;
          const pageIndex = pageForEvent.get(event);
          if (!pageCards[pageIndex]) pageCards[pageIndex] = card;
          row.appendChild(card);
          cards.appendChild(row);
        });

        group.append(time, cards);
        section.appendChild(group);
        if (eventsAtThisTime.length > 1) {
          cornerTransitions.push({ time, card: lastCard });
        }
      });

    // Only the final date needs room below it to scroll its first card
    // to the top when there is no later content.
    const spacer = dateIndex === dates.length - 1
      ? document.createElement("div")
      : null;
    if (spacer) {
      spacer.className = "date-end-spacer";
      spacer.setAttribute("aria-hidden", "true");
      section.appendChild(spacer);
    }
    eventStack.appendChild(section);
    dateSections.push({
      key: date.key, section, marker, spacer,
      lastPageIndex: date.lastPageIndex
    });
  });

  requestAnimationFrame(() => {
    measureEndSpacer();
    scrollToPage(currentPosterIndex, "auto");
    fitPosterTitles();
    if (!eventDetail.hidden && activeEvent) updateDetailNavigationState();
  });
}

function scrollOffset(element) {
  return element.getBoundingClientRect().top -
    eventStack.getBoundingClientRect().top + eventStack.scrollTop;
}

function measureEndSpacer() {
  if (!pageCards.length || eventStack.hidden) return;
  const lastDate = dateSections[dateSections.length - 1];
  const spacer = lastDate?.spacer;
  if (!spacer) return;

  spacer.style.height = "0px";
  const pageTop = scrollOffset(pageCards[lastDate.lastPageIndex]);
  const naturalEnd = scrollOffset(spacer);
  spacer.style.height = Math.max(0,
    pageTop + eventStack.clientHeight - naturalEnd + 2) + "px";
}

function scrollToPage(index, behavior = "smooth") {
  if (!pageCards[index]) return;
  navigationTargetIndex = behavior === "smooth" ? index : null;
  currentPosterIndex = index;
  eventStack.scrollTo({ top: scrollOffset(pageCards[index]), behavior });
  if (behavior === "auto") updateScrollState();
  else {
    previousPoster.disabled = index === 0;
    nextPoster.disabled = index === posterPages.length - 1;
  }
}

function showDateLabel(key) {
  const label = formatPosterDate(key);
  if (dateLabel.textContent !== label) dateLabel.textContent = label;
  dateLabel.style.transform = "translateY(0)";
  dateIncomingLabel.hidden = true;
  dateButton.setAttribute("aria-label", "Choose a date. Showing " + label);
  fitDateText(dateLabel, dateButton);
}

function updateTimeGroupCorners() {
  if (!cornerTransitions.length) return;
  const radius = parseFloat(getComputedStyle(
    cornerTransitions[0].card).borderBottomRightRadius) || 0;
  const updates = cornerTransitions.map(({ time, card }) => {
    const timeBottom = time.getBoundingClientRect().bottom;
    const cardBox = card.getBoundingClientRect();
    // Keep the corner rounded until the time block reaches the card midpoint.
    // Straighten over the remaining half, and reverse when scrolling back.
    const midpoint = cardBox.top + cardBox.height / 2;
    const progress = Math.max(0, Math.min(1,
      (timeBottom - midpoint) / (cardBox.height / 2)));
    return [card, radius * (1 - progress)];
  });
  updates.forEach(([card, value]) =>
    card.style.setProperty("--qdp-tail-radius", `${value}px`));
}

function updateScrollState() {
  if (window.QDPArchive?.active) return;
  if (!posterPages.length || !pageCards.length || eventStack.hidden) return;
  updateTimeGroupCorners();
  previousPoster.setAttribute("aria-label", "Previous date");
  nextPoster.setAttribute("aria-label", "Next date");
  const position = eventStack.scrollTop + 2;
  let pageIndex = 0;
  pageCards.forEach((card, index) => {
    if (scrollOffset(card) <= position) pageIndex = index;
  });
  if (navigationTargetIndex !== null &&
      Math.abs(eventStack.scrollTop -
        scrollOffset(pageCards[navigationTargetIndex])) < 2) {
    navigationTargetIndex = null;
  }
  currentPosterIndex = navigationTargetIndex ?? pageIndex;
  previousPoster.disabled = currentPosterIndex === 0;
  nextPoster.disabled = currentPosterIndex === posterPages.length - 1;

  const top = eventStack.getBoundingClientRect().top;
  const dateHeight = dateButton.getBoundingClientRect().height - 2;
  let activeKey = dateSections[0].key;
  let transition = null;
  dateSections.slice(1).forEach(({ key, marker }, index) => {
    const markerTop = marker.getBoundingClientRect().top - top;
    marker.style.opacity = markerTop <= 0 ? "0" : "";
    if (markerTop <= -dateHeight) activeKey = key;
    else if (markerTop <= 0 && !transition) {
      transition = {
        previous: dateSections[index].key,
        next: key,
        progress: -markerTop / dateHeight
      };
    }
  });

  if (!transition) {
    showDateLabel(activeKey);
    return;
  }
  const { previous, next, progress } = transition;
  dateLabel.textContent = formatPosterDate(previous);
  dateIncomingLabel.textContent = formatPosterDate(next);
  dateIncomingLabel.hidden = false;
  dateLabel.style.transform =
    "translateY(" + (-progress * dateHeight) + "px)";
  dateIncomingLabel.style.transform =
    "translateY(" + (-progress * dateHeight) + "px)";
  dateButton.setAttribute("aria-label", "Choose a date. Showing " +
    (progress < 0.5 ? dateLabel.textContent : dateIncomingLabel.textContent));
  fitDateText(dateLabel, dateButton);
  fitDateText(dateIncomingLabel, dateButton);
}

function schedulePosterLayout() {
  requestAnimationFrame(() => {
    fitDetailContent();
    if (window.QDPArchive?.active) {
      window.QDPArchive.updateLayout();
      return;
    }
    if (!pageCards.length || eventStack.hidden) return;
    const index = currentPosterIndex;
    measureEndSpacer();
    scrollToPage(index, "auto");
    fitPosterTitles();
  });
}

function googleCalendarEventUrl(event) {
  const start = new Date(event.start);
  const providedEnd = event.end ? new Date(event.end) : null;
  const end = providedEnd && providedEnd > start
    ? providedEnd : new Date(start.getTime() + 60 * 60 * 1000);
  const utc = date => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const location = [eventVenue(event), eventAddress(event)].filter(Boolean).join(", ");
  const url = new URL("https://calendar.google.com/calendar/r/eventedit");
  url.searchParams.set("action", "TEMPLATE");
  url.searchParams.set("text", displayTitle(event));
  url.searchParams.set("dates", `${utc(start)}/${utc(end)}`);
  url.searchParams.set("stz", "America/New_York");
  url.searchParams.set("etz", "America/New_York");
  if (location) url.searchParams.set("location", location);
  const details = [event.description, eventIdOf(event) && eventShareUrl(eventIdOf(event))]
    .filter(Boolean).join("\n\n");
  if (details) url.searchParams.set("details", details);
  return url.href;
}

async function copyEventLink(url) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    return;
  }

  const input = document.createElement("textarea");
  input.value = url;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Clipboard copy failed.");
}

async function shareEvent(event, status) {
  const id = eventIdOf(event);
  if (!id) {
    status.textContent = "Link unavailable";
    return;
  }

  const url = eventShareUrl(id);
  if (navigator.share) {
    try {
      await navigator.share({
        title: `Check out ${displayTitle(event)} on Queer Dance Philly`,
        url
      });
      return;
    } catch (error) {
      if (error.name === "AbortError") return;
    }
  }

  try {
    await copyEventLink(url);
    status.textContent = "Link copied";
  } catch (error) {
    status.textContent = "Could not copy link";
  }
  setTimeout(() => {
    if (status.isConnected) status.textContent = "";
  }, 2500);
}

function fitDetailContent() {
  if (eventDetail.hidden) return;
  const card = eventDetail.querySelector(".event-detail-card:not([aria-hidden])");
  if (!card) return;

  const cardStyle = getComputedStyle(card);
  const rightPadding = parseFloat(cardStyle.paddingRight) || 0;
  const scrollbarWidth = card.offsetWidth - card.clientWidth;
  const frame = poster.getBoundingClientRect();
  const detail = eventDetail.getBoundingClientRect();
  const frameOffset = (frame.left + frame.width / 2) -
    (detail.left + detail.width / 2);
  // Center the actions against the frame, outside the reserved scrollbar gutter.
  card.style.setProperty(
    "--qdp-detail-action-offset",
    `${(scrollbarWidth + rightPadding) / 2 + frameOffset}px`
  );

  const slot = card.querySelector(".event-detail-flyer-slot");
  const flyer = slot?.querySelector(".event-detail-flyer");
  if (!flyer) return;

  const slotStyle = getComputedStyle(slot);
  const topMargin = parseFloat(slotStyle.marginTop) || 0;
  const leftMargin = parseFloat(slotStyle.marginLeft) || 0;
  slot.style.marginRight = `${Math.max(0, leftMargin - rightPadding - scrollbarWidth)}px`;
  const availableHeight = card.clientHeight - topMargin - 2;
  const flyerHeight = availableHeight;
  flyer.style.maxHeight = `${Math.max(0, Math.floor(flyerHeight))}px`;
}

function openEventDetail(event, { updateHistory = true } = {}) {
  closeDatePopover();

  const id = eventIdOf(event);
  detailReturnFocus = document.activeElement?.classList.contains("event-card")
    ? document.activeElement
    : [...eventStack.querySelectorAll(".event-card")]
      .find(card => card.dataset.eventId === id && id) || null;
  activeEventId = id;
  activeEvent = event;
  window.QDPEventLinks?.apply(event);
  eventEntryPushed = updateHistory && Boolean(id);

  if (eventEntryPushed) {
    history.pushState({ qdpEvent: id, qdpPushed: true }, "", eventPermalink(id));
  }

  savedEventScrollTop = eventStack.scrollTop;
  eventStack.hidden = true;
  eventDetail.hidden = false;

  eventDetail.classList.add(
    "is-open"
  );

  eventDetail.classList.toggle("explicit", event.explicitQueer === true);
  const dateBadge = eventDetail.querySelector(".event-detail-date-badge") ||
    document.createElement("div");
  eventDetail.replaceChildren();
  eventDetail.setAttribute("role", "dialog");
  eventDetail.setAttribute("aria-modal", "true");
  eventDetail.setAttribute("aria-labelledby", "eventDetailTitle");
  eventDetail.tabIndex = -1;

  if (event.queerArtist) {
    const flag = document.createElement("span");
    flag.className = "event-detail-flag event-detail-flag-queer";
    flag.setAttribute("role", "img");
    flag.setAttribute("aria-label", "Features a queer artist");
    eventDetail.appendChild(flag);
  }
  if (event.transArtist) {
    const flag = document.createElement("span");
    flag.className = "event-detail-flag event-detail-flag-trans";
    flag.setAttribute("role", "img");
    flag.setAttribute("aria-label", "Features a trans artist");
    eventDetail.appendChild(flag);
  }

  dateBadge.className = "event-detail-date-badge";
  const dateParts = formatDetailDateBadge(event);
  const dateText = document.createElement("span");
  dateText.className = "event-detail-date-text";
  dateText.textContent = dateParts.date;
  dateBadge.replaceChildren(dateText);
  eventDetail.appendChild(dateBadge);

  const detailCard =
    document.createElement("article");

  detailCard.className =
    "event-detail-card";

  const flyerSlot = document.createElement("div");
  flyerSlot.className = "event-detail-flyer-slot";

  if (event.flyerUrl) {
    const flyerSource =
      String(event.flyerUrl).trim();

    const driveIdMatch =
      flyerSource.match(
        /drive\.google\.com\/file\/d\/([^/?#]+)/i
      ) ||
      flyerSource.match(
        /[?&]id=([^&#]+)/i
      );

    const driveFileId =
      driveIdMatch
        ? driveIdMatch[1]
        : "";

    const flyer =
      document.createElement("img");

    flyer.className =
      "event-detail-flyer";

    flyer.src = driveFileId
      ? `https://lh3.googleusercontent.com/d/${driveFileId}=w1600`
      : flyerSource;

    flyer.alt =
      `Flyer for ${displayTitle(event)}`;

    flyer.loading = "eager";

    flyer.referrerPolicy =
      "no-referrer";

    flyer.addEventListener(
      "error",
      () => {
        const fallback =
          document.createElement("a");

        fallback.href = flyerSource;
        fallback.target = "_blank";

        fallback.rel =
          "noopener noreferrer";

        fallback.textContent =
          "Open event flyer";

        flyer.replaceWith(fallback);
      }
    );

    flyerSlot.appendChild(flyer);
  }

  const heading =
    document.createElement("h2");

  heading.id = "eventDetailTitle";
  heading.textContent = displayTitle(event);

  const venue = document.createElement("span");
  const venueTime = document.createElement("p");
  venueTime.className = "event-detail-venue-time";
  const address = document.createElement("p");
  address.className = "event-detail-address";
  const venueText = eventVenue(event);
  const addressText = eventAddress(event);
  const mapsQuery = [venueText, addressText].filter(Boolean).join(", ");
  const mapsUrl = mapsQuery && !window.QDPEventMetadata.undisclosed(mapsQuery)
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`
    : "";
  if (venueText) {
    const mapLink = document.createElement(mapsUrl ? "a" : "span");
    if (mapsUrl) {
      mapLink.href = mapsUrl;
      mapLink.target = "_blank";
      mapLink.rel = "noopener noreferrer";
    }
    mapLink.textContent = venueText;
    venue.appendChild(mapLink);
    venueTime.appendChild(venue);
    const separator = document.createElement("span");
    separator.setAttribute("aria-hidden", "true");
    separator.textContent = " | ";
    venueTime.appendChild(separator);
  }
  const time = document.createElement("time");
  time.dateTime = event.start;
  time.textContent = dateParts.time;
  venueTime.appendChild(time);

  if (addressText) {
    address.textContent = addressText;
  }

  const description =
    document.createElement("p");

  description.textContent =
    event.description || "";

  const titleLocation = document.createElement("div");
  titleLocation.className = "event-detail-title-location";
  titleLocation.append(heading, venueTime);
  if (addressText) titleLocation.appendChild(address);

  const more = document.createElement("div");
  more.className = "event-detail-more";
  if (description.textContent) more.appendChild(description);

  const actions = document.createElement("div");
  actions.className = "event-detail-actions";
  const addToCalendar = document.createElement("a");
  addToCalendar.href = googleCalendarEventUrl(event);
  addToCalendar.target = "_blank";
  addToCalendar.rel = "noopener noreferrer";
  addToCalendar.setAttribute("aria-label", "Add to Google Calendar");
  addToCalendar.title = "Add to Google Calendar";
  const calendarIcon = document.createElement("img");
  calendarIcon.className = "event-detail-action-icon";
  calendarIcon.src = "icons8-ios-calendar-48.png";
  calendarIcon.alt = "";
  addToCalendar.appendChild(calendarIcon);
  const share = document.createElement("button");
  share.type = "button";
  share.setAttribute("aria-label", "Share");
  share.title = "Share";
  const shareIcon = document.createElement("img");
  shareIcon.className = "event-detail-action-icon";
  shareIcon.src = "icons8-ios-share-48.png";
  shareIcon.alt = "";
  share.appendChild(shareIcon);
  const status = document.createElement("span");
  status.className = "event-share-status";
  status.setAttribute("role", "status");
  share.addEventListener("click", () => shareEvent(event, status));
  actions.append(addToCalendar, share, status);

  if (flyerSlot.childNodes.length) detailCard.appendChild(flyerSlot);
  else detailCard.classList.add("without-flyer");
  detailCard.appendChild(titleLocation);
  if (more.childNodes.length) detailCard.appendChild(more);

  const seeMore = document.createElement("section");
  seeMore.className = "event-detail-see-more";
  seeMore.setAttribute("aria-label", "See More");
  seeMore.hidden = true;
  const seeMoreHeading = document.createElement("h3");
  seeMoreHeading.textContent = "See More";
  const seeMoreLinks = document.createElement("div");
  seeMoreLinks.className = "event-detail-see-more-links";
  seeMore.append(seeMoreHeading, seeMoreLinks);
  detailCard.appendChild(seeMore);
  detailCard.appendChild(actions);

  const back = document.createElement("a");
  back.className = "event-detail-back";
  back.href = homepageUrl();
  back.textContent = `← Back to ${window.QDPArchive?.active
    ? document.getElementById("archiveHeader")?.textContent || "Past Events"
    : "Calendar"}`;
  back.addEventListener("click", click => {
    if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
    click.preventDefault();
    closeEventDetail();
  });

  eventDetail.append(detailCard, back);
  fitDetailContent();
  updateDetailNavigationState();
  if (infoView.active) {
    eventDetail.inert = true;
    eventDetail.setAttribute("aria-hidden", "true");
  } else {
    eventDetail.focus({ preventScroll: true });
  }
  loadEventRelations(id, detailCard, seeMore, seeMoreLinks, event.related);
}

const eventRelations = new Map();
const RELATIONS_CACHE_MS = 60 * 1000;

function loadEventRelations(id, card, section, links, preparedRelated) {
  if (!id) return;
  if (Array.isArray(preparedRelated)) {
    eventRelations.set(id, { at: Date.now(), promise: Promise.resolve({ related: preparedRelated }) });
  } else if (!eventRelations.has(id) || Date.now() - eventRelations.get(id).at >= RELATIONS_CACHE_MS) {
    const entry = { at: Date.now(), promise: null };
    entry.promise = fetch(`/api/event-relations?event=${encodeURIComponent(id)}`, { cache: "no-cache" })
      .then(response => {
        if (!response.ok) throw new Error("Related links unavailable");
        return response.json();
      }).then(data => {
        if (!Array.isArray(data.related)) throw new Error("Invalid related links");
        entry.at = Date.now();
        return data;
      }).catch(error => {
        if (eventRelations.get(id) === entry) eventRelations.delete(id);
        throw error;
      });
    eventRelations.set(id, entry);
  }
  eventRelations.get(id).promise.then(data => {
    if (!card.isConnected || activeEventId !== id) return;
    links.replaceChildren();
    const colors = { artist: "red", venue: "orange", party: "purple", collective: "collective" };
    for (const item of data.related) {
      if (!colors[item.kind] || !/^[\w-]{1,80}$/.test(item.id) || !item.name) continue;
      const url = new URL("/", location.origin);
      url.searchParams.set("archive", item.kind);
      url.searchParams.set("id", item.id);
      const link = document.createElement("a");
      link.className = `event-detail-related-bubble event-detail-related-bubble--${colors[item.kind]}`;
      link.href = url.href;
      link.setAttribute("data-archive-link", "");
      link.textContent = item.name;
      links.appendChild(link);
    }
    section.hidden = !links.childElementCount;
  }).catch(() => {
    if (!card.isConnected || activeEventId !== id) return;
    links.replaceChildren();
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "event-detail-related-retry";
    retry.textContent = "Related links unavailable. Try again";
    retry.addEventListener("click", () => loadEventRelations(id, card, section, links));
    links.appendChild(retry);
    section.hidden = false;
  });
}

function orderedEvents() {
  if (window.QDPArchive?.active) return window.QDPArchive.events;
  return posterPages.flatMap(page => page.events);
}

function updateDetailNavigationState() {
  const events = orderedEvents();
  const index = events.findIndex(event => event === activeEvent || activeEventId && eventIdOf(event) === activeEventId);
  previousPoster.disabled = index <= 0;
  nextPoster.disabled = index < 0 || index === events.length - 1;
  previousPoster.setAttribute("aria-label", "Previous event");
  nextPoster.setAttribute("aria-label", "Next event");
  previousPoster.title = events[index - 1] ? displayTitle(events[index - 1]) : "Previous event";
  nextPoster.title = events[index + 1] ? displayTitle(events[index + 1]) : "Next event";
}

function finishDetailSlide() {
  if (!activeDetailSlide) return;
  const { viewport, card, outgoingDateText, ghostFlags, animations } = activeDetailSlide;
  const focused = eventDetail.contains(document.activeElement)
    ? document.activeElement : null;
  activeDetailSlide = null;
  animations.forEach(animation => animation.cancel());
  eventDetail.appendChild(card);
  outgoingDateText?.remove();
  ghostFlags.forEach(flag => flag.remove());
  viewport.remove();
  if (focused?.isConnected) focused.focus({ preventScroll: true });
}

function moveEventDetail(direction) {
  if (window.QDPArchive?.active) {
    const items = orderedEvents();
    const index = items.findIndex(event => event === activeEvent || activeEventId && eventIdOf(event) === activeEventId);
    if (index < 0) return;
    const next = items[index + direction];
    if (!next) return;
    const pushed = eventEntryPushed;
    hideEventDetail({ restoreFocus: false });
    window.QDPArchive.focusEvent(next);
    history.replaceState(
      { qdpEvent: eventIdOf(next), qdpPushed: pushed },
      "", window.QDPArchive.eventUrl(eventIdOf(next))
    );
    openEventDetail(next, { updateHistory: false });
    eventEntryPushed = pushed;
    return;
  }
  finishDetailSlide();
  const events = orderedEvents();
  const index = events.findIndex(event => event === activeEvent || activeEventId && eventIdOf(event) === activeEventId);
  if (index < 0) return;
  const next = events[index + direction];
  if (!next) return;

  const animateSlide = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const currentDate = dateKey(new Date(activeEvent.start));
  const nextDate = dateKey(new Date(next.start));
  const dateChanged = currentDate !== nextDate;
  const previousFlags = {
    queer: Boolean(eventDetail.querySelector(".event-detail-flag-queer")),
    trans: Boolean(eventDetail.querySelector(".event-detail-flag-trans"))
  };
  const previousCard = eventDetail.querySelector(".event-detail-card");
  const previousScrollTop = previousCard?.scrollTop || 0;
  const outgoing = animateSlide ? previousCard?.cloneNode(true) : null;
  const outgoingDateText = animateSlide && dateChanged
    ? eventDetail.querySelector(".event-detail-date-text")?.cloneNode(true)
    : null;
  if (outgoing) {
    outgoing.querySelectorAll("[id]").forEach(node => node.removeAttribute("id"));
    outgoing.setAttribute("aria-hidden", "true");
    outgoing.inert = true;
  }
  const keepPushedEntry = eventEntryPushed;
  hideEventDetail({ restoreFocus: false });
  const pageIndex = posterPages.findIndex(page => page.events.includes(next));
  scrollToPage(pageIndex, "auto");
  const target = eventCardsById.get(eventIdOf(next)) || pageCards[pageIndex];
  if (target) {
    eventStack.scrollTo({ top: scrollOffset(target), behavior: "auto" });
    updateScrollState();
  }
  if (eventIdOf(next)) {
    history.replaceState(
      { qdpEvent: eventIdOf(next), qdpPushed: keepPushedEntry },
      "", eventPermalink(eventIdOf(next))
    );
  }
  openEventDetail(next, { updateHistory: false });
  eventEntryPushed = keepPushedEntry;

  if (!outgoing) return;
  const viewport = document.createElement("div");
  viewport.className = "event-detail-content-viewport";
  const incoming = eventDetail.querySelector(".event-detail-card");
  const dateBadge = eventDetail.querySelector(".event-detail-date-badge");
  const incomingDateText = dateBadge.querySelector(".event-detail-date-text");
  if (outgoingDateText) {
    outgoingDateText.setAttribute("aria-hidden", "true");
    dateBadge.appendChild(outgoingDateText);
  }
  viewport.append(outgoing, incoming);
  eventDetail.appendChild(viewport);
  outgoing.scrollTop = previousScrollTop;
  eventDetail.focus({ preventScroll: true });
  fitDetailContent();

  const distance = viewport.clientWidth * direction;
  const timing = { duration: 380, easing: "cubic-bezier(.25,.8,.25,1)", fill: "forwards" };
  const animations = [
    outgoing.animate([
      { transform: "translateX(0)" },
      { transform: `translateX(${-distance}px)` }
    ], timing),
    incoming.animate([
      { transform: `translateX(${distance}px)` },
      { transform: "translateX(0)" }
    ], timing)
  ];
  if (outgoingDateText) {
    const dateDistance = dateBadge.clientHeight * (nextDate > currentDate ? -1 : 1);
    animations.push(
      outgoingDateText.animate([
        { transform: "translateY(0)" },
        { transform: `translateY(${-dateDistance}px)` }
      ], timing),
      incomingDateText.animate([
        { transform: `translateY(${dateDistance}px)` },
        { transform: "translateY(0)" }
      ], timing)
    );
  }
  const ghostFlags = [];
  for (const type of ["queer", "trans"]) {
    const newFlag = eventDetail.querySelector(`.event-detail-flag-${type}`);
    const flagShift = (type === "queer" ? -1 : 1) * viewport.clientWidth * 0.16;
    if (previousFlags[type] && !newFlag) {
      const oldFlag = document.createElement("span");
      oldFlag.className = `event-detail-flag event-detail-flag-${type}`;
      oldFlag.setAttribute("aria-hidden", "true");
      eventDetail.appendChild(oldFlag);
      ghostFlags.push(oldFlag);
      animations.push(oldFlag.animate([
        { transform: "translateX(0)", opacity: 1 },
        { transform: `translateX(${flagShift}px)`, opacity: 0 }
      ], timing));
    } else if (!previousFlags[type] && newFlag) {
      animations.push(newFlag.animate([
        { transform: `translateX(${flagShift}px)`, opacity: 0 },
        { transform: "translateX(0)", opacity: 1 }
      ], timing));
    }
  }
  activeDetailSlide = { viewport, card: incoming, outgoingDateText, ghostFlags, animations };
  Promise.all(animations.map(animation => animation.finished.catch(() => {})))
    .then(() => {
      if (activeDetailSlide?.viewport === viewport) finishDetailSlide();
    });
}

function hideEventDetail({ restoreFocus = true } = {}) {
  finishDetailSlide();
  window.QDPEventLinks?.clear();
  if (
    eventDetail.classList.contains(
      "is-open"
    )
  ) {
    eventDetail.hidden = true;
    eventDetail.classList.remove("is-open", "explicit");
    eventStack.hidden = false;
    eventStack.scrollTop = savedEventScrollTop;
    if (window.QDPArchive?.active) window.QDPArchive.updateControls();
    else updateScrollState();
    if (!window.QDPArchive?.active) {
      previousPoster.setAttribute("aria-label", "Previous date");
      nextPoster.setAttribute("aria-label", "Next date");
    }
    if (restoreFocus) detailReturnFocus?.isConnected &&
      detailReturnFocus.focus({ preventScroll: true });
  }
  activeEventId = "";
  activeEvent = null;
  eventEntryPushed = false;
}

function closeEventDetail() {
  if (eventDetail.hidden) return;
  const shouldGoBack = eventEntryPushed && history.state?.qdpPushed &&
    requestedEventId() === activeEventId;
  const hasEventUrl = Boolean(requestedEventId());
  hideEventDetail();
  if (shouldGoBack) history.back();
  else if (hasEventUrl) history.replaceState(null, "", homepageUrl());
}

let eventLookupSerial = 0;

function showEventLookupError(error) {
  hideEventDetail({ restoreFocus: false });
  eventStack.hidden = true;
  eventDetail.hidden = false;
  eventDetail.classList.add("is-open");
  eventDetail.replaceChildren();
  eventDetail.setAttribute("role", "dialog");
  eventDetail.setAttribute("aria-modal", "true");
  eventDetail.setAttribute("aria-labelledby", "eventDetailTitle");
  eventDetail.tabIndex = -1;
  const card = document.createElement("article");
  card.className = "event-detail-card without-flyer";
  const heading = document.createElement("h2");
  heading.id = "eventDetailTitle";
  heading.textContent = error.status === 404 || error.status === 400
    ? "Event unavailable" : "Event data is temporarily unavailable";
  card.appendChild(heading);
  if (error.status !== 404 && error.status !== 400) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => {
      const id = requestedEventId();
      window.QDPEventLinks.get(id, { force: true }).then(event => {
        if (requestedEventId() === eventIdOf(event)) openEventDetail(event, { updateHistory: false });
      }).catch(error => { if (requestedEventId() === id) showEventLookupError(error); });
    });
    card.appendChild(retry);
  }
  const back = document.createElement("a");
  back.className = "event-detail-back";
  back.href = homepageUrl();
  back.textContent = "← Back";
  back.addEventListener("click", click => {
    if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
    click.preventDefault();
    closeEventDetail();
  });
  eventDetail.append(card, back);
  previousPoster.disabled = true;
  nextPoster.disabled = true;
  eventDetail.focus({ preventScroll: true });
}

async function syncEventFromUrl({ final = freshEventsLoaded } = {}) {
  if (window.QDPArchive?.active ||
      new URLSearchParams(window.location.search).has("archive")) return;
  const id = requestedEventId();
  const serial = ++eventLookupSerial;
  if (!id) {
    hideEventDetail();
    return;
  }
  if (activeEventId === id && !eventDetail.hidden) return;
  const index = posterPages.findIndex(page =>
    page.events.some(event => eventIdOf(event) === id));
  let event = index >= 0 ? posterPages[index].events.find(item => eventIdOf(item) === id) : null;
  if (!event) {
    if (!final && !window.QDPEventLinks?.initial?.event) return;
    try { event = await window.QDPEventLinks.get(id); }
    catch (error) {
      if (serial === eventLookupSerial && requestedEventId() === id && !window.QDPArchive?.active) showEventLookupError(error);
      return;
    }
  }
  if (serial !== eventLookupSerial || requestedEventId() !== id || window.QDPArchive?.active) return;
  if (!eventDetail.hidden) hideEventDetail({ restoreFocus: false });
  if (index >= 0) scrollToPage(index, "auto");
  const targetCard = eventCardsById.get(id);
  if (targetCard) {
    eventStack.scrollTo({ top: scrollOffset(targetCard), behavior: "auto" });
    updateScrollState();
  }
  openEventDetail(event, { updateHistory: false });
  eventEntryPushed = Boolean(history.state?.qdpPushed);
}

window.addEventListener("popstate", () => syncEventFromUrl());

eventDetail.addEventListener("keydown", event => {
  if (event.key !== "Tab") return;
  const liveCard = eventDetail.querySelector(".event-detail-card:not([aria-hidden])");
  const controls = [...(liveCard?.querySelectorAll("a[href], button:not([disabled])") || []),
    ...eventDetail.querySelectorAll(".event-detail-back")];
  {
    for (let i = controls.length - 1; i >= 0; i--) {
      if (controls[i].classList.contains("event-detail-back")) controls.splice(i, 1);
    }
    const mobileBack = document.getElementById("mobileBack");
    if (mobileBack && !mobileBack.hidden) controls.push(mobileBack);
  }
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (document.activeElement === eventDetail) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

eventDetail.addEventListener(
  "click",
  event => {
    if (event.target === eventDetail) {
      closeEventDetail();
    }
  }
);

document.addEventListener("click", event => {
  if (!event.isTrusted || infoView.active || eventDetail.hidden || eventDetail.contains(event.target)) return;
  if (window.QDPMobile?.active && event.target instanceof Element &&
      event.target.closest(".side-nav, #archiveMenuTrack, #mobileContext, #mobileSheetBackdrop")) return;
  if (event.target instanceof Element &&
      event.target.closest("#mobileBack, #previousPoster, #nextPoster, .event-card, a[data-archive-link], a[data-discover-link]")) return;
  closeEventDetail();
});

const infoViewport = document.getElementById("infoViewport");
let infoExitTimer = 0;
const infoViews = { about: aboutDialog, melt: meltDialog };
const infoView = {
  active: "",
  restoreDiscover: false,
  show(kind, { historyEntry = true } = {}) {
    if (!infoViews[kind]) return;
    if (this.active === kind) return;
    if (!this.active) this.restoreDiscover = window.QDPArchive?.isMenuOpen() || false;
    closeDatePopover();
    if (historyEntry) {
      const url = new URL(location.href);
      url.hash = kind;
      history.pushState({ qdpInfo: kind }, "", url);
    }
    this.active = kind;
    document.body.classList.add("info-mode");
    if (!eventDetail.hidden) {
      eventDetail.inert = true;
      eventDetail.setAttribute("aria-hidden", "true");
    }
    clearTimeout(infoExitTimer);
    infoViewport.hidden = false;
    for (const [key, view] of Object.entries(infoViews)) {
      view.hidden = key !== kind;
      view.style.transition = "none";
      view.classList.remove("is-open");
    }
    window.QDPArchive?.hideMenu();
    void infoViews[kind].offsetHeight;
    for (const view of Object.values(infoViews)) view.style.transition = "";
    requestAnimationFrame(() => {
      if (this.active === kind) infoViews[kind].classList.add("is-open");
    });
    document.title = `${kind === "about" ? "About" : "Melt"} | Queer Dance Philly`;
  },
  close({ historyEntry = true, preserveMenu = false } = {}) {
    if (!this.active) return;
    if (historyEntry && history.state?.qdpInfo === this.active) {
      history.back();
      return;
    }
    if (historyEntry) {
      const url = new URL(location.href);
      url.hash = "";
      history.replaceState(history.state, "", url);
    }
    this.active = "";
    document.body.classList.remove("info-mode");
    eventDetail.inert = false;
    eventDetail.removeAttribute("aria-hidden");
    for (const view of Object.values(infoViews)) view.classList.remove("is-open");
    clearTimeout(infoExitTimer);
    infoExitTimer = setTimeout(() => {
      if (!this.active) infoViewport.hidden = true;
    }, 500);
    if (!preserveMenu) {
      const view = new URLSearchParams(location.search).get("archive");
      if (view && window.QDPArchive?.active) window.QDPArchive.showMenu(view);
      else if (this.restoreDiscover) window.QDPArchive?.showMenu();
      else window.QDPArchive?.hideMenu();
    }
    document.title = window.QDPArchive?.active
      ? `${document.getElementById("archiveHeader").textContent} | Queer Dance Philly`
      : "Queer Dance Philly";
  }
};
window.QDPInfoView = infoView;

aboutLink.addEventListener("click", event => {
  event.preventDefault();
  infoView.show("about");
});
meltLink.addEventListener("click", event => {
  event.preventDefault();
  infoView.show("melt");
});
aboutCloseButton.addEventListener("click", () => infoView.close());
meltCloseButton.addEventListener("click", () => infoView.close());
window.addEventListener("popstate", () => {
  const kind = location.hash.slice(1);
  if (infoViews[kind]) {
    infoView.show(kind, { historyEntry: false });
  } else {
    infoView.close({ historyEntry: false });
  }
});
queueMicrotask(() => {
  const kind = location.hash.slice(1);
  if (infoViews[kind]) {
    infoView.show(kind, { historyEntry: false });
  }
});

function movePoster(direction) {
  if (window.QDPArchive?.active) {
    if (!eventDetail.hidden) moveEventDetail(direction);
    else window.QDPArchive.move(direction);
    return;
  }
  if (!eventDetail.hidden) {
    moveEventDetail(direction);
    return;
  }
  const nextIndex =
    (navigationTargetIndex ?? currentPosterIndex) + direction;

  if (
    nextIndex < 0 ||
    nextIndex >= posterPages.length
  ) {
    return;
  }

  closeDatePopover();
  scrollToPage(nextIndex);
}

previousPoster.addEventListener(
  "click",
  () => movePoster(-1)
);

nextPoster.addEventListener(
  "click",
  () => movePoster(1)
);

todayButton.addEventListener("click", () => {
  if (window.QDPArchive?.active) return;
  const today = dateKey(new Date());
  const index = posterPages.findIndex(page => page.date >= today);
  if (index < 0) return;
  if (!eventDetail.hidden) closeEventDetail();
  closeDatePopover();
  scrollToPage(index);
});

eventStack.addEventListener("scroll", () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    if (window.QDPArchive?.active) window.QDPArchive.updateControls();
    else updateScrollState();
  });
}, { passive: true });

poster.addEventListener("wheel", event => {
  // Let Start Here and Melt scroll without moving the feed behind them.
  if (infoView.active) return;
  if (window.QDPArchive?.active) {
    const archiveStack = document.getElementById("archiveStack");
    if (!eventDetail.hidden || archiveStack.contains(event.target)) return;
    event.preventDefault();
    archiveStack.scrollBy({ top: event.deltaY, behavior: "auto" });
    return;
  }
  if (!eventDetail.hidden || !datePopover.hidden ||
      eventStack.contains(event.target) || !pageCards.length) return;
  if (Math.abs(event.deltaY) < 1) return;
  event.preventDefault();
  eventStack.scrollBy({ top: event.deltaY, behavior: "auto" });
}, { passive: false });

window.addEventListener(
  "keydown",
  event => {
    if (event.key === "Escape") {
      if (infoView.active) {
        infoView.close();
        return;
      }

      if (!eventDetail.hidden) {
        closeEventDetail();
      } else {
        closeDatePopover();
      }

      return;
    }

    // Modified arrows belong to browser history and native text navigation.
    if (infoView.active || event.defaultPrevented || event.metaKey ||
        event.ctrlKey || event.altKey || event.shiftKey) return;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      movePoster(-1);
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      movePoster(1);
    }
  }
);

poster.addEventListener(
  "touchstart",
  event => {
    if (layoutEditorEnabled) {
      return;
    }

    touchDetailAtTop = !eventDetail.hidden && !infoView.active && eventDetail.contains(event.target) &&
      (eventDetail.querySelector(".event-detail-card:not([aria-hidden])")?.scrollTop || 0) <= 2;
    touchStartX =
      event.changedTouches[0].clientX;
    touchStartY =
      event.changedTouches[0].clientY;
  },
  { passive: true }
);

poster.addEventListener(
  "touchend",
  event => {
    if (
      touchStartX === null
    ) {
      touchStartX = null;
      touchStartY = null;
      return;
    }

    const deltaX =
      event.changedTouches[0].clientX -
      touchStartX;
    const deltaY =
      event.changedTouches[0].clientY -
      touchStartY;

    if (touchDetailAtTop && deltaY > 72 && deltaY > Math.abs(deltaX) * 1.2) {
      closeEventDetail();
    } else if (Math.abs(deltaX) > 50 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2) {
      movePoster(
        deltaX < 0 ? 1 : -1
      );
    }

    touchStartX = null;
    touchStartY = null;
    touchDetailAtTop = false;
  },
  { passive: true }
);

dateButton.addEventListener(
  "click",
  () => {
    if (window.QDPArchive?.active) return;
    if (layoutEditorEnabled) {
      return;
    }

    if (datePopover.hidden) {
      openDatePopover();
    } else {
      closeDatePopover();
    }
  }
);

document.addEventListener(
  "click",
  event => {
    if (
      !datePopover.hidden &&
      !dateButton.contains(event.target) &&
      !datePopover.contains(event.target)
    ) {
      closeDatePopover();
    }
  }
);

function renderEventCollection(
  events
) {
  const previousPage = posterPages[currentPosterIndex];
  const previousFirst = previousPage?.events[0];
  navigationTargetIndex = null;
  posterPages =
    buildPosterPages(events);

  if (!posterPages.length) {
    pageCards = [];
    eventCardsById = new Map();
    dateSections = [];
    cornerTransitions = [];
    previousPoster.disabled = true;
    nextPoster.disabled = true;

    if (!window.QDPArchive?.active) {
      showEventFeedMessage("No upcoming listings right now.");
    }

    return;
  }

  const today =
    dateKey(new Date());

  const todayIndex =
    posterPages.findIndex(
      page =>
        page.date >= today
    );

  const matchingPage = previousFirst
    ? posterPages.findIndex(page =>
        page.date === previousPage.date &&
        page.events.some(event =>
          event.start === previousFirst.start &&
          event.title === previousFirst.title
        ))
    : -1;

  currentPosterIndex = matchingPage >= 0
    ? matchingPage
    : todayIndex >= 0 ? todayIndex : 0;

  if (!window.QDPArchive?.active) {
    renderPoster();
    requestAnimationFrame(() => syncEventFromUrl());
  }
}

let displayedPublicEvents = null;
let lastLiveRefreshAt = 0;
let liveRefreshPromise = null;

function refreshPublicEvents() {
  if (liveRefreshPromise) return liveRefreshPromise;
  liveRefreshPromise = (async () => {
    try {
      const freshEvents = await loadPublicEvents();
      writeCachedPublicEvents(freshEvents);
      if (!displayedPublicEvents || JSON.stringify(freshEvents) !== JSON.stringify(displayedPublicEvents)) {
        renderEventCollection(freshEvents);
      }
      displayedPublicEvents = freshEvents;
      lastLiveRefreshAt = Date.now();
    } catch (error) {
      console.error(error);
      if (!displayedPublicEvents && !window.QDPArchive?.active) {
        showEventFeedMessage("Listings could not load. Please refresh.");
      }
    } finally {
      liveRefreshPromise = null;
      freshEventsLoaded = true;
      requestAnimationFrame(() => syncEventFromUrl({ final: true }));
    }
  })();
  return liveRefreshPromise;
}

async function initialize() {
  // The HTML already contains the prepared feed. Re-fetching it immediately
  // transfers the same listings again and can repeat a KV read at a cold edge.
  const initialEvents = readInitialPublicEvents();
  displayedPublicEvents = initialEvents ?? readCachedPublicEvents();
  if (displayedPublicEvents) renderEventCollection(displayedPublicEvents);
  else showEventFeedMessage("Loading listings…");

  if (initialEvents) {
    writeCachedPublicEvents(initialEvents);
    lastLiveRefreshAt = Date.now();
    freshEventsLoaded = true;
    requestAnimationFrame(() => syncEventFromUrl({ final: true }));
    return;
  }
  await refreshPublicEvents();
}

initializeMobileMenu();

// Refit date labels after the display font replaces its fallback.
if (document.fonts) {
  document.fonts.load('700 32px "QDP Fraunces"')
    .then(schedulePosterLayout)
    .catch(error => console.warn("Fraunces could not load:", error));
}

if ("ResizeObserver" in window) {
  new ResizeObserver(schedulePosterLayout).observe(poster);
} else {
  window.addEventListener("resize", schedulePosterLayout);
}
if (layoutEditorEnabled) {
  document.addEventListener("input", schedulePosterLayout);
}

let liveInitializationPromise = null;
function ensureLiveEvents() {
  if (!liveInitializationPromise) liveInitializationPromise = initialize();
  else if (Date.now() - lastLiveRefreshAt >= 60 * 1000) refreshPublicEvents();
  return liveInitializationPromise;
}
window.QDPEnsureLiveEvents = ensureLiveEvents;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !window.QDPArchive?.active) ensureLiveEvents();
});
setInterval(() => {
  if (document.visibilityState === "visible" && !window.QDPArchive?.active) ensureLiveEvents();
}, 60 * 1000);

const initialArchiveView = new URLSearchParams(location.search).get("archive");
if (!initialArchiveView && window.QDPEventLinks?.initial?.event) {
  openEventDetail(window.QDPEventLinks.initial.event, { updateHistory: false });
}
(initialArchiveView ? Promise.resolve() : ensureLiveEvents()).finally(() => {
  if (
    typeof window
      .initializeComprehensiveLayoutEditor ===
    "function"
  ) {
    window
      .initializeComprehensiveLayoutEditor();
  }
});

(() => {
  const back = document.getElementById("mobileBack");
  const archiveBack = document.getElementById("archiveBack");
  const mobileNavigation = window.matchMedia("(max-width: 760px)");
  let target = null;
  let frame = 0;
  function sync() {
    frame = 0;
    const infoOpen = Boolean(window.QDPInfoView?.active);
    target = !eventDetail.hidden && !infoOpen ? eventDetail.querySelector(".event-detail-back")
      : window.QDPArchive?.active && !archiveBack.hidden && !infoOpen ? archiveBack : null;
    back.hidden = !target;
    if (target) {
      back.textContent = mobileNavigation.matches ? target.textContent.replace(/^←\s*/, "") : target.textContent;
      back.href = target.href;
    }
    for (const button of [previousPoster, nextPoster]) {
      const label = button.getAttribute("aria-label") || "";
      button.dataset.navLabel = /^(Previous|Next) (letter|group): /.test(label)
        ? label.replace(/^(Previous|Next) (letter|group): /, (_, direction) => direction === "Previous" ? "Prev: " : "Next: ")
        : label.replace(/: .*$/, "").replace(/^Previous /, "Prev ");
      if (!/event$/.test(label)) button.title = label;
    }
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(sync); }
  back.addEventListener("click", event => {
    if (!target || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); event.stopPropagation(); target.click();
  });
  back.addEventListener("keydown", event => {
    if (event.key !== "Tab" || event.shiftKey || eventDetail.hidden) return;
    const first = eventDetail.querySelector(".event-detail-card:not([aria-hidden]) a[href], .event-detail-card:not([aria-hidden]) button:not(:disabled)");
    if (first) { event.preventDefault(); first.focus(); }
  });
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  observer.observe(eventDetail, { childList: true, attributes: true, attributeFilter: ["hidden"] });
  observer.observe(archiveBack, { childList: true, attributes: true, attributeFilter: ["hidden", "href"] });
  for (const button of [previousPoster, nextPoster]) observer.observe(button, { attributes: true, attributeFilter: ["aria-label", "disabled"] });
  mobileNavigation.addEventListener("change", schedule);
  sync();
  // A mouse drag on the flyer/header mirrors the touch gesture on desktop.
  let drag = null;
  eventDetail.addEventListener("pointerdown", event => {
    if (event.pointerType !== "mouse" || event.button !== 0 || infoView.active ||
        !event.target.closest(".event-detail-flyer-slot, .event-detail-date-badge") ||
        (eventDetail.querySelector(".event-detail-card:not([aria-hidden])")?.scrollTop || 0) > 2) return;
    drag = { x: event.clientX, y: event.clientY };
  });
  eventDetail.addEventListener("dragstart", event => {
    if (event.target.closest(".event-detail-flyer-slot")) event.preventDefault();
  });
  window.addEventListener("pointerup", event => {
    if (!drag) return;
    const dy = event.clientY - drag.y, dx = event.clientX - drag.x;
    drag = null;
    if (dy > 72 && dy > Math.abs(dx) * 1.2) closeEventDetail();
  });
  window.addEventListener("pointercancel", () => { drag = null; });
})();
