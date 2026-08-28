const EVENTS_API_URL =
  "https://script.google.com/macros/s/AKfycbxvCynlGyqJZqP-l6pG_vf2hFAwc-5sSHL9qftqrb5SCclR_8zeKRCHarKEe6XrPjKd/exec?resource=events";


const MAX_EVENTS_PER_POSTER = 6;


const dateNumber =
  document.getElementById("dateNumber");

const dateDay =
  document.getElementById("dateDay");

const eventStack =
  document.getElementById("eventStack");

const eventDetail =
  document.getElementById("eventDetail");

const dateButton =
  document.getElementById("dateButton");

const datePicker =
  document.getElementById("datePicker");

const previousPoster =
  document.getElementById("previousPoster");

const nextPoster =
  document.getElementById("nextPoster");

const poster =
  document.getElementById("poster");


let posterPages = [];
let currentPosterIndex = 0;


previousPoster.disabled = true;
nextPoster.disabled = true;


/* -----------------------------------------
   DATE HELPERS
----------------------------------------- */

function dateKey(date) {

  const formatter =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    );

  return formatter.format(date);
}


function stripIdentityEmojis(title) {

  return title
    .replace(/🏳️‍🌈/g, "")
    .replace(/🏳️‍⚧️/g, "")
    .replace(/✊🏾/g, "")
    .trim();
}


/* -----------------------------------------
   SORT
----------------------------------------- */

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
        {
          sensitivity: "base"
        }
      );
  });
}


/* -----------------------------------------
   EVENLY SPLIT BUSY DAYS
----------------------------------------- */

function splitIntoPosterPages(events) {

  if (events.length <= MAX_EVENTS_PER_POSTER) {
    return [events];
  }

  const numberOfPages =
    Math.ceil(
      events.length /
      MAX_EVENTS_PER_POSTER
    );

  const baseSize =
    Math.floor(
      events.length /
      numberOfPages
    );

  const remainder =
    events.length %
    numberOfPages;

  const pages = [];

  let index = 0;

  for (
    let page = 0;
    page < numberOfPages;
    page++
  ) {

    const size =
      baseSize +
      (page < remainder ? 1 : 0);

    pages.push(
      events.slice(
        index,
        index + size
      )
    );

    index += size;
  }

  return pages;
}


/* -----------------------------------------
   BUILD CONTINUOUS POSTER SEQUENCE
----------------------------------------- */

function buildPosterPages(events) {

  const grouped = new Map();

  sortEvents(events).forEach(event => {

    const key =
      dateKey(new Date(event.start));

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key).push(event);
  });


  const keys =
    [...grouped.keys()].sort();


  const pages = [];


  keys.forEach(key => {

    const dailyEvents =
      sortEvents(grouped.get(key));

    const dailyPages =
      splitIntoPosterPages(dailyEvents);


    dailyPages.forEach(pageEvents => {

      pages.push({
        date: key,
        events: pageEvents
      });

    });

  });


  return pages;
}


/* -----------------------------------------
   TIME FORMATTING
----------------------------------------- */

function formatTimeRange(event) {

  const start = new Date(event.start);

  const end =
    event.end
      ? new Date(event.end)
      : null;


  const formatter =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "America/New_York",

        hour:
          "numeric",

        minute:
          "2-digit"
      }
    );


  let startText =
    formatter.format(start);

  let endText =
    end
      ? formatter.format(end)
      : "";


  startText =
    startText
      .replace(":00", "")
      .replace(" ", "");

  endText =
    endText
      .replace(":00", "")
      .replace(" ", "");


  if (!endText) {
    return startText;
  }


  const startMeridiem =
    startText.match(/[AP]M$/)?.[0];

  const endMeridiem =
    endText.match(/[AP]M$/)?.[0];


  if (
    startMeridiem &&
    startMeridiem === endMeridiem
  ) {

    startText =
      startText.replace(
        /[AP]M$/,
        ""
      );

  }


  return `${startText}–${endText}`;
}


function formatStartTime(event) {

  const formatter =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "America/New_York",

        hour:
          "numeric",

        minute:
          "2-digit"
      }
    );


  return formatter
    .format(new Date(event.start))
    .replace(":00", "")
    .replace(" ", "")
    .toLowerCase();
}


function groupEventsByStartTime(events) {

  const groups = new Map();

  events.forEach(event => {

    const key =
      new Date(event.start).getTime();


    if (!groups.has(key)) {
      groups.set(key, []);
    }


    groups.get(key).push(event);
  });


  return [...groups.values()];
}


/* -----------------------------------------
   LOAD PUBLIC EVENT FEED
----------------------------------------- */

async function loadPublicEvents() {

  const response =
    await fetch(
      EVENTS_API_URL,
      {
        cache: "no-store"
      }
    );


  if (!response.ok) {
    throw new Error(
      `Event feed returned ${response.status}.`
    );
  }


  const payload =
    await response.json();


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


  const notice =
    document.createElement("p");

  notice.className =
    "event-feed-message";

  notice.textContent =
    message;


  eventStack.appendChild(notice);
}


/* -----------------------------------------
   RENDER POSTER
----------------------------------------- */

function renderPoster() {

  if (!posterPages.length) {
    return;
  }


  const page =
    posterPages[currentPosterIndex];


  eventDetail.hidden = true;
  eventStack.hidden = false;


  const posterDate =
    new Date(
      `${page.date}T12:00:00-04:00`
    );


  dateNumber.textContent =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "America/New_York",

        month:
          "numeric",

        day:
          "numeric"
      }
    ).format(posterDate);


  dateDay.textContent =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "America/New_York",

        weekday:
          "short"
      }
    ).format(posterDate);


  const today =
    dateKey(new Date());


  if (page.date === today) {
    dateButton.textContent =
      "Today";
  } else {

    dateButton.textContent =
      new Intl.DateTimeFormat(
        "en-US",
        {
          month:
            "short",

          day:
            "numeric",

          timeZone:
            "America/New_York"
        }
      )
      .format(posterDate)
      .toUpperCase();

  }


  eventStack.innerHTML = "";


  groupEventsByStartTime(page.events)
    .forEach(eventsAtThisTime => {

      const group =
        document.createElement("div");

      group.className =
        "event-time-group";


      const time =
        document.createElement("div");

      time.className =
        "event-time";

      time.textContent =
        formatStartTime(eventsAtThisTime[0]);


      const cards =
        document.createElement("div");

      cards.className =
        "event-group-cards";


      eventsAtThisTime.forEach(event => {

        const card =
          document.createElement("button");

        card.type = "button";

        card.className =
          `event-card ${
            event.explicitQueer
              ? "explicit"
              : "default"
          }`;


        const title =
          document.createElement("div");

        title.className =
          "event-title";

        title.textContent =
          event.title;


        const meta =
          document.createElement("div");

        meta.className =
          "event-meta";

        meta.textContent =
          `${event.venue}, ${event.address}`;


        card.append(
          title,
          meta
        );


        card.addEventListener(
          "click",
          () =>
            openEventDetail(event)
        );


        cards.appendChild(card);
      });


      group.append(
        time,
        cards
      );


      eventStack.appendChild(group);
    });


  previousPoster.disabled =
    currentPosterIndex === 0;

  nextPoster.disabled =
    currentPosterIndex ===
    posterPages.length - 1;
}


/* -----------------------------------------
   EVENT DETAILS
----------------------------------------- */

function openEventDetail(event) {

  eventStack.hidden = true;
  eventDetail.hidden = false;


  eventDetail.innerHTML = "";


  const back =
    document.createElement("button");

  back.type = "button";
  back.textContent = "← Back";


  back.addEventListener(
    "click",
    renderPoster
  );


  const heading =
    document.createElement("h2");

  heading.textContent =
    event.title;


  const time =
    document.createElement("p");

  time.textContent =
    formatTimeRange(event);


  const location =
    document.createElement("p");

  location.textContent =
    `${event.venue}, ${event.address}`;


  const description =
    document.createElement("p");

  description.textContent =
    event.description || "";


  eventDetail.append(
    back,
    heading,
    time,
    location,
    description
  );
}


/* -----------------------------------------
   POSTER NAVIGATION
----------------------------------------- */

function movePoster(direction) {

  const nextIndex =
    currentPosterIndex +
    direction;


  if (
    nextIndex < 0 ||
    nextIndex >=
      posterPages.length
  ) {
    return;
  }


  currentPosterIndex =
    nextIndex;

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


/* -----------------------------------------
   KEYBOARD
----------------------------------------- */

window.addEventListener(
  "keydown",
  event => {

    if (event.key === "ArrowLeft") {
      movePoster(-1);
    }

    if (event.key === "ArrowRight") {
      movePoster(1);
    }

  }
);


/* -----------------------------------------
   SWIPE
----------------------------------------- */

let touchStartX = null;


poster.addEventListener(
  "touchstart",
  event => {

    touchStartX =
      event.changedTouches[0]
        .clientX;

  },
  {
    passive: true
  }
);


poster.addEventListener(
  "touchend",
  event => {

    if (touchStartX === null) {
      return;
    }


    const endX =
      event.changedTouches[0]
        .clientX;


    const delta =
      endX - touchStartX;


    if (Math.abs(delta) > 50) {

      if (delta < 0) {
        movePoster(1);
      } else {
        movePoster(-1);
      }

    }


    touchStartX = null;

  },
  {
    passive: true
  }
);


/* -----------------------------------------
   DATE PICKER
----------------------------------------- */

dateButton.addEventListener(
  "click",
  () => {

    if (!posterPages.length) {
      return;
    }

    const currentDate =
      posterPages[currentPosterIndex]
        .date;


    datePicker.value =
      currentDate;


    if (
      typeof datePicker.showPicker ===
      "function"
    ) {

      datePicker.showPicker();

    } else {

      datePicker.hidden = false;
      datePicker.focus();

    }

  }
);


datePicker.addEventListener(
  "change",
  () => {

    const wantedDate =
      datePicker.value;


    const index =
      posterPages.findIndex(
        page =>
          page.date ===
          wantedDate
      );


    if (index !== -1) {

      currentPosterIndex =
        index;

      renderPoster();

    }


    datePicker.hidden = true;
  }
);


/* -----------------------------------------
   INITIALIZE
----------------------------------------- */

async function initialize() {

  showEventFeedMessage(
    "Loading listings…"
  );


  try {
    const events =
      await loadPublicEvents();

    posterPages =
      buildPosterPages(events);


    if (!posterPages.length) {
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
