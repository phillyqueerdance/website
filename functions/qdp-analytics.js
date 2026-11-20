// Anonymous daily counters. A verified Free plan is an explicit deployment
// prerequisite. There are no third-party analytics calls or paid fallbacks.
export const DAILY_WRITE_BUDGET = 20000;
export const MAX_BATCH = 24;
export const MAX_BODY_BYTES = 18000;
export const validEntityId = value => /^[\p{L}\p{N}_-]{1,80}$/u.test(value);
export const METRICS = new Set([
  "visit", "page_view", "event_open", "event_impression", "calendar_click",
  "share_open", "link_copy", "directions_click", "external_click",
  "profile_view", "map_focus", "map_relationship", "filter_use", "search_use", "gallery_open"
]);
const KINDS = new Set(["", "event", "artist", "venue", "party", "collective",
  "calendar", "artists", "venues", "parties", "collectives", "scene-map", "past-events", "about", "melt"]);
const EVENT_METRICS = new Set(["event_open", "event_impression", "calendar_click", "share_open", "link_copy", "directions_click", "gallery_open"]);
const PROFILE_KINDS = new Set(["artist", "venue", "party", "collective"]);
const REFERRAL_NAMES = new Set(["direct-unknown", "newsletter", "email"]);
const phillyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
});

export function phillyDay(now = new Date()) {
  const parts = Object.fromEntries(phillyFormatter.formatToParts(now).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shiftDay(day, amount) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function validDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

export function dateRange(url, now = new Date()) {
  const today = phillyDay(now);
  const end = url.searchParams.get("to") || today;
  if (!validDay(end)) throw new Error("Choose valid dates through today.");
  const days = Number(url.searchParams.get("days") || 7);
  const start = url.searchParams.get("from") || (Number.isInteger(days) && days >= 1 && days <= 90 ? shiftDay(end, 1 - days) : "");
  if (!validDay(start) || !validDay(end) || start > end || end > today) {
    throw new Error("Choose valid dates through today.");
  }
  const length = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  if (length > 90) throw new Error("Choose up to 90 days at a time.");
  return { start, end, days: length, previousStart: shiftDay(start, -length), previousEnd: shiftDay(start, -1), today };
}

const cleanLabel = value => String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 140);

export function normalizeItems(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_BATCH) throw new Error("Invalid analytics batch.");
  const combined = new Map();
  for (const item of input) {
    if (!item || !METRICS.has(item.metric) || !KINDS.has(item.kind || "")) continue;
    const kind = item.kind || "";
    const id = String(item.id || "");
    if (id && !validEntityId(id)) continue;
    if (EVENT_METRICS.has(item.metric) && (kind !== "event" || !id)) continue;
    if (["profile_view", "map_focus"].includes(item.metric) && (!PROFILE_KINDS.has(kind) || !id)) continue;
    let source = String(item.source || "").toLowerCase().slice(0, 80);
    if (source && !/^[a-z0-9][a-z0-9.:-]{0,79}$/.test(source)) continue;
    if (item.metric === "visit") {
      if (kind || id) continue;
      if (!REFERRAL_NAMES.has(source) && !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(source)) source = "direct-unknown";
    } else if (source && !KINDS.has(source) && !["direct", "internal"].includes(source)) continue;
    const device = ["mobile", "tablet", "desktop"].includes(item.device) ? item.device : "";
    const n = Number(item.n ?? 1);
    if (!Number.isInteger(n) || n < 1 || n > 50) continue;
    const value = { metric: item.metric, kind, id, source, device,
      label: id && (kind === "event" || PROFILE_KINDS.has(kind)) ? cleanLabel(item.label) : "", n };
    const key = [value.metric, kind, id, source, device].join("|");
    const existing = combined.get(key);
    if (existing) existing.n = Math.min(50, existing.n + n);
    else combined.set(key, value);
  }
  return [...combined.values()];
}

export function configured(env) {
  return Boolean(env.QDP_ANALYTICS && env.QDP_ANALYTICS_FREE_PLAN === "confirmed");
}

export function json(payload, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(payload), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache,
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"
  } });
}

export async function smallJson(request) {
  if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) throw new Error("Request too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing request body.");
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("Request too large."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function collect(env, items, now = new Date()) {
  const db = env.QDP_ANALYTICS;
  const day = phillyDay(now), utcDay = now.toISOString().slice(0, 10);
  const batch = crypto.randomUUID();
  // Conservative write units include primary-key/index overhead and state
  // updates. This is an extra collection cap, not a Cloudflare billing meter.
  const units = items.length * 2 + 6;
  const statements = [db.prepare(`INSERT INTO qdp_analytics_budget (day, units, batch_id)
    SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM qdp_analytics_settings WHERE id = 1 AND enabled = 1)
    ON CONFLICT(day) DO UPDATE SET units = units + excluded.units, batch_id = excluded.batch_id
    WHERE units + excluded.units <= ? AND EXISTS (SELECT 1 FROM qdp_analytics_settings WHERE id = 1 AND enabled = 1)`)
    .bind(utcDay, units, batch, DAILY_WRITE_BUDGET)];
  for (const item of items) {
    statements.push(db.prepare(`INSERT INTO qdp_analytics_counts (day, metric, kind, entity_id, source, device, label, total)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM qdp_analytics_budget WHERE day = ? AND batch_id = ?)
      ON CONFLICT(day, metric, kind, entity_id, source, device) DO UPDATE SET
      total = total + excluded.total, label = CASE WHEN excluded.label <> '' THEN excluded.label ELSE label END`)
      .bind(day, item.metric, item.kind, item.id, item.source, item.device, item.label, item.n, utcDay, batch));
  }
  statements.push(db.prepare(`UPDATE qdp_analytics_settings SET started_at = COALESCE(started_at, ?), last_seen_at = ?
    WHERE id = 1 AND EXISTS (SELECT 1 FROM qdp_analytics_budget WHERE day = ? AND batch_id = ?)`)
    .bind(now.toISOString(), now.toISOString(), utcDay, batch));
  statements.push(db.prepare(`UPDATE qdp_analytics_budget SET limited = 1
    WHERE day = ? AND batch_id <> ? AND limited = 0 AND units + ? > ?
    AND EXISTS (SELECT 1 FROM qdp_analytics_settings WHERE id = 1 AND enabled = 1)`)
    .bind(utcDay, batch, units, DAILY_WRITE_BUDGET));
  // D1 batch is transactional. The batch_id guard makes the budget decision
  // and every counter update atomic even with simultaneous incoming requests.
  const result = await db.batch(statements);
  return Boolean(result[0]?.meta?.changes);
}

export async function readAnalytics(env, range, now = new Date()) {
  if (!configured(env)) return { configured: false, enabled: false,
    message: "Analytics setup is incomplete. Connect QDP_ANALYTICS and confirm the Workers Free plan.", range };
  const db = env.QDP_ANALYTICS;
  const { start, end, previousStart } = range;
  const current = sql => db.prepare(sql).bind(start, end);
  const statements = [
    db.prepare("SELECT * FROM qdp_analytics_settings WHERE id = 1"),
    db.prepare("SELECT day, units, limited FROM qdp_analytics_budget WHERE day BETWEEN ? AND ? ORDER BY day").bind(previousStart, shiftDay(end, 1)),
    db.prepare(`SELECT CASE WHEN day >= ? THEN 'current' ELSE 'previous' END AS period, metric, SUM(total) AS total
      FROM qdp_analytics_counts WHERE day BETWEEN ? AND ? GROUP BY period, metric`).bind(start, previousStart, end),
    current(`SELECT day, SUM(CASE WHEN metric = 'visit' THEN total ELSE 0 END) AS visits,
      SUM(CASE WHEN metric = 'event_open' THEN total ELSE 0 END) AS opens
      FROM qdp_analytics_counts WHERE day BETWEEN ? AND ? AND metric IN ('visit', 'event_open') GROUP BY day ORDER BY day`),
    current(`SELECT entity_id AS id, MAX(label) AS name,
      SUM(CASE WHEN metric = 'event_open' THEN total ELSE 0 END) AS opens,
      SUM(CASE WHEN metric = 'event_impression' THEN total ELSE 0 END) AS impressions,
      SUM(CASE WHEN metric = 'link_copy' THEN total ELSE 0 END) AS copies,
      SUM(CASE WHEN metric = 'share_open' THEN total ELSE 0 END) AS shares,
      SUM(CASE WHEN metric = 'calendar_click' THEN total ELSE 0 END) AS calendar,
      SUM(CASE WHEN metric = 'directions_click' THEN total ELSE 0 END) AS directions,
      SUM(CASE WHEN metric = 'external_click' THEN total ELSE 0 END) AS outbound
      FROM qdp_analytics_counts WHERE day BETWEEN ? AND ? AND kind = 'event' AND entity_id <> ''
      GROUP BY entity_id ORDER BY opens DESC, impressions DESC, id LIMIT 100`),
    current(`SELECT kind, entity_id AS id, MAX(label) AS name,
      SUM(CASE WHEN metric = 'profile_view' THEN total ELSE 0 END) AS views,
      SUM(CASE WHEN metric = 'map_focus' THEN total ELSE 0 END) AS focuses,
      SUM(CASE WHEN metric = 'external_click' THEN total ELSE 0 END) AS outbound
      FROM qdp_analytics_counts WHERE day BETWEEN ? AND ? AND kind IN ('artist', 'venue', 'party', 'collective') AND entity_id <> ''
      GROUP BY kind, entity_id ORDER BY views DESC, focuses DESC, id LIMIT 100`),
    current(`SELECT source AS name, SUM(total) AS total FROM qdp_analytics_counts
      WHERE day BETWEEN ? AND ? AND metric = 'visit' GROUP BY source ORDER BY total DESC LIMIT 15`),
    current(`SELECT device AS name, SUM(total) AS total FROM qdp_analytics_counts
      WHERE day BETWEEN ? AND ? AND metric = 'visit' GROUP BY device ORDER BY total DESC`),
    current(`SELECT kind AS name, SUM(total) AS total FROM qdp_analytics_counts
      WHERE day BETWEEN ? AND ? AND metric = 'page_view' GROUP BY kind ORDER BY total DESC`),
    current(`SELECT metric, source, SUM(total) AS total FROM qdp_analytics_counts
      WHERE day BETWEEN ? AND ? AND metric IN ('event_open', 'profile_view', 'filter_use', 'search_use', 'map_relationship', 'gallery_open')
      GROUP BY metric, source ORDER BY metric, total DESC`),
    db.prepare(`SELECT started_at, ended_at, reason FROM qdp_analytics_gaps
      WHERE started_at < ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at LIMIT 1000`)
      .bind(shiftDay(end, 2), previousStart)
  ];
  const results = await db.batch(statements);
  const rows = index => results[index]?.results || [];
  const settings = rows(0)[0];
  if (!settings) throw new Error("Analytics database needs its initial migration.");
  const totals = { current: {}, previous: {} };
  for (const row of rows(2)) totals[row.period][row.metric] = Number(row.total);
  const seriesByDay = new Map(rows(3).map(row => [row.day, row]));
  const startedDay = settings.started_at ? phillyDay(new Date(settings.started_at)) : "";
  const gaps = rows(10);
  const limitedDays = new Set(rows(1).filter(row => row.limited).flatMap(row => [
    phillyDay(new Date(`${row.day}T00:00:00Z`)), phillyDay(new Date(`${row.day}T23:59:59Z`))
  ]));
  const series = [];
  for (let day = start; day <= end; day = shiftDay(day, 1)) {
    const available = Boolean(startedDay && day >= startedDay);
    const partial = day === startedDay || limitedDays.has(day) || gaps.some(gap =>
      phillyDay(new Date(gap.started_at)) <= day && (!gap.ended_at || phillyDay(new Date(gap.ended_at)) >= day));
    series.push({ day, partial, visits: available ? Number(seriesByDay.get(day)?.visits || 0) : null,
      opens: available ? Number(seriesByDay.get(day)?.opens || 0) : null });
  }
  return { configured: true, enabled: Boolean(settings.enabled), generatedAt: now.toISOString(), range,
    startedAt: settings.started_at, lastSeenAt: settings.last_seen_at,
    comparisonAvailable: Boolean(startedDay && startedDay < previousStart &&
      !rows(1).some(row => row.limited) && !gaps.length), gaps,
    budget: { limit: DAILY_WRITE_BUDGET, days: rows(1) }, totals, series,
    events: rows(4), profiles: rows(5), sources: rows(6), devices: rows(7), usage: rows(8), interactions: rows(9) };
}

export async function readEventBreakdown(env, range, id) {
  if (!validEntityId(id)) throw new Error("Invalid event ID.");
  if (!configured(env)) return { configured: false, rows: [] };
  const result = await env.QDP_ANALYTICS.prepare(`SELECT metric, source, SUM(total) AS total
    FROM qdp_analytics_counts WHERE day BETWEEN ? AND ? AND kind = 'event' AND entity_id = ?
    GROUP BY metric, source ORDER BY metric, total DESC`).bind(range.start, range.end, id).all();
  return { configured: true, id, range, rows: result.results || [] };
}
