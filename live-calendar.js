// One Philadelphia calendar cutoff for the public feed, initial HTML, and browser.
(() => {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  });
  const cutoffs = new Map();
  const parts = time => Object.fromEntries(local.formatToParts(new Date(time))
    .filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));

  function dayKey(now = Date.now()) {
    const p = parts(now);
    return new Date(Date.UTC(p.year, p.month - 1, p.day - (p.hour < 6 ? 1 : 0)))
      .toISOString().slice(0, 10);
  }

  function expiresAt(event) {
    const start = Date.parse(event?.start);
    if (!Number.isFinite(start)) return NaN;
    const p = parts(start);
    const key = `${p.year}-${p.month}-${p.day}`;
    if (!cutoffs.has(key)) {
      const wallTime = Date.UTC(p.year, p.month - 1, p.day + 1, 6);
      let time = wallTime;
      // Resolve local 6 a.m. across daylight-saving changes without a fixed offset.
      for (let i = 0; i < 3; i++) {
        const q = parts(time);
        time += wallTime - Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second);
      }
      cutoffs.set(key, time);
    }
    const end = Date.parse(event.end);
    return Math.max(cutoffs.get(key), Number.isFinite(end) && end >= start ? end : start);
  }

  function isVisible(event, now = Date.now()) {
    return now < expiresAt(event);
  }

  function nextExpiry(events) {
    let next = Infinity;
    for (const event of events) {
      const end = expiresAt(event);
      if (Number.isFinite(end)) next = Math.min(next, end);
    }
    return next;
  }

  globalThis.QDPLiveCalendar = Object.freeze({ dayKey, expiresAt, isVisible, nextExpiry });
})();
