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
const layoutEditorEnabled =
  new URLSearchParams(window.location.search)
    .get("edit") === "layout";
const layoutTargets = {
  date: document.querySelector('[data-layout-target="date"]'),
  list: document.querySelector('[data-layout-target="list"]')
};

const LAYOUT_STORAGE_KEY = "qdp-poster-layout-v2";

const LAYOUT_DEFAULTS = {
  desktop: {
    dateFontSize: 3.75,
    timeFontSize: 3.2,
    timeCardGap: 0.65,
    cardWidth: 76,
    showMeridiem: true,
    date: { x: 0.24, y: -0.37 },
    list: { x: 0, y: -4.18 }
  },
  mobile: {
    dateFontSize: 3.7,
    timeFontSize: 3.2,
    timeCardGap: 0.65,
    cardWidth: 78,
    showMeridiem: true,
    date: { x: 0, y: 0 },
    list: { x: 0, y: 0 }
  }
};

let posterPages = [];
let currentPosterIndex = 0;
let pickerMonth = null;
let touchStartX = null;
let activeLayoutDrag = null;

previousPoster.disabled = true;
nextPoster.disabled = true;

function layoutBreakpoint() {
  return window.matchMedia("(max-width: 600px)").matches
    ? "mobile"
    : "desktop";
}

function readLayoutOverrides() {
  try {
    return JSON.parse(
      window.localStorage.getItem(LAYOUT_STORAGE_KEY)
    ) || {};
  } catch {
    return {};
  }
}

function writeLayoutOverrides(overrides) {
  window.localStorage.setItem(
    LAYOUT_STORAGE_KEY,
    JSON.stringify(overrides)
  );
}

function layoutValues(breakpoint) {
  const overrides = readLayoutOverrides();
  const saved = overrides[breakpoint] || {};

  return {
    ...LAYOUT_DEFAULTS[breakpoint],
    ...saved,
    date:
      saved.date ||
      LAYOUT_DEFAULTS[breakpoint].date ||
      { x: 0, y: 0 },
    list:
      saved.list ||
      LAYOUT_DEFAULTS[breakpoint].list ||
      { x: 0, y: 0 }
  };
}

function applyLayoutOverrides() {
  const values = layoutValues(layoutBreakpoint());

  ["date", "list"].forEach(name => {
    const target = layoutTargets[name];
    const position = values[name] || { x: 0, y: 0 };

    target.style.setProperty(
      `--layout-${name}-x`,
      `${position.x || 0}cqw`
    );

    target.style.setProperty(
      `--layout-${name}-y`,
      `${position.y || 0}cqw`
    );
  });

  layoutTargets.date.style.setProperty(
    "--layout-date-font-size",
    `${values.dateFontSize}cqw`
  );

  layoutTargets.list.style.setProperty(
    "--layout-time-font-size",
    `${values.timeFontSize}cqw`
  );

  layoutTargets.list.style.setProperty(
    "--layout-time-card-gap",
    `${values.timeCardGap}cqw`
  );
  
  layoutTargets.list.style.setProperty(
    "--layout-card-width",
    `${values.cardWidth}cqw`
  );
  
  layoutTargets.list.style.setProperty(
    "--layout-time-meridiem-display",
    values.showMeridiem ? "inline" : "none"
  );
}

function layoutCss() {
  const format = value => Number(value || 0).toFixed(2);

  const block = breakpoint => {
    const values = layoutValues(breakpoint);
    const date = values.date;
    const list = values.list;

    return [
      `.poster-date { --layout-date-x: ${format(date.x)}cqw; --layout-date-y: ${format(date.y)}cqw; --layout-date-font-size: ${format(values.dateFontSize)}cqw; }`,
            `.event-stack { --layout-list-x: ${format(list.x)}cqw; --layout-list-y: ${format(list.y)}cqw; --layout-time-font-size: ${format(values.timeFontSize)}cqw; --layout-time-card-gap: ${format(values.timeCardGap)}cqw; --layout-card-width: ${format(values.cardWidth)}cqw; --layout-time-meridiem-display: ${values.showMeridiem ? "inline" : "none"}; }`
    ].join("\n");
  };

  return [
    "/* QDP poster layout overrides */",
    "/* Desktop */",
    block("desktop"),
    "",
    "@media (max-width: 600px) {",
    `  ${block("mobile").replace(/\n/g, "\n  ")}`,
    "}"
  ].join("\n");
}

function setLayoutOutput(output) {
  output.value = layoutCss();
}

function moveLayoutTarget(name, deltaX, deltaY) {
  const overrides = readLayoutOverrides();
  const breakpoint = layoutBreakpoint();
  const values = overrides[breakpoint] || {};
  const current = values[name] || { x: 0, y: 0 };

  values[name] = {
    x: Math.round((current.x + deltaX) * 100) / 100,
    y: Math.round((current.y + deltaY) * 100) / 100
  };

  overrides[breakpoint] = values;

  writeLayoutOverrides(overrides);
  applyLayoutOverrides();
}

function updateLayoutSetting(name, value) {
  const overrides = readLayoutOverrides();
  const breakpoint = layoutBreakpoint();
  const values = overrides[breakpoint] || {};

  values[name] = value;
  overrides[breakpoint] = values;

  writeLayoutOverrides(overrides);
  applyLayoutOverrides();
}

function makeLayoutDraggable(target, name, output) {
  target.addEventListener("pointerdown", event => {
    if (!layoutEditorEnabled || event.button > 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    activeLayoutDrag = {
      name,
      startX: event.clientX,
      startY: event.clientY,
      posterWidth: poster.getBoundingClientRect().width
    };

    target.classList.add("is-dragging");
    target.setPointerCapture(event.pointerId);
  });

  target.addEventListener("pointermove", event => {
    if (!activeLayoutDrag || activeLayoutDrag.name !== name) {
      return;
    }

    const scale = 100 / activeLayoutDrag.posterWidth;
    const deltaX =
      (event.clientX - activeLayoutDrag.startX) * scale;
    const deltaY =
      (event.clientY - activeLayoutDrag.startY) * scale;

    moveLayoutTarget(name, deltaX, deltaY);

    activeLayoutDrag.startX = event.clientX;
    activeLayoutDrag.startY = event.clientY;

    setLayoutOutput(output);
  });

  const stopDragging = () => {
    activeLayoutDrag = null;
    target.classList.remove("is-dragging");
  };

  target.addEventListener("pointerup", stopDragging);
  target.addEventListener("pointercancel", stopDragging);
}

function initializeLayoutEditor() {
  if (!layoutEditorEnabled) {
    return;
  }

  document.body.classList.add("layout-editor-active");
  applyLayoutOverrides();

  const values = layoutValues(layoutBreakpoint());

  const panel = document.createElement("aside");
  panel.className = "layout-editor-panel";
  panel.innerHTML = `
    <p class="layout-editor-title">Layout editor: ${layoutBreakpoint()}</p>
    <div class="layout-editor-actions">
      <button type="button" data-layout-action="copy">Copy CSS</button>
      <button type="button" data-layout-action="reset">Reset this view</button>
      <button type="button" data-layout-action="done">Done</button>
    </div>
    <div class="layout-editor-controls">
      <label class="layout-editor-control">
        <span>Upper-left date size</span>
        <output data-layout-output="dateFontSize">${values.dateFontSize.toFixed(2)}cqw</output>
        <input type="range" min="2.8" max="5" step="0.05" value="${values.dateFontSize}" data-layout-setting="dateFontSize">
      </label>
      <label class="layout-editor-control">
        <span>Time size</span>
        <output data-layout-output="timeFontSize">${values.timeFontSize.toFixed(2)}cqw</output>
        <input type="range" min="2.5" max="4.5" step="0.05" value="${values.timeFontSize}" data-layout-setting="timeFontSize">
      </label>
           <label class="layout-editor-control">
        <span>Time-to-cards gap</span>
        <output data-layout-output="timeCardGap">${values.timeCardGap.toFixed(2)}cqw</output>
        <input type="range" min="0" max="2" step="0.05" value="${values.timeCardGap}" data-layout-setting="timeCardGap">
      </label>
      <label class="layout-editor-control">
        <span>Card width</span>
        <output data-layout-output="cardWidth">${values.cardWidth.toFixed(2)}cqw</output>
        <input type="range" min="55" max="82" step="0.25" value="${values.cardWidth}" data-layout-setting="cardWidth">
      </label>
      <label class="layout-editor-toggle">
        <input type="checkbox" data-layout-setting="showMeridiem" ${values.showMeridiem ? "checked" : ""}>
        Show AM/PM
      </label>
    </div>
    <textarea class="layout-editor-output" readonly aria-label="Layout CSS"></textarea>
  `;

  document.body.appendChild(panel);

  const output = panel.querySelector(".layout-editor-output");

  function refreshLayoutEditorControls() {
    const currentValues = layoutValues(layoutBreakpoint());

    [
      "dateFontSize",
      "timeFontSize",
      "timeCardGap"
      "cardWidth"
    ].forEach(setting => {
      const input = panel.querySelector(
        `[data-layout-setting="${setting}"]`
      );

      const settingOutput = panel.querySelector(
        `[data-layout-output="${setting}"]`
      );

      input.value = currentValues[setting];

      settingOutput.textContent =
        `${Number(currentValues[setting]).toFixed(2)}cqw`;
    });

    panel.querySelector(
      '[data-layout-setting="showMeridiem"]'
    ).checked = currentValues.showMeridiem;

    panel.querySelector(".layout-editor-title").textContent =
      `Layout editor: ${layoutBreakpoint()}`;

    setLayoutOutput(output);
  }

  refreshLayoutEditorControls();

  makeLayoutDraggable(layoutTargets.date, "date", output);
  makeLayoutDraggable(layoutTargets.list, "list", output);

  panel.addEventListener("input", event => {
    const setting = event.target.dataset.layoutSetting;

    if (!setting || event.target.type !== "range") {
      return;
    }

    const value = Number(event.target.value);

    updateLayoutSetting(setting, value);

    panel.querySelector(
      `[data-layout-output="${setting}"]`
    ).textContent = `${value.toFixed(2)}cqw`;

    setLayoutOutput(output);
  });

  panel.addEventListener("change", event => {
    if (event.target.dataset.layoutSetting !== "showMeridiem") {
      return;
    }

    updateLayoutSetting(
      "showMeridiem",
      event.target.checked
    );

    setLayoutOutput(output);
  });

  panel.addEventListener("click", async event => {
    const action = event.target.dataset.layoutAction;

    if (action === "copy") {
      output.select();

      try {
        await navigator.clipboard.writeText(output.value);
      } catch {
        document.execCommand("copy");
      }

      event.target.textContent = "Copied";

      window.setTimeout(() => {
        event.target.textContent = "Copy CSS";
      }, 1200);
    }

    if (action === "reset") {
      const overrides = readLayoutOverrides();

      delete overrides[layoutBreakpoint()];

      writeLayoutOverrides(overrides);
      applyLayoutOverrides();
      refreshLayoutEditorControls();
    }

    if (action === "done") {
      window.history.replaceState(
        {},
        document.title,
        window.location.pathname
      );

      window.location.reload();
    }
  });

  window.addEventListener("resize", () => {
    applyLayoutOverrides();
    refreshLayoutEditorControls();
  });
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

  if (String(event.venueId || "").trim()) {
    return { venue, address };
  }

  return {
    venue,
    address: ""
  };
}

function eventVenue(event) {
  return eventLocationParts(event).venue;
}

function eventAddress(event) {
  return eventLocationParts(event).address;
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

function appendStartTime(time, event) {
  const formatted = formatStartTime(event);
  const meridiem = formatted.match(/[AP]M$/)?.[0] || "";
  const number = formatted.replace(/[AP]M$/, "");

  const numberElement = document.createElement("span");
  numberElement.textContent = number;

  const meridiemElement = document.createElement("span");
  meridiemElement.className = "event-time-meridiem";
  meridiemElement.textContent = meridiem;

  time.append(numberElement, meridiemElement);
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
      appendStartTime(time, eventsAtThisTime[0]);

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
    if (layoutEditorEnabled) {
      return;
    }

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

initialize().finally(initializeLayoutEditor);
