(() => {
  "use strict";
  const $ = Object.fromEntries(["State", "Refresh", "Connection", "Connect", "Setup", "ClientForm", "ClientId", "ClientSecret", "ClientSave",
    "Connected", "RangeForm", "Period", "CustomDates", "From", "To", "Export", "Coverage", "Report", "Totals", "Chart", "Daily", "Filter",
    "Queries", "Pages", "Devices", "Disconnect"].map(name => [name, document.getElementById(`search${name}`)]));
  const number = new Intl.NumberFormat("en-US"), percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
  let connection = null, report = null, busy = false, serial = 0;
  const node = (tag, text = "", className = "") => { const item = document.createElement(tag); item.textContent = text; if (className) item.className = className; return item; };
  const position = value => value === null ? "—" : Number(value).toFixed(1);
  const display = (metric, value) => metric === "ctr" ? percent.format(value) : metric === "position" ? position(value) : number.format(value);
  function state(message, error = false) { $.State.textContent = message; $.State.classList.toggle("analytics-error", error); }
  function setBusy(value) {
    busy = value;
    $.Connect.disabled = value || !connection?.clientConfigured || !connection?.configured;
    $.ClientSave.disabled = value || !connection?.configured;
    $.Disconnect.disabled = $.Refresh.disabled = value;
    $.Export.disabled = value || !report;
  }
  async function request(params = {}, body) {
    const url = new URL("/admin/search-console", location.origin);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 35000);
    try {
      const response = await fetch(url, { credentials: "same-origin", signal: controller.signal,
        ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
      if (response.redirected) throw new Error("Sign in to QDP Admin again, then refresh Google Search.");
      const result = await response.json().catch(() => null);
      if (!response.ok || !result) {
        const error = new Error(result?.error || "Google Search could not load."); error.code = result?.code; throw error;
      }
      return result;
    } finally { clearTimeout(timer); }
  }
  function params() { return $.Period.value === "custom" ? { from: $.From.value, to: $.To.value } : { days: $.Period.value }; }
  function renderConnection() {
    $.Connection.hidden = Boolean(connection?.connected);
    $.Connected.hidden = $.Refresh.hidden = !connection?.connected;
    $.Setup.open = !connection?.clientConfigured;
    if (!connection?.configured) state(connection?.message || "Google Search needs server setup.");
    else if (!connection.connected) state(connection.clientConfigured ? "Google app saved. Connect Google Search to authorize read-only reporting." : "Google Search is not connected. Complete the one-time setup below.");
  }
  async function load(refresh = false) {
    const current = ++serial;
    setBusy(true); state("Loading Google Search…");
    try {
      const result = await request({ ...params(), ...(refresh ? { refresh: "1" } : {}) });
      if (current !== serial) return;
      connection = result; renderConnection();
      if (result.report) { report = result.report; render(); }
      else { report = null; $.Report.hidden = true; }
    } catch (error) {
      if (current !== serial) return;
      state(error.name === "AbortError" ? "Google Search took too long to load. Try again later." : error.message, true);
      if (error.code === "reconnect" || error.code === "disconnected") {
        connection = { ...connection, connected: false }; $.Connection.hidden = false; $.Connected.hidden = true;
      }
    } finally { if (current === serial) setBusy(false); }
  }
  function cards() {
    $.Totals.replaceChildren();
    for (const [metric, title] of [["clicks", "Google clicks"], ["impressions", "Google impressions"], ["ctr", "Click-through rate"], ["position", "Average position"]]) {
      const card = node("div", "", "analytics-total"), dl = node("dl");
      dl.append(node("dt", title), node("dd", report.hasData ? display(metric, report.totals[metric]) : "—"));
      let comparison = "Previous period has no available data";
      if (report.hasData && report.previous && report.range.comparisonAvailable) {
        if (metric === "ctr") comparison = `${((report.totals.ctr - report.previous.ctr) * 100).toFixed(1)} percentage points vs previous period`;
        else if (metric === "position") comparison = report.totals.position !== null && report.previous.position !== null ? `${report.previous.position.toFixed(1)} in previous period · lower is better` : "Average position unavailable";
        else {
          const before = report.previous[metric], current = report.totals[metric];
          comparison = before ? `${current >= before ? "+" : ""}${Math.round((current - before) / before * 100)}% vs previous period` : `${number.format(current - before)} more than previous period`;
        }
      }
      card.append(dl, node("small", comparison)); $.Totals.append(card);
    }
  }
  function table(host, rows, pages = false, filter = false) {
    host.replaceChildren();
    const normalized = value => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
    const query = normalized($.Filter.value.trim());
    for (const item of rows) {
      let matchName = item.name || "";
      if (pages) { try { matchName = decodeURIComponent(matchName); } catch {} }
      if (filter && !normalized(matchName).includes(query)) continue;
      const row = node("tr"), title = node("td");
      if (pages) {
        // Server also restricts links; keep untrusted API values out of hrefs here.
        let url;
        try { url = new URL(item.name); } catch { continue; }
        if (!["https:", "http:"].includes(url.protocol) || !["queerdancephilly.com", "www.queerdancephilly.com"].includes(url.hostname) || url.username || url.password) continue;
        let caption = `${url.pathname}${url.search}`;
        try { caption = decodeURIComponent(caption); } catch {}
        const link = node("a", caption); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"; title.append(link);
      } else title.textContent = item.name || item.day;
      row.append(title);
      for (const key of ["clicks", "impressions", "ctr", "position"]) row.append(node("td", display(key, item[key])));
      host.append(row);
    }
    if (!host.children.length) { const row = node("tr"), cell = node("td", query && filter ? "No matching results in this report." : "Google returned no rows for this period."); cell.colSpan = 5; row.append(cell); host.append(row); }
  }
  function chart() {
    $.Chart.replaceChildren();
    if (!report.daily.length) { $.Chart.append(node("p", "Google returned no daily figures for these dates.", "dashboard-note")); return; }
    const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 900 230"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Daily Google clicks and impressions; exact values in Daily search figures.");
    const max = Math.max(1, ...report.daily.flatMap(row => [row.clicks, row.impressions]));
    const start = Date.parse(`${report.range.start}T00:00Z`), end = Date.parse(`${report.range.end}T00:00Z`);
    const x = day => 10 + (end === start ? .5 : (Date.parse(`${day}T00:00Z`) - start) / (end - start)) * 880;
    for (const [key, className] of [["clicks", "visits"], ["impressions", "opens"]]) {
      // Separate segments at dates Google omitted instead of drawing across missing data.
      let points = [];
      const segment = () => { if (!points.length) return; const line = document.createElementNS(NS, "polyline"); line.setAttribute("class", `${className}-line`); line.setAttribute("points", points.join(" ")); svg.append(line); points = []; };
      report.daily.forEach((row, index) => {
        if (index && Date.parse(`${row.day}T00:00Z`) - Date.parse(`${report.daily[index - 1].day}T00:00Z`) > 86400000) segment();
        const y = 210 - row[key] / max * 195; points.push(`${x(row.day)},${y}`);
        const dot = document.createElementNS(NS, "circle"), title = document.createElementNS(NS, "title");
        dot.setAttribute("cx", x(row.day)); dot.setAttribute("cy", y); dot.setAttribute("r", report.daily.length < 40 ? 3 : 1.5); dot.setAttribute("class", `${className}-dot`);
        title.textContent = `${row.day}: ${number.format(row[key])} ${key}`; dot.append(title); svg.append(dot);
      }); segment();
    }
    const axis = node("div", "", "analytics-chart-axis"); axis.append(node("span", report.range.start), node("span", `Daily scale: 0–${number.format(max)}`), node("span", report.range.end));
    $.Chart.append(svg, axis);
  }
  function render() {
    $.Report.hidden = false;
    $.From.value = report.range.start; $.To.value = report.range.end;
    $.From.min = $.To.min = report.range.oldest; $.From.max = $.To.max = report.range.latest;
    const fetched = new Date(report.fetchedAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    state(report.hasData ? `Connected · ${report.property}` : `Connected · Google returned no search data for ${report.range.start}–${report.range.end}.`);
    $.Coverage.textContent = `${report.range.start}–${report.range.end} · Pacific time · Fetched ${fetched} ET. Reports refresh when opened after six hours, or with Refresh search data. ${report.notice || ""}`;
    cards(); chart(); table($.Daily, report.daily); table($.Queries, report.queries, false, true); table($.Pages, report.pages, true, true); table($.Devices, report.devices.map(row => ({ ...row, name: row.name.toLowerCase() })));
  }
  function exportCsv() {
    if (!report) return;
    const rows = [["Section", "Date or name", "Clicks", "Impressions", "CTR fraction", "Average position"]];
    const add = (section, item, name) => rows.push([section, name, item.clicks, item.impressions, item.ctr, item.position ?? "Unavailable"]);
    add("Total", report.totals, `${report.range.start}–${report.range.end}`);
    if (report.previous) add("Previous", report.previous, `${report.range.previousStart}–${report.range.previousEnd}`);
    for (const type of ["daily", "queries", "pages", "devices"]) for (const item of report[type]) add(type, item, item.day || item.name);
    const cell = value => `"${String(value ?? "").replace(/^\s*[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
    const url = URL.createObjectURL(new Blob([rows.map(row => row.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const link = node("a"); link.href = url; link.download = `QDP_Google_Search_${report.range.start}_${report.range.end}.csv`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $.ClientForm.addEventListener("submit", async event => {
    event.preventDefault(); if (busy) return; setBusy(true);
    try {
      await request({}, { action: "configure", clientId: $.ClientId.value.trim(), clientSecret: $.ClientSecret.value.trim() });
      $.ClientId.value = $.ClientSecret.value = ""; await load();
    } catch (error) { state(error.message, true); } finally { setBusy(false); }
  });
  $.Connect.addEventListener("click", async () => {
    if (busy) return; setBusy(true);
    try {
      const result = await request({}, { action: "connect" });
      const url = new URL(result.url);
      if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth") throw new Error("Google's connection link was invalid.");
      location.assign(url.href);
    } catch (error) { state(error.message, true); setBusy(false); }
  });
  $.Disconnect.addEventListener("click", async () => {
    if (busy) return; setBusy(true);
    try {
      const result = await request({}, { action: "disconnect" }); report = null; await load();
      if (!result.revoked) state("Disconnected here. Google could not confirm revocation; remove QDP Admin's access in your Google Account permissions too.", true);
    } catch (error) { state(error.message, true); } finally { setBusy(false); }
  });
  $.Refresh.addEventListener("click", () => { if (!busy) void load(true); });
  $.Period.addEventListener("change", () => { $.CustomDates.hidden = $.Period.value !== "custom"; if ($.Period.value !== "custom") void load(); });
  $.RangeForm.addEventListener("submit", event => { event.preventDefault(); void load(); });
  $.Filter.addEventListener("input", () => { if (report) { table($.Queries, report.queries, false, true); table($.Pages, report.pages, true, true); } });
  $.Export.addEventListener("click", exportCsv);
  const callback = new URL(location.href).searchParams.get("search");
  const messages = { denied: "Google connection was cancelled.", expired: "The Google connection request expired. Start again.", property: "That Google account cannot view QDP's Search Console property.", permission: "Enable the Search Console API in your Google Cloud project and check QDP property access.", scope: "Google must grant read-only Search Console access.", reconnect: "Google did not provide ongoing access. Connect again.", unavailable: "The Google connection could not finish. Try again." };
  void load().then(() => { if (callback && callback !== "connected") state(messages[callback] || "Google connection could not finish. Try again.", true); });
})();
