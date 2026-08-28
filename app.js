const EVENTS_API_URL =
  "https://script.google.com/macros/s/AKfycbxvCynlGyqJZqP-l6pG_vf2hFAwc-5sSHL9qftqrb5SCclR_8zeKRCHarKEe6XrPjKd/exec?resource=events";

const MAX_EVENTS_PER_POSTER = 6;

const dateNumber = document.getElementById("dateNumber");
const dateDay = document.getElementById("dateDay");
const eventStack = document.getElementById("eventStack");
const eventDetail = document.getElementById("eventDetail");
const dateButton = document.getElementById("dateButton");
const datePopover = document.getElementById("datePopover");
const previousPoster = document.getElementById("previousPoster");
const nextPoster = document.getElementById("nextPoster");
const poster = document.getElementById("poster");
const siteHeader = document.querySelector(".site-header");

let posterPages = [];
let currentPosterIndex = 0;
let pickerMonth = null;
let touchStartX = null;

previousPoster.disabled = true;
nextPoster.disabled = true;

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

function eventVenue(event) {
  return String(event.venue || "").trim();
}

function eventAddress(event) {
  return String(event.address || "").trim();
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

  const remainder = events.length % numberOfPages;
  const pages = [];
  let index = 0;

  for (let page = 0; page < numberOfPages; page++) {
    const size =
      baseSize + (page < remainder ? 1 : 0);

    pages.push(events.slice(index, index + size));
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
  let startText = compactTime(new Date(event.start));
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
    startText = startText.replace(/[AP]M$/, "");
  }

  return `${startText}–${endText}`;
}

function formatStartTime(event) {
  return compactTime(new Date(event.start));
}

async function loadPublicEvents() {
  const response = await fetch(
    EVENTS_API_URL,
    { cache: "no-store" }
  );

  if (!response.ok) {
    throw new Error(
      `Event feed returned ${response.status}.`
    );
  }

  const payload = await response.json();

  if (payload.error) {
    throw new Error(payload.error);
  }

  if (!Array.isArray(payload.events)) {
    throw new Error(
      "The event feed returned an invalid response."
    );
  }

  return payload.events;
}

function showEventFeedMessage(message) {
  eventStack.hidden = false;
  eventStack.innerHTML = "";

  const notice = document.createElement("p");
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
}

function closeDatePopover() {
  datePopover.hidden = true;
}

function renderDatePopover() {
  datePopover.innerHTML = "";

  const pickerHeader = document.createElement("div");
  pickerHeader.className = "date-popover-header";

  const previousMonth = document.createElement("button");
  previousMonth.type = "button";
  previousMonth.className = "date-popover-month-button";
  previousMonth.textContent = "←";
  previousMonth.setAttribute(
    "aria-label",
    "Previous month"
  );

  previousMonth.addEventListener("click", () => {
    pickerMonth = new Date(
      pickerMonth.getFullYear(),
      pickerMonth.getMonth() - 1,
      1,
      12
    );

    renderDatePopover();
  });

  const monthLabel = document.createElement("div");
  monthLabel.className = "date-popover-month-label";
  monthLabel.textContent =
    new Intl.DateTimeFormat(
      "en-US",
      {
        month: "long",
        year: "numeric"
      }
    ).format(pickerMonth);

  const nextMonth = document.createElement("button");
  nextMonth.type = "button";
  nextMonth.className = "date-popover-month-button";
  nextMonth.textContent = "→";
  nextMonth.setAttribute(
    "aria-label",
    "Next month"
  );

  nextMonth.addEventListener("click", () => {
    pickerMonth = new Date(
      pickerMonth.getFullYear(),
      pickerMonth.getMonth() + 1,
      1,
      12
    );

    renderDatePopover();
  });

  pickerHeader.append(
    previousMonth,
    monthLabel,
    nextMonth
  );

  const weekdayRow = document.createElement("div");
  weekdayRow.className = "date-popover-weekdays";

  ["S", "M", "T", "W", "T", "F", "S"]
    .forEach(day => {
      const weekday = document.createElement("div");
      weekday.textContent = day;
      weekdayRow.appendChild(weekday);
    });

  const dayGrid = document.createElement("div");
  dayGrid.className = "date-popover-days";

  const year = pickerMonth.getFullYear();
  const month = pickerMonth.getMonth();
  const firstWeekday =
    new Date(year, month, 1).getDay();
  const daysInMonth =
    new Date(year, month + 1, 0).getDate();
  const available = availableDateKeys();
  const selected = posterPages[currentPosterIndex].date;

  for (let blank = 0; blank < firstWeekday; blank++) {
    dayGrid.appendChild(document.createElement("div"));
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day, 12);
    const key = dateKey(date);
    const hasEvents = available.has(key);

    const dayButton = document.createElement("button");
    dayButton.type = "button";
    dayButton.className = "date-popover-day";
    dayButton.textContent = day;
    dayButton.disabled = !hasEvents;

    if (key === selected) {
      dayButton.classList.add("selected");
    }

    if (hasEvents) {
      dayButton.addEventListener("click", () => {
        currentPosterIndex = posterPages.findIndex(
          page => page.date === key
        );

        closeDatePopover();
        renderPoster();
      });
    }

    dayGrid.appendChild(dayButton);
  }

  datePopover.append(
    pickerHeader,
    weekdayRow,
    dayGrid
  );
}

function renderPoster() {
  if (!posterPages.length) {
    return;
  }

  const page = posterPages[currentPosterIndex];
  const posterDate = dateFromKey(page.date);

  eventDetail.hidden = true;
  eventDetail.classList.remove("is-open");
  eventStack.hidden = false;

  dateNumber.textContent =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: "America/New_York",
        month: "numeric",
        day: "numeric"
      }
    ).format(posterDate);

  dateDay.textContent =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: "America/New_York",
        weekday: "short"
      }
    ).format(posterDate);

  if (page.date === dateKey(new Date())) {
    dateButton.textContent = "Today";
  } else {
    dateButton.textContent =
      new Intl.DateTimeFormat(
        "en-US",
        {
          month: "short",
          day: "numeric",
          timeZone: "America/New_York"
        }
      )
        .format(posterDate)
        .toUpperCase();
  }

  eventStack.innerHTML = "";

  groupEventsByStartTime(page.events)
    .forEach(eventsAtThisTime => {
      const group = document.createElement("div");
      group.className = "event-time-group";

      const time = document.createElement("div");
      time.className = "event-time";
      time.textContent =
        formatStartTime(eventsAtThisTime[0]);

      const cards = document.createElement("div");
      cards.className = "event-group-cards";

      eventsAtThisTime.forEach(event => {
        const card = document.createElement("button");
        card.type = "button";
        card.className =
          `event-card ${event.explicitQueer
            ? "explicit"
            : "default"}`;

        const title = document.createElement("div");
        title.className = "event-title";
        title.textContent = event.title;

        const venue = document.createElement("div");
        venue.className = "event-venue";
        venue.textContent = eventVenue(event);
        venue.hidden = !venue.textContent;

        const address = document.createElement("div");
        address.className = "event-address";
        address.textContent = eventAddress(event);
        address.hidden = !address.textContent;

        card.append(title, venue, address);
        card.addEventListener(
          "click",
          () => openEventDetail(event)
        );

        cards.appendChild(card);
      });

      group.append(time, cards);
      eventStack.appendChild(group);
    });

  previousPoster.disabled =
    currentPosterIndex === 0;

  nextPoster.disabled =
    currentPosterIndex === posterPages.length - 1;
}

function openEventDetail(event) {
  closeDatePopover();
  eventStack.hidden = true;
  eventDetail.hidden = false;
  eventDetail.classList.add("is-open");
  eventDetail.innerHTML = "";

  const detailCard = document.createElement("article");
  detailCard.className = "event-detail-card";

  const heading = document.createElement("h2");
  heading.textContent = event.title;

  const time = document.createElement("p");
  time.textContent = formatTimeRange(event);

  const venue = document.createElement("p");
  venue.textContent = eventVenue(event);
  venue.hidden = !venue.textContent;

  const address = document.createElement("p");
  address.textContent = eventAddress(event);
  address.hidden = !address.textContent;

  const description = document.createElement("p");
  description.textContent = event.description || "";

  detailCard.append(
    heading,
    time,
    venue,
    address,
    description
  );

  eventDetail.appendChild(detailCard);
}

function closeEventDetail() {
  if (eventDetail.classList.contains("is-open")) {
    renderPoster();
  }
}

eventDetail.addEventListener("click", event => {
  if (event.target === eventDetail) {
    closeEventDetail();
  }
});

function movePoster(direction) {
  const nextIndex = currentPosterIndex + direction;

  if (
    nextIndex < 0 ||
    nextIndex >= posterPages.length
  ) {
    return;
  }

  closeDatePopover();
  currentPosterIndex = nextIndex;
  renderPoster();
}

previousPoster.addEventListener(
  "click",
  () => movePoster(-1)
);

nextPoster.addEventListener(
  "click",
  () => movePoster(1)
);

window.addEventListener("keydown", event => {
  if (event.key === "Escape") {
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
});

poster.addEventListener(
  "touchstart",
  event => {
    touchStartX = event.changedTouches[0].clientX;
  },
  { passive: true }
);

poster.addEventListener(
  "touchend",
  event => {
    if (touchStartX === null || !eventDetail.hidden) {
      touchStartX = null;
      return;
    }

    const delta =
      event.changedTouches[0].clientX - touchStartX;

    if (Math.abs(delta) > 50) {
      movePoster(delta < 0 ? 1 : -1);
    }

    touchStartX = null;
  },
  { passive: true }
);

dateButton.addEventListener("click", () => {
  if (datePopover.hidden) {
    openDatePopover();
  } else {
    closeDatePopover();
  }
});

document.addEventListener("click", event => {
  if (
    !datePopover.hidden &&
    !siteHeader.contains(event.target)
  ) {
    closeDatePopover();
  }
});

async function initialize() {
  showEventFeedMessage("Loading listings…");

  try {
    const events = await loadPublicEvents();
    posterPages = buildPosterPages(events);

    if (!posterPages.length) {
      showEventFeedMessage(
        "No upcoming listings right now."
      );

      return;
    }

    const today = dateKey(new Date());
    const todayIndex = posterPages.findIndex(
      page => page.date >= today
    );

    currentPosterIndex =
      todayIndex >= 0
        ? todayIndex
        : 0;

    renderPoster();
  } catch (error) {
    console.error(error);

    showEventFeedMessage(
      "Listings could not load. Please refresh."
    );
  }
}

initialize();
