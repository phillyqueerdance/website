// The export has optional structured time columns. Older reports describe some
// explicit time changes in prose; only prefill the unambiguous forms below.
const CLOCK = "(\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM)|midnight|noon)";
const MOVED = "(?:move|shift|change|update|correct)\\s+(?:the\\s+)?";
const RANGE = new RegExp(MOVED + "(?:event|hours|time(?:s)?)\\s+from\\s+[^.;]+?\\s+to\\s+"
  + CLOCK + "\\s*(?:[–—-]|to)\\s*" + CLOCK + "\\b", "i");
const TIME_ONLY = Object.fromEntries(["start", "end"].map(which => [which,
  new RegExp(MOVED + which + "(?:\\s+time)?\\s+(?:from\\s+[^.;]+?\\s+)?to\\s+" + CLOCK + "\\b", "i")
]));

function clock(value) {
  const raw = value.trim().toLowerCase();
  if (raw === "midnight") return "00:00";
  if (raw === "noon") return "12:00";
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(raw);
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (hour < 1 || hour > 12 || minute > 59) return "";
  return String(hour % 12 + (match[3] === "pm" ? 12 : 0)).padStart(2, "0")
    + ":" + String(minute).padStart(2, "0");
}

function followingDate(value) {
  const date = new Date(value + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + 1);
  return Number.isFinite(+date) ? date.toISOString().slice(0, 10) : "";
}

function dateAgreesWithNote(note, match, date) {
  const after = note.slice(match.index + match[0].length);
  if (!/^\s+on\b/i.test(after)) return true;
  const written = /^\s+on\s+([a-z]{3,9})\.?\s+(\d{1,2})(?:,\s*(\d{4}))?\b/i.exec(after);
  const day = new Date(date + "T12:00:00Z");
  if (!written || !Number.isFinite(+day)) return false;
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(day).toLowerCase();
  return month.startsWith(written[1].toLowerCase()) && day.getUTCDate() === Number(written[2])
    && (!written[3] || day.getUTCFullYear() === Number(written[3]));
}

export function suggestedCorrectionTimes(row, current) {
  const result = {};
  const date = row.Date;
  const note = row.Correction || "";
  const range = date && RANGE.exec(note);
  if (range) {
    const start = clock(range[1]);
    const end = clock(range[2]);
    if (start && end && start !== end && dateAgreesWithNote(note, range, date)) {
      result.start = date + "T" + start;
      const endDate = /end(?:ing|s)?\s+(?:on\s+)?the\s+next\s+(?:day|date)/i.test(note) || end < start
        ? followingDate(date) : date;
      if (endDate) result.end = endDate + "T" + end;
    }
  } else {
    for (const which of ["start", "end"]) {
      const match = TIME_ONLY[which].exec(note);
      const suggested = match ? clock(match[1]) : "";
      const currentDate = which === "start" ? date : current.end.slice(0, 10);
      if (suggested && currentDate && dateAgreesWithNote(note, match, currentDate)) {
        result[which] = currentDate + "T" + suggested;
      }
    }
  }

  for (const which of ["Start", "End"]) {
    const time = row["Suggested " + which + "Time"];
    const structuredDate = row["Suggested " + which + "Date"];
    if (!time && !structuredDate) continue;
    const key = which.toLowerCase();
    const existing = current[key];
    const day = structuredDate || existing.slice(0, 10) || (key === "start" ? date : "");
    const hour = time || existing.slice(11);
    if (day && hour) result[key] = day + "T" + hour;
  }
  return result;
}
