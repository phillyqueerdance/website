const sampleEvents = [

  /* -------- AUG 27 -------- */

  {
    title: "🏳️‍🌈 After Dark",
    start: "2026-08-27T20:00:00-04:00",
    end: "2026-08-27T23:00:00-04:00",
    venue: "Example Venue",
    address: "123 Example St.",
    explicitQueer: true,
    description: "Example event description."
  },

  {
    title: "Night Shift",
    start: "2026-08-27T22:00:00-04:00",
    end: "2026-08-28T02:00:00-04:00",
    venue: "Another Venue",
    address: "456 Example Ave.",
    explicitQueer: false,
    description: "Another example description."
  },


  /* -------- AUG 28 — SEVEN (SPLITS 4 + 3) -------- */

  ...Array.from({ length: 7 }, (_, i) => ({
    title: `Friday Event ${i + 1}`,
    start:
      `2026-08-28T${String(16 + i).padStart(2, "0")}:00:00-04:00`,
    end:
      `2026-08-28T${String(17 + i).padStart(2, "0")}:00:00-04:00`,
    venue: "Friday Venue",
    address: `${100 + i} Example St.`,
    explicitQueer: i === 2 || i === 5,
    description: `Description for Friday Event ${i + 1}.`
  })),


  /* -------- AUG 29 — TEN -------- */

  {
    title: "🏳️‍🌈 History on the Street: Back to School Edit",
    start: "2026-08-29T12:00:00-04:00",
    end: "2026-08-29T16:00:00-04:00",
    venue: "13th & Locust",
    address: "13th & Locust St.",
    explicitQueer: false,
    description: "Example description for History on the Street."
  },

  {
    title: "HnB Sides",
    start: "2026-08-29T15:00:00-04:00",
    end: "2026-08-29T19:00:00-04:00",
    venue: "Margoli's",
    address: "9 W Wildey St.",
    explicitQueer: false,
    description: "Example description."
  },

  {
    title: "Southern Comfort",
    start: "2026-08-29T17:00:00-04:00",
    end: "2026-08-29T23:00:00-04:00",
    venue: "Pentridge Station",
    address: "5110–5120 Pentridge St.",
    explicitQueer: false,
    description: "Example description."
  },

  {
    title: "Tease: A Black Queer Strip Club",
    start: "2026-08-29T20:00:00-04:00",
    end: "2026-08-30T00:00:00-04:00",
    venue: "Club 624",
    address: "624 S 6th St.",
    explicitQueer: true,
    description: "Example description."
  },

  {
    title: "A$$ & Waist",
    start: "2026-08-29T21:00:00-04:00",
    end: "2026-08-30T01:00:00-04:00",
    venue: "Val's Lesbian Bar",
    address: "605 S 3rd St.",
    explicitQueer: true,
    description: "Example description."
  },

  {
    title: "BBYVirgo Birthday Celebration",
    start: "2026-08-29T21:00:00-04:00",
    end: "2026-08-30T01:00:00-04:00",
    venue: "Concourse Dance Bar",
    address: "1635 Market St.",
    explicitQueer: false,
    description: "Example description."
  },

  {
    title: "Biome",
    start: "2026-08-29T21:00:00-04:00",
    end: "2026-08-30T01:00:00-04:00",
    venue: "Dolphin Tavern",
    address: "1539 S Broad St.",
    explicitQueer: false,
    description: "Example description."
  },

  {
    title: "🏳️‍⚧️ Club Dream",
    start: "2026-08-29T22:00:00-04:00",
    end: "2026-08-30T02:00:00-04:00",
    venue: "Example Club",
    address: "800 Example Ave.",
    explicitQueer: true,
    description: "Example description."
  },

  {
    title: "Late Night Test",
    start: "2026-08-29T23:00:00-04:00",
    end: "2026-08-30T02:00:00-04:00",
    venue: "Test Venue",
    address: "900 Example Ave.",
    explicitQueer: false,
    description: "Example description."
  },

  {
    title: "Midnight Test",
    start: "2026-08-29T23:30:00-04:00",
    end: "2026-08-30T02:00:00-04:00",
    venue: "Test Venue",
    address: "901 Example Ave.",
    explicitQueer: false,
    description: "Example description."
  }

];


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
          `at ${event.venue}`;


        const address =
          document.createElement("div");

        address.className =
          "event-address";

        address.textContent =
          event.address;


        card.append(
          title,
          meta,
          address
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

posterPages =
  buildPosterPages(
    sampleEvents
  );


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
