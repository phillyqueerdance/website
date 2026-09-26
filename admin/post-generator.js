(() => {
  "use strict";

  const WIDTH = 1727;
  const HEIGHT = 2048;
  const Q = WIDTH / 100;
  const MAX_EVENTS = 6; // The public calendar's MAX_EVENTS_PER_POSTER.
  const FIRST_DATE_TOP = HEIGHT * 0.2215;
  const DATE_HEIGHT = 5 * Q;
  const CARD_HEIGHT = 10.8 * Q;
  const SAME_TIME_GAP = .85 * Q;
  const NEXT_TIME_GAP = 2.15 * Q;
  const NEXT_DATE_GAP = 3.3 * Q;
  const CONTENT_BOTTOM = HEIGHT * (1 - .112);
  const TIME_X = WIDTH * .098;
  const TIME_WIDTH = 10.9 * Q;
  const CARD_X = TIME_X + TIME_WIDTH + Q;
  const CARD_WIDTH = 68.8 * Q;
  const DATE_X = WIDTH * .4283;
  const DATE_WIDTH = WIDTH * .4342;
  const LOCAL_TIME = "America/New_York";

  const form = document.getElementById("postForm");
  const startInput = document.getElementById("postStart");
  const endInput = document.getElementById("postEnd");
  const button = document.getElementById("generatePost");
  const status = document.getElementById("postStatus");
  const gallery = document.getElementById("postGallery");
  const imageUrls = [];

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: LOCAL_TIME, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  startInput.value = endInput.value = today;

  const theme = getComputedStyle(document.documentElement);
  const color = name => theme.getPropertyValue(name).trim();
  const COLORS = {
    queerPopup: color("--qdp-queer-popup") || "#290925",
    regularPopup: color("--qdp-regular-popup") || "#202125",
    queerCard: color("--qdp-queer-card") || "#922185",
    standardCard: "#ff7945",
    red: "#fa2b5a",
    text: "#ffeff2"
  };

  const dateForKey = key => new Date(`${key}T12:00:00Z`);
  const format = (date, options) => new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", ...options
  }).format(date);
  const suffix = day => (day % 100 >= 11 && day % 100 <= 13)
    ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[day % 10] || "th");
  const dayPart = key => {
    const day = Number(key.slice(-2));
    return `${format(dateForKey(key), { month: "long" })} ${day}${suffix(day)}`;
  };
  const weekday = key => format(dateForKey(key), { weekday: "long" });
  const posterDate = key => `${weekday(key)}, ${dayPart(key)}`;
  const dateKey = value => new Intl.DateTimeFormat("en-CA", {
    timeZone: LOCAL_TIME, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(value));
  const nextDay = key => new Date(dateForKey(key).getTime() + 86400000)
    .toISOString().slice(0, 10);
  const stripFlags = value => String(value || "")
    .replace(/^(?:(?:🏳️‍🌈|🏳️‍⚧️|✊🏾)\s*)+/gu, "").trim();

  function titleLines(first, last) {
    const dates = [];
    for (let key = first; key <= last; key = nextDay(key)) dates.push(key);
    const sameMonth = first.slice(0, 7) === last.slice(0, 7);
    const lastDay = Number(last.slice(-2));
    const dateLine = first === last ? dayPart(first) :
      `${dayPart(first)} - ${sameMonth ?
        `${lastDay}${suffix(lastDay)}` : dayPart(last)}`;
    const dayLine = dates.length === 1 ? weekday(first) :
      dates.length === 2 ? `${weekday(first)} & ${weekday(last)}` :
      `${weekday(first)} - ${weekday(last)}`;
    return [dateLine, `(${dayLine})`];
  }

  function timeText(event) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: LOCAL_TIME, hour: "numeric", minute: "2-digit"
    }).format(new Date(event.start)).replace(":00", "").replace(" ", "");
  }

  function splitEvents(events) {
    const count = Math.ceil(events.length / MAX_EVENTS);
    const base = Math.floor(events.length / count);
    const remainder = events.length % count;
    let index = 0;
    return Array.from({ length: count }, (_, page) => {
      const size = base + (page < remainder ? 1 : 0);
      const result = events.slice(index, index + size);
      index += size;
      return result;
    });
  }

  function timeGroups(events) {
    const groups = [];
    for (const event of events) {
      const stamp = new Date(event.start).getTime();
      if (groups.at(-1)?.stamp === stamp) groups.at(-1).events.push(event);
      else groups.push({ stamp, events: [event] });
    }
    return groups;
  }

  function pageHeight(days) {
    let height = 0;
    days.forEach((day, index) => {
      if (index) height += NEXT_DATE_GAP;
      height += DATE_HEIGHT;
      const groups = timeGroups(day.events);
      groups.forEach((group, groupIndex) => {
        if (groupIndex) height += NEXT_TIME_GAP;
        height += group.events.length * CARD_HEIGHT +
          (group.events.length - 1) * SAME_TIME_GAP;
      });
    });
    return height;
  }

  function calendarPages(events) {
    const dates = new Map();
    events.forEach(event => {
      const key = dateKey(event.start);
      if (!dates.has(key)) dates.set(key, []);
      dates.get(key).push(event);
    });
    const pages = [];
    let current = [];
    let currentCount = 0;
    const flush = () => {
      if (current.length) pages.push(current);
      current = [];
      currentCount = 0;
    };
    [...dates.keys()].sort().forEach(key => {
      const dayEvents = dates.get(key);
      if (dayEvents.length > MAX_EVENTS) {
        flush();
        splitEvents(dayEvents).forEach(slice => pages.push([{ key, events: slice }]));
        return;
      }
      const day = { key, events: dayEvents };
      const contiguous = !current.length ||
        nextDay(current.at(-1).key) === key;
      if (!contiguous || currentCount + dayEvents.length > MAX_EVENTS ||
          pageHeight([...current, day]) > CONTENT_BOTTOM - FIRST_DATE_TOP) {
        flush();
      }
      current.push(day);
      currentCount += dayEvents.length;
    });
    flush();
    return pages;
  }

  function canvas(width = WIDTH, height = HEIGHT) {
    const element = document.createElement("canvas");
    element.width = width;
    element.height = height;
    return [element, element.getContext("2d", { alpha: false })];
  }

  function image(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not load ${url}.`));
      img.src = url;
    });
  }

  function roundedPath(ctx, x, y, width, height, radii) {
    const [tl, tr, br, bl] = radii.map(radius =>
      Math.max(0, Math.min(radius, width / 2, height / 2)));
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + width - tr, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + tr);
    ctx.lineTo(x + width, y + height - br);
    ctx.quadraticCurveTo(x + width, y + height, x + width - br, y + height);
    ctx.lineTo(x + bl, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - bl);
    ctx.lineTo(x, y + tl);
    ctx.quadraticCurveTo(x, y, x + tl, y);
    ctx.closePath();
  }

  function fitText(ctx, text, maxWidth, startSize, minSize, weight, family) {
    let size = startSize;
    do {
      ctx.font = `${weight} ${size}px ${family}`;
      if (ctx.measureText(text).width <= maxWidth || size <= minSize) break;
      size -= 1;
    } while (true);
    return size;
  }

  function ellipsis(ctx, text, width) {
    if (ctx.measureText(text).width <= width) return text;
    let value = text;
    while (value && ctx.measureText(value + "…").width > width) value = value.slice(0, -1);
    return value + "…";
  }

  function wrapped(ctx, text, width, maxLines) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > width) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      const kept = lines.slice(0, maxLines);
      kept[maxLines - 1] = ellipsis(ctx,
        lines.slice(maxLines - 1).join(" "), width);
      return kept;
    }
    return lines.map(value => ellipsis(ctx, value, width));
  }

  function titleSlide(logo, first, last) {
    const [out, ctx] = canvas(2048, 2048);
    ctx.drawImage(logo, 0, 0, 2048, 2048);
    const [dates, days] = titleLines(first, last);
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    fitText(ctx, dates, 810, 72, 38, "bold", "Georgia, serif");
    ctx.fillText(dates, 1024, 1552);
    fitText(ctx, days, 810, 66, 37, "bold", "Georgia, serif");
    ctx.fillText(days, 1024, 1657);
    return out;
  }

  function dateBox(ctx, key, top) {
    roundedPath(ctx, DATE_X, top, DATE_WIDTH, DATE_HEIGHT + 2,
      [5 * Q, 5 * Q, 0, 0]);
    ctx.fillStyle = COLORS.red;
    ctx.fill();
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const text = posterDate(key);
    fitText(ctx, text, DATE_WIDTH - 2 * Q, 2.55 * Q, 1.8 * Q,
      "bold", "Georgia, serif");
    ctx.fillText(text, DATE_X + DATE_WIDTH / 2, top + DATE_HEIGHT / 2 - .25 * Q);
  }

  function stripes(ctx, x, y, width, height, colors) {
    colors.forEach((stripe, index) => {
      ctx.fillStyle = stripe;
      ctx.fillRect(x, y + height * index / colors.length,
        width, height / colors.length + .5);
    });
  }

  const RAINBOW = ["#e50000", "#ff8d00", "#ffef00", "#008121", "#004cff", "#760088"];
  const TRANS = ["#5bcefa", "#f5a9b8", "#ffffff", "#f5a9b8", "#5bcefa"];

  function eventCard(ctx, event, top, height, index, length) {
    const radius = 4.3 * Q;
    const corner = [0, index === 0 ? radius : 0,
      index === length - 1 ? radius : 0,
      length > 1 && index === length - 1 ? radius : 0];
    const base = event.explicitQueer ? COLORS.queerCard : COLORS.standardCard;
    const flagged = event.queerArtist || event.transArtist;
    ctx.save();
    roundedPath(ctx, CARD_X, top, CARD_WIDTH, height, corner);
    ctx.clip();
    ctx.fillStyle = base;
    ctx.fillRect(CARD_X, top, CARD_WIDTH, height);
    if (event.queerArtist) stripes(ctx, CARD_X + CARD_WIDTH - 8.6 * Q,
      top, 8.6 * Q, height / 2, RAINBOW);
    if (event.transArtist) stripes(ctx, CARD_X + CARD_WIDTH - 8.6 * Q,
      top + height / 2, 8.6 * Q, height / 2, TRANS);
    if (flagged) {
      ctx.fillStyle = base;
      ctx.beginPath();
      ctx.moveTo(CARD_X, top);
      ctx.lineTo(CARD_X + CARD_WIDTH - 8.6 * Q, top);
      ctx.lineTo(CARD_X + CARD_WIDTH - 4.3 * Q, top + height / 2);
      ctx.lineTo(CARD_X + CARD_WIDTH - 8.6 * Q, top + height);
      ctx.lineTo(CARD_X, top + height);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    const x = CARD_X + 2.2 * Q;
    const width = CARD_WIDTH - (flagged ? 7.7 : 4.4) * Q;
    const title = stripFlags(event.title);
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const titleSize = fitText(ctx, title, width, 3.3 * Q, 2.25 * Q,
      "bold", "Verdana, sans-serif");
    const titleFont = ctx.font;
    ctx.font = `${2.6 * Q}px Verdana, sans-serif`;
    const venueLines = wrapped(ctx, event.venue, width, 2);
    ctx.font = `${2.15 * Q}px Verdana, sans-serif`;
    const address = event.address ? ellipsis(ctx, event.address, width) : "";
    const lineGap = .25 * Q;
    const total = titleSize + venueLines.length * 2.6 * Q +
      (address ? 2.15 * Q : 0) +
      (venueLines.length + (address ? 1 : 0)) * lineGap;
    let baseline = top + (height - total) / 2;
    ctx.font = titleFont;
    ctx.fillText(ellipsis(ctx, title, width), x, baseline + titleSize / 2);
    baseline += titleSize + lineGap;
    ctx.font = `${2.6 * Q}px Verdana, sans-serif`;
    venueLines.forEach(line => {
      ctx.fillText(line, x, baseline + 1.3 * Q);
      baseline += 2.6 * Q;
    });
    if (address) {
      baseline += lineGap;
      ctx.font = `${2.15 * Q}px Verdana, sans-serif`;
      ctx.fillText(address, x, baseline + 1.075 * Q);
    }
  }

  function calendarSlide(frame, days) {
    const [out, ctx] = canvas();
    ctx.drawImage(frame, 0, 0, WIDTH, HEIGHT);
    const rawHeight = pageHeight(days);
    const scale = Math.min(1, (CONTENT_BOTTOM - FIRST_DATE_TOP) / rawHeight);
    let y = FIRST_DATE_TOP;
    days.forEach((day, dayIndex) => {
      if (dayIndex) y += NEXT_DATE_GAP * scale;
      dateBox(ctx, day.key, y);
      y += DATE_HEIGHT * scale;
      const groups = timeGroups(day.events);
      groups.forEach((group, groupIndex) => {
        if (groupIndex) y += NEXT_TIME_GAP * scale;
        const start = y;
        const cardHeight = CARD_HEIGHT * scale;
        roundedPath(ctx, TIME_X, start, TIME_WIDTH, cardHeight,
          [4.2 * Q, 0, 0, 4.2 * Q]);
        ctx.fillStyle = COLORS.red;
        ctx.fill();
        ctx.fillStyle = COLORS.text;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const time = timeText(group.events[0]);
        fitText(ctx, time, TIME_WIDTH - 1.2 * Q, 3.2 * Q, 2.5 * Q,
          "bold", "Georgia, serif");
        ctx.fillText(time, TIME_X + TIME_WIDTH / 2 + .25 * Q,
          start + cardHeight / 2 - .2 * Q);
        group.events.forEach((event, index) => {
          eventCard(ctx, event, y, cardHeight, index, group.events.length);
          y += cardHeight;
          if (index < group.events.length - 1) y += SAME_TIME_GAP * scale;
        });
      });
    });
    return out;
  }

  async function flyerImage(event) {
    if (!event.flyerUrl) return null;
    const response = await fetch(
      `/admin/flyer?url=${encodeURIComponent(event.flyerUrl)}`,
      { credentials: "same-origin", cache: "no-store" }
    );
    if (!response.ok) throw new Error(`Flyer unavailable (${response.status}).`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    try { return await image(url); }
    finally { URL.revokeObjectURL(url); }
  }

  function popupSlide(frame, event, flyer) {
    const [out, ctx] = canvas();
    ctx.drawImage(frame, 0, 0, WIDTH, HEIGHT);
    const x = WIDTH * .084, y = HEIGHT * .0679;
    const w = WIDTH * (1 - .084 - .0823);
    const h = HEIGHT * (1 - .0679 - .0672);
    const border = .75 * Q;
    roundedPath(ctx, x, y, w, h, [1.7 * Q, 1.7 * Q, 1.7 * Q, 1.7 * Q]);
    ctx.fillStyle = "#000";
    ctx.fill();
    const inner = { x: x + border, y: y + border,
      w: w - 2 * border, h: h - 2 * border };
    roundedPath(ctx, inner.x, inner.y, inner.w, inner.h,
      [1.25 * Q, 1.25 * Q, 1.25 * Q, 1.25 * Q]);
    ctx.fillStyle = event.explicitQueer ? COLORS.queerPopup : COLORS.regularPopup;
    ctx.fill();

    const flagSize = 9 * Q;
    if (event.queerArtist) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(inner.x, inner.y);
      ctx.lineTo(inner.x + flagSize, inner.y);
      ctx.lineTo(inner.x, inner.y + flagSize);
      ctx.clip();
      stripes(ctx, inner.x, inner.y, flagSize, flagSize, RAINBOW);
      ctx.restore();
    }
    if (event.transArtist) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(inner.x + inner.w - flagSize, inner.y);
      ctx.lineTo(inner.x + inner.w, inner.y);
      ctx.lineTo(inner.x + inner.w, inner.y + flagSize);
      ctx.clip();
      stripes(ctx, inner.x + inner.w - flagSize, inner.y,
        flagSize, flagSize, TRANS);
      ctx.restore();
    }

    const padding = 2.7 * Q;
    const textX = inner.x + padding;
    const textW = inner.w - 2 * padding;
    const title = stripFlags(event.title);
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    fitText(ctx, title, textW, 4 * Q, 2.6 * Q, "bold", "Verdana, sans-serif");
    const titleFont = ctx.font;
    const titleSize = parseFloat(titleFont.match(/[\d.]+px/)?.[0]) || 4 * Q;
    ctx.font = `${2.8 * Q}px Verdana, sans-serif`;
    const venue = wrapped(ctx, event.venue, textW, 2);
    const address = wrapped(ctx, event.address, textW, 2);
    const lineHeight = 3.2 * Q;
    const blockHeight = titleSize * 1.2 + (venue.length + address.length) * lineHeight + 1.6 * Q;
    const textTop = inner.y + inner.h - padding - blockHeight;
    ctx.font = titleFont;
    ctx.fillText(ellipsis(ctx, title, textW), textX, textTop);
    ctx.font = `${2.8 * Q}px Verdana, sans-serif`;
    let lineY = textTop + titleSize * 1.2 + .5 * Q;
    [...venue, ...address].forEach(line => {
      ctx.fillText(line, textX, lineY);
      lineY += lineHeight;
    });

    const slot = { x: inner.x + padding, y: inner.y + padding,
      w: inner.w - 2 * padding,
      h: textTop - inner.y - 2 * padding };
    if (flyer) {
      const scale = Math.min(slot.w / flyer.naturalWidth,
        slot.h / flyer.naturalHeight);
      const fw = flyer.naturalWidth * scale;
      const fh = flyer.naturalHeight * scale;
      ctx.drawImage(flyer, slot.x + (slot.w - fw) / 2,
        slot.y + (slot.h - fh) / 2, fw, fh);
    } else {
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `${2.5 * Q}px Verdana, sans-serif`;
      ctx.fillText(event.flyerUrl ? "Flyer unavailable" : "No flyer provided",
        slot.x + slot.w / 2, slot.y + slot.h / 2);
    }
    return out;
  }

  async function addImage(canvasElement, caption, filename) {
    const blob = await new Promise((resolve, reject) =>
      canvasElement.toBlob(value => value ? resolve(value) : reject(
        new Error("Image export failed.")), "image/png"));
    const url = URL.createObjectURL(blob);
    imageUrls.push(url);
    const figure = document.createElement("figure");
    figure.className = "post-image";
    const label = document.createElement("figcaption");
    const name = document.createElement("span");
    name.textContent = caption;
    const link = document.createElement("a");
    link.className = "post-download";
    link.textContent = "Download PNG";
    link.href = url;
    link.download = filename;
    label.append(name, link);
    const img = document.createElement("img");
    img.src = url;
    img.alt = caption;
    img.loading = "lazy";
    img.decoding = "async";
    figure.append(label, img);
    gallery.appendChild(figure);
    canvasElement.width = 0;
    canvasElement.height = 0;
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const first = startInput.value, last = endInput.value;
    if (!first || !last || first > last) {
      status.textContent = "Choose an inclusive date range, with the first date before the last.";
      return;
    }
    button.disabled = true;
    status.textContent = "Loading published events…";
    gallery.replaceChildren();
    imageUrls.splice(0).forEach(url => URL.revokeObjectURL(url));
    try {
      const response = await fetch("/admin/post-data", {
        credentials: "same-origin", cache: "no-store"
      });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.events)) {
        throw new Error(data.error || "Could not load the event feed.");
      }
      const selected = data.events.filter(item => {
        if (!item.title || !item.start || /^\(DELETED ENTRY\)/i.test(item.title)) return false;
        const key = dateKey(item.start);
        return key >= first && key <= last;
      }).sort((a, b) => new Date(a.start) - new Date(b.start) ||
        stripFlags(a.title).localeCompare(stripFlags(b.title), undefined,
          { sensitivity: "base" }));
      const pages = calendarPages(selected);
      const [logo, frame] = await Promise.all([
        image("../newlogoqdp.png?v=20260926-01"),
        image("../frame.png?v=20260926-01")
      ]);
      const prefix = `qdp-${first}-${last}`;
      await addImage(titleSlide(logo, first, last), "Title slide", `${prefix}-title.png`);
      for (let index = 0; index < pages.length; index++) {
        const days = pages[index];
        status.textContent = `Drawing calendar ${index + 1} of ${pages.length}…`;
        const dates = days.length === 1 ? dayPart(days[0].key) :
          `${dayPart(days[0].key)} - ${dayPart(days.at(-1).key)}`;
        await addImage(calendarSlide(frame, days),
          `Calendar ${index + 1}: ${dates}`,
          `${prefix}-calendar-${String(index + 1).padStart(2, "0")}.png`);
      }
      let missingFlyers = 0;
      for (let index = 0; index < selected.length; index++) {
        const item = selected[index];
        status.textContent = `Drawing event ${index + 1} of ${selected.length}…`;
        let flyer = null;
        try { flyer = await flyerImage(item); }
        catch (error) { console.warn(error); }
        if (!flyer) missingFlyers++;
        await addImage(popupSlide(frame, item, flyer),
          `${stripFlags(item.title)} · ${posterDate(dateKey(item.start))}`,
          `${prefix}-event-${String(index + 1).padStart(2, "0")}.png`);
      }
      status.textContent = `${1 + pages.length + selected.length} PNG images ready.` +
        (missingFlyers ? ` ${missingFlyers} flyer${missingFlyers === 1 ? "" : "s"} could not be loaded; those images show a placeholder.` : "");
    } catch (error) {
      status.textContent = `Generation stopped: ${error.message}`;
    } finally { button.disabled = false; }
  });

  window.addEventListener("pagehide", () =>
    imageUrls.forEach(url => URL.revokeObjectURL(url)));
})();
