const EVENTS_API_URL =
  "/api/events";

const EVENTS_STORAGE_KEY =
  "qdp-public-events-v2";

const EVENTS_STORAGE_MAX_AGE_MS =
  24 * 60 * 60 * 1000;

const MAX_EVENTS_PER_POSTER = 6;

const dateLabel = document.getElementById("dateLabel");
const eventStack = document.getElementById("eventStack");
const eventDetail = document.getElementById("eventDetail");
const dateButton = document.getElementById("dateButton");
const datePopover = document.getElementById("datePopover");
const previousPoster = document.getElementById("previousPoster");
const nextPoster = document.getElementById("nextPoster");
const poster = document.getElementById("poster");
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
let pageCards = [];
let dateSections = [];
let cornerTransitions = [];
let scrollFrame = 0;
let savedEventScrollTop = 0;
let navigationTargetIndex = null;
let arrowFocusDateKey = null;

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

function splitIntoPosterPages(events) {
  if (events.length <= MAX_EVENTS_PER_POSTER) {
    return [events];
  }

  const numberOfPages = Math.ceil(
    events.length / MAX_EVENTS_PER_POSTER
  );

  const baseSize = Math.floor(
    events.length / numberOfPages
  );

  const remainder =
    events.length % numberOfPages;

  const pages = [];
  let index = 0;

  for (
    let page = 0;
    page < numberOfPages;
    page++
  ) {
    const size =
      baseSize + (page < remainder ? 1 : 0);

    pages.push(
      events.slice(index, index + size)
    );

    index += size;
  }

  return pages;
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
    .flatMap(key =>
      splitIntoPosterPages(
        sortEvents(grouped.get(key))
      ).map(pageEvents => ({
        date: key,
        events: pageEvents
      }))
    );
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

function fitPosterTitles() {
  eventStack.querySelectorAll(".event-title").forEach(title => {
    title.style.fontSize = "";
    const available = title.clientWidth;
    const fullWidth = title.scrollWidth;
    if (available > 0 && fullWidth > available) {
      const base = parseFloat(getComputedStyle(title).fontSize);
      title.style.fontSize = `${Math.max(1, base * available / fullWidth - 0.5)}px`;
    }
  });

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
  eventStack.hidden = false;
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
  const card = document.createElement("button");
  card.type = "button";
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
  card.addEventListener("click", () => openEventDetail(event));
  return card;
}

function renderPoster() {
  if (!posterPages.length) return;

  eventDetail.hidden = true;
  eventDetail.classList.remove("is-open", "explicit");
  eventStack.hidden = false;
  eventStack.innerHTML = "";
  pageCards = new Array(posterPages.length);
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

    const spacer = document.createElement("div");
    spacer.className = "date-end-spacer";
    spacer.setAttribute("aria-hidden", "true");
    section.appendChild(spacer);
    eventStack.appendChild(section);
    dateSections.push({
      key: date.key, section, marker, spacer,
      lastPageIndex: date.lastPageIndex
    });
  });

  requestAnimationFrame(() => {
    measureDateSpacers();
    scrollToPage(currentPosterIndex, "auto");
    fitPosterTitles();
  });
}

function scrollOffset(element) {
  return element.getBoundingClientRect().top -
    eventStack.getBoundingClientRect().top + eventStack.scrollTop;
}

function measureDateSpacers() {
  if (!pageCards.length || eventStack.hidden) return;
  dateSections.forEach(({ key, spacer, lastPageIndex }) => {
    spacer.style.height = "0px";
    // Arrow pages keep the next date out of the frame. Free scrolling uses
    // a short, visible break between dates instead of a blank screen.
    if (key !== arrowFocusDateKey) {
      spacer.style.height = "4cqw";
      return;
    }
    const pageTop = scrollOffset(pageCards[lastPageIndex]);
    const naturalEnd = scrollOffset(spacer);
    spacer.style.height = Math.max(0,
      pageTop + eventStack.clientHeight - naturalEnd + 2,
      poster.clientWidth * 0.04) + "px";
  });
}

function scrollToPage(index, behavior = "smooth", focusLastPage = true) {
  if (!pageCards[index]) return;
  if (focusLastPage) {
    const section = dateSections.find(item => item.lastPageIndex === index);
    arrowFocusDateKey = section ? section.key : null;
    measureDateSpacers();
  }
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
    // Start when the time block touches the final card; finish when their
    // bottom edges meet. Reversing the scroll reverses the radius as well.
    const progress = Math.max(0, Math.min(1,
      (timeBottom - cardBox.top) / cardBox.height));
    return [card, radius * (1 - progress)];
  });
  updates.forEach(([card, value]) =>
    card.style.setProperty("--qdp-tail-radius", `${value}px`));
}

function updateScrollState() {
  if (!posterPages.length || !pageCards.length || eventStack.hidden) return;
  updateTimeGroupCorners();
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
    if (!pageCards.length || eventStack.hidden) return;
    const index = currentPosterIndex;
    measureDateSpacers();
    scrollToPage(index, "auto", false);
    fitPosterTitles();
  });
}

function releaseArrowPageSpace() {
  if (arrowFocusDateKey === null) return;
  arrowFocusDateKey = null;
  navigationTargetIndex = null;
  measureDateSpacers();
}

function openEventDetail(event) {
  closeDatePopover();

  savedEventScrollTop = eventStack.scrollTop;
  eventStack.hidden = true;
  eventDetail.hidden = false;

  eventDetail.classList.add(
    "is-open"
  );

  eventDetail.classList.toggle("explicit", event.explicitQueer === true);

  eventDetail.innerHTML = "";

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

  const detailCard =
    document.createElement("article");

  detailCard.className =
    "event-detail-card";

  const firstScreen = document.createElement("div");
  firstScreen.className = "event-detail-first-screen";
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

  heading.textContent = displayTitle(event);

  const time =
    document.createElement("p");

  time.textContent =
    formatTimeRange(event);

  const venue =
    document.createElement("p");

  venue.textContent =
    eventVenue(event);

  venue.hidden =
    !venue.textContent;

  const address =
    document.createElement("p");

  address.textContent =
    eventAddress(event);

  address.hidden =
    !address.textContent;

  const description =
    document.createElement("p");

  description.textContent =
    event.description || "";

  const titleLocation = document.createElement("div");
  titleLocation.className = "event-detail-title-location";
  titleLocation.append(heading, venue, address);
  firstScreen.append(flyerSlot, titleLocation);

  const more = document.createElement("div");
  more.className = "event-detail-more";
  more.append(time, description);
  detailCard.append(firstScreen, more);

  const closeButton =
    document.createElement("button");

  closeButton.type = "button";

  closeButton.className =
    "overlay-close event-detail-close";

  closeButton.textContent = "×";

  closeButton.setAttribute(
    "aria-label",
    "Close event details"
  );

  closeButton.addEventListener(
    "click",
    closeEventDetail
  );

  eventDetail.append(
    detailCard,
    closeButton
  );
}

function closeEventDetail() {
  if (
    eventDetail.classList.contains(
      "is-open"
    )
  ) {
    eventDetail.hidden = true;
    eventDetail.classList.remove("is-open", "explicit");
    eventStack.hidden = false;
    eventStack.scrollTop = savedEventScrollTop;
    updateScrollState();
  }
}

eventDetail.addEventListener(
  "click",
  event => {
    if (event.target === eventDetail) {
      closeEventDetail();
    }
  }
);

function openAboutDialog(event) {
  event?.preventDefault();

  closeDatePopover();

  if (!eventDetail.hidden) {
    closeEventDetail();
  }

  if (!aboutDialog.open) {
    aboutDialog.showModal();
  }
}

function closeAboutDialog() {
  if (aboutDialog.open) {
    aboutDialog.close();
  }
}

aboutLink.addEventListener(
  "click",
  openAboutDialog
);

aboutCloseButton.addEventListener(
  "click",
  closeAboutDialog
);

aboutDialog.addEventListener(
  "click",
  event => {
    const bounds =
      aboutDialog.getBoundingClientRect();

    const clickedOutside =
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom;

    if (clickedOutside) {
      closeAboutDialog();
    }
  }
);

function openMeltDialog(event) {
  event?.preventDefault();

  closeDatePopover();

  if (!eventDetail.hidden) {
    closeEventDetail();
  }

  if (!meltDialog.open) {
    meltDialog.showModal();
  }
}

function closeMeltDialog() {
  if (meltDialog.open) {
    meltDialog.close();
  }
}

meltLink.addEventListener(
  "click",
  openMeltDialog
);

meltCloseButton.addEventListener(
  "click",
  closeMeltDialog
);

meltDialog.addEventListener(
  "click",
  event => {
    const bounds =
      meltDialog.getBoundingClientRect();

    const clickedOutside =
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom;

    if (clickedOutside) {
      closeMeltDialog();
    }
  }
);

function movePoster(direction) {
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

eventStack.addEventListener("scroll", () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    updateScrollState();
  });
}, { passive: true });

eventStack.addEventListener("wheel", releaseArrowPageSpace, { passive: true });
eventStack.addEventListener("touchmove", releaseArrowPageSpace, { passive: true });
eventStack.addEventListener("keydown", event => {
  if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", " "].includes(event.key)) {
    releaseArrowPageSpace();
  }
});

poster.addEventListener("wheel", event => {
  if (!eventDetail.hidden || !datePopover.hidden ||
      eventStack.contains(event.target) || !pageCards.length) return;
  if (Math.abs(event.deltaY) < 1) return;
  event.preventDefault();
  releaseArrowPageSpace();
  eventStack.scrollBy({ top: event.deltaY, behavior: "auto" });
}, { passive: false });

window.addEventListener(
  "keydown",
  event => {
    if (event.key === "Escape") {
      if (
        aboutDialog.open ||
        meltDialog.open
      ) {
        return;
      }

      if (!eventDetail.hidden) {
        closeEventDetail();
      } else {
        closeDatePopover();
      }

      return;
    }

    if (!eventDetail.hidden) {
      return;
    }

    if (event.key === "ArrowLeft") {
      movePoster(-1);
    }

    if (event.key === "ArrowRight") {
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

    touchStartX =
      event.changedTouches[0].clientX;
  },
  { passive: true }
);

poster.addEventListener(
  "touchend",
  event => {
    if (
      touchStartX === null ||
      !eventDetail.hidden
    ) {
      touchStartX = null;
      return;
    }

    const delta =
      event.changedTouches[0].clientX -
      touchStartX;

    if (Math.abs(delta) > 50) {
      movePoster(
        delta < 0 ? 1 : -1
      );
    }

    touchStartX = null;
  },
  { passive: true }
);

dateButton.addEventListener(
  "click",
  () => {
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
  arrowFocusDateKey = null;
  posterPages =
    buildPosterPages(events);

  if (!posterPages.length) {
    pageCards = [];
    dateSections = [];
    cornerTransitions = [];
    previousPoster.disabled = true;
    nextPoster.disabled = true;

    showEventFeedMessage(
      "No upcoming listings right now."
    );

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

  renderPoster();
}

async function initialize() {
  const cachedEvents =
    readCachedPublicEvents();

  if (cachedEvents) {
    renderEventCollection(
      cachedEvents
    );
  } else {
    showEventFeedMessage(
      "Loading listings…"
    );
  }

  try {
    const freshEvents =
      await loadPublicEvents();

    writeCachedPublicEvents(
      freshEvents
    );

    const listingsChanged =
      !cachedEvents ||
      JSON.stringify(
        freshEvents
      ) !==
      JSON.stringify(
        cachedEvents
      );

    if (listingsChanged) {
      renderEventCollection(
        freshEvents
      );
    }
  } catch (error) {
    console.error(error);

    if (!cachedEvents) {
      showEventFeedMessage(
        "Listings could not load. Please refresh."
      );
    }
  }
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

initialize().finally(() => {
  if (
    typeof window
      .initializeComprehensiveLayoutEditor ===
    "function"
  ) {
    window
      .initializeComprehensiveLayoutEditor();
  }
});
