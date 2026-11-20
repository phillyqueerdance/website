// First-party anonymous counters. No cookies, visitor identifiers, fingerprints,
// IP addresses, raw URLs or search terms are sent to the collection endpoint.
(() => {
  "use strict";
  const ENDPOINT = "/api/analytics";
  const EXCLUDE_KEY = "qdp-analytics-exclude";
  const ACTIVITY_KEY = "qdp-analytics-last-activity";
  const PROFILE_KINDS = new Set(["artist", "venue", "party", "collective"]);
  const devices = /iPad|Tablet/i.test(navigator.userAgent) ? "tablet" : /Mobi|Android/i.test(navigator.userAgent) ? "mobile" : "desktop";
  const pending = new Map(), seenImpressions = new Set();
  let enabled = false, stopped = false, sending = false, timer = 0;
  let lastView = "", viewKind = "", lastActivity = 0, recorded = 0;

  function excluded() {
    try { if (localStorage.getItem(EXCLUDE_KEY) === "1") return true; } catch {}
    return navigator.globalPrivacyControl === true || navigator.doNotTrack === "1" ||
      location.pathname.startsWith("/admin") ||
      !["queerdancephilly.com", "www.queerdancephilly.com"].includes(location.hostname) ||
      new URLSearchParams(location.search).get("edit") === "layout";
  }

  function referral() {
    const campaign = new URLSearchParams(location.search).get("utm_source")?.toLowerCase();
    const sources = { instagram: "instagram.com", ig: "instagram.com", facebook: "facebook.com",
      newsletter: "newsletter", email: "email", ra: "ra.co", tiktok: "tiktok.com" };
    if (Object.hasOwn(sources, campaign || "")) return sources[campaign];
    try {
      const host = new URL(document.referrer).hostname.toLowerCase().replace(/^www\./, "");
      if (host !== location.hostname.replace(/^www\./, "") && host.length <= 80 && /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(host)) return host;
    } catch {}
    return "direct-unknown";
  }

  function queue(metric, data = {}) {
    if (stopped || excluded() || recorded >= 2500) return;
    const item = { metric, kind: data.kind || "", id: String(data.id || ""),
      label: String(data.label || "").slice(0, 140), source: data.source || viewKind || "direct",
      device: metric === "visit" ? devices : "", n: 1 };
    const key = [item.metric, item.kind, item.id, item.source, item.device].join("|");
    const previous = pending.get(key);
    if (previous) previous.n = Math.min(50, previous.n + 1);
    else if (pending.size < 120) pending.set(key, item);
    recorded++;
    schedule();
  }

  function activity() {
    const now = Date.now();
    if (!lastActivity) {
      try { lastActivity = Number(sessionStorage.getItem(ACTIVITY_KEY)) || 0; } catch {}
    }
    if (!lastActivity || now - lastActivity > 30 * 60 * 1000) queue("visit", { source: referral() });
    lastActivity = now;
    try { sessionStorage.setItem(ACTIVITY_KEY, String(now)); } catch {}
  }

  function track(metric, data = {}) {
    try { if (stopped || excluded()) return; activity(); queue(metric, data); } catch { /* Tracking never interrupts the page. */ }
  }

  function event(metric, item, data = {}) {
    track(metric, { kind: "event", id: item?.eventId ?? item?.EventID,
      label: window.QDPEventMetadata?.cleanTitle(item) || item?.title || "", ...data });
  }

  function view(kind, id = "", label = "") {
    try {
      if (stopped || excluded()) return;
      const key = `${kind}:${id}`;
      if (key === lastView) return;
      const source = viewKind || "direct";
      activity();
      queue("page_view", { kind, source });
      if (kind === "event" && id) queue("event_open", { kind, id, label, source });
      else if (PROFILE_KINDS.has(kind) && id) queue("profile_view", { kind, id, label, source });
      lastView = key;
      viewKind = kind;
    } catch {}
  }

  function schedule() {
    if (enabled && !timer && !sending && pending.size) timer = setTimeout(() => { timer = 0; void flush(); }, 12000);
  }

  async function flush(beacon = false) {
    if (!enabled || sending || stopped || excluded() || !pending.size) return;
    const items = [...pending.values()].slice(0, 24);
    for (const item of items) pending.delete([item.metric, item.kind, item.id, item.source, item.device].join("|"));
    const body = JSON.stringify({ v: 1, items });
    if (beacon && navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: "application/json" }))) return;
    sending = true;
    try {
      const response = await fetch(ENDPOINT, { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body, keepalive: true });
      if (!response.ok) { stopped = true; pending.clear(); }
    } catch { pending.clear(); } // No retries or unbounded offline backlog.
    finally { sending = false; schedule(); }
  }

  function observeImpressions() {
    if (!window.IntersectionObserver || !window.MutationObserver) return;
    const visible = new Map(), dwell = new Map(), observed = new Set();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        visible.set(entry.target, entry.isIntersecting && entry.intersectionRatio >= 0.5);
        check(entry.target);
      }
    }, { threshold: 0.5 });
    function check(card) {
      const id = card.dataset.eventId;
      const source = viewKind || "calendar";
      const key = `${id}:${source}`;
      const unobscured = visible.get(card) && document.visibilityState !== "hidden" &&
        !card.closest("[hidden], [inert], [aria-hidden='true']") && card.isConnected;
      if (!unobscured) { clearTimeout(dwell.get(card)); dwell.delete(card); return; }
      if (!id || seenImpressions.has(key) || dwell.has(card)) return;
      dwell.set(card, setTimeout(() => {
        dwell.delete(card);
        if (!visible.get(card) || document.visibilityState === "hidden" ||
            card.closest("[hidden], [inert], [aria-hidden='true']") || !card.isConnected) return;
        seenImpressions.add(key);
        track("event_impression", { kind: "event", id, source,
          label: card.querySelector(".event-title")?.textContent || "" });
      }, 800));
    }
    function scan() {
      for (const card of observed) {
        if (!card.isConnected) {
          observer.unobserve(card); observed.delete(card); visible.delete(card);
          clearTimeout(dwell.get(card)); dwell.delete(card);
        } else check(card);
      }
      document.querySelectorAll(".event-card[data-event-id]").forEach(card => {
        if (!observed.has(card)) { observed.add(card); observer.observe(card); }
      });
    }
    let scanTimer = 0;
    const changes = new MutationObserver(() => {
      if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = 0; scan(); }, 200);
    });
    const poster = document.getElementById("poster");
    if (poster) changes.observe(poster, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "inert"] });
    document.addEventListener("visibilitychange", scan);
    scan();
  }

  // A capture handler also covers links rendered on the server, new-tab clicks,
  // and profile links without changing their existing navigation behavior.
  document.addEventListener("click", click => {
    const link = click.target.closest?.("a[href]");
    if (!link) return;
    let url;
    try { url = new URL(link.href, location.origin); } catch { return; }
    if (url.origin === location.origin || !["https:", "http:"].includes(url.protocol)) return;
    const params = new URLSearchParams(location.search);
    const eventId = params.get("event");
    const kind = eventId ? "event" : params.get("archive");
    const id = eventId || params.get("id");
    if (!id || (!PROFILE_KINDS.has(kind) && kind !== "event")) return;
    const metric = url.hostname === "calendar.google.com" ? "calendar_click" :
      /(^|\.)google\.[a-z.]+$/.test(url.hostname) && url.pathname.startsWith("/maps") ? "directions_click" : "external_click";
    const label = kind === "event" ? document.getElementById("eventDetailTitle")?.textContent :
      document.querySelector(".archive-header-label")?.textContent;
    track(metric, { kind, id, label, source: viewKind || "direct" });
  }, true);

  window.QDPAnalytics = Object.freeze({ track, event, view });
  if (excluded()) return;
  activity();
  fetch(ENDPOINT, { credentials: "same-origin", cache: "no-store" }).then(response => response.ok ? response.json() : null)
    .then(config => {
      enabled = Boolean(config?.enabled);
      if (enabled) { observeImpressions(); schedule(); }
      else { stopped = true; pending.clear(); }
    }).catch(() => { stopped = true; pending.clear(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush(true);
  });
  window.addEventListener("pagehide", () => { void flush(true); });
})();
