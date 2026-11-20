(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  const $ = Object.fromEntries(["Refresh", "Updated", "RangeForm", "Period", "CustomDates", "From", "To",
    "Export", "State", "Coverage", "Content", "Totals", "Chart", "Daily", "Sources", "Devices", "Usage",
    "Discovery", "Profiles", "Events", "EventsTable", "ProfileSearch", "EventSearch", "Pause", "Collection", "Exclude"]
    .map(name => [name, byId(`analytics${name}`)]));
  const number = new Intl.NumberFormat("en-US");
  const dateLabel = day => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  const names = { "direct-unknown": "Direct / unknown", direct: "Direct event link", calendar: "Calendar", event: "Event details",
    artist: "Artist profiles", venue: "Venue profiles", party: "Party profiles", collective: "Collective profiles",
    artists: "Artists", venues: "Venues", parties: "Parties", collectives: "Collectives", "scene-map": "Discovery Map",
    "past-events": "Past Events", about: "About", melt: "Melt", desktop: "Desktop", mobile: "Mobile", tablet: "Tablet" };
  const metrics = { event_open: "Event opens", event_impression: "Listing impressions", calendar_click: "Calendar clicks",
    share_open: "Share dialogs opened", link_copy: "Links copied", directions_click: "Directions clicks", external_click: "External clicks",
    gallery_open: "Galleries opened", map_focus: "Map centers", map_relationship: "Relationships opened",
    search_use: "Searches used", filter_use: "Filters changed", page_view: "Section views", visit: "Recorded visits" };
  let data = null, busy = false, serial = 0, sortKey = "opens", sortDirection = -1;
  const label = value => names[value] || value || "Unknown";
  function element(tag, text = "", className = "") {
    const node = document.createElement(tag);
    if (text !== "") node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function setBusy(value) {
    busy = value;
    $.Refresh.disabled = value;
    $.Pause.disabled = value || !data?.configured;
    $.Export.disabled = value || !data?.configured;
    $.Refresh.classList.toggle("busy", value);
  }
  function status(message, error = false) {
    $.State.textContent = message;
    $.State.classList.toggle("analytics-error", error);
  }
  async function request(params, body) {
    const url = new URL("/admin/analytics-data", location.origin);
    for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url.href, { credentials: "same-origin", signal: controller.signal,
        ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
      if (response.redirected || response.status === 401 || response.status === 403) throw new Error("Sign in to QDP Admin again, then refresh analytics.");
      const result = await response.json().catch(() => null);
      if (!response.ok || !result) throw new Error(result?.error || `Analytics unavailable (HTTP ${response.status}).`);
      return result;
    } finally { clearTimeout(timer); }
  }
  function params() {
    return $.Period.value === "custom" ? { from: $.From.value, to: $.To.value } : { days: $.Period.value };
  }
  async function load(refresh = false) {
    const current = ++serial;
    setBusy(true);
    status("Loading analytics…");
    try {
      const result = await request({ ...params(), ...(refresh ? { refresh: "1" } : {}) });
      if (current !== serial) return;
      data = result;
      $.Content.hidden = !result.configured;
      if (!result.configured) {
        status(result.message);
        $.Coverage.textContent = "Collection is off until the free setup is complete.";
        $.Collection.textContent = "Not connected. See Free setup and limits below.";
        return;
      }
      render();
    } catch (error) {
      if (current !== serial) return;
      status(error.name === "AbortError" ? "Analytics took too long to load. Try Refresh." : error.message, true);
      if (!data) $.Collection.textContent = "Collection status could not be checked.";
    } finally { if (current === serial) setBusy(false); }
  }
  function cards() {
    $.Totals.replaceChildren();
    const available = data.series.some(row => row.visits !== null);
    for (const [key, title] of [["visit", "Recorded visits"], ["event_open", "Event opens"], ["link_copy", "Link copies"], ["calendar_click", "Calendar clicks"]]) {
      const card = element("div", "", "analytics-total"), dl = element("dl");
      const current = Number(data.totals.current[key] || 0), previous = Number(data.totals.previous[key] || 0);
      dl.append(element("dt", title), element("dd", available ? number.format(current) : "—"));
      let comparison = "Previous period unavailable";
      if (data.comparisonAvailable) comparison = previous ? `${current >= previous ? "+" : ""}${Math.round((current - previous) / previous * 100)}% vs previous period` :
        current ? `${number.format(current)} more than previous period` : "No change from previous period";
      card.append(dl, element("small", comparison));
      $.Totals.append(card);
    }
  }
  function bars(host, rows) {
    host.replaceChildren();
    if (!rows.length || !rows.some(row => Number(row.total))) { host.append(element("p", "No recorded activity in this period.", "dashboard-note")); return; }
    const list = element("ul", "", "analytics-bars");
    const max = Math.max(...rows.map(row => Number(row.total)));
    for (const row of rows) {
      const item = element("li"), caption = element("div", "", "analytics-bar-label");
      caption.append(element("span", label(row.name)), element("strong", number.format(row.total)));
      const track = element("div", "", "analytics-bar-track"), fill = element("span");
      track.setAttribute("aria-hidden", "true"); fill.style.width = `${Number(row.total) / max * 100}%`;
      track.append(fill); item.append(caption, track); list.append(item);
    }
    host.append(list);
  }
  function chart() {
    $.Chart.replaceChildren();
    const rows = data.series, available = rows.filter(row => row.visits !== null);
    if (!available.length) { $.Chart.append(element("p", "No tracking history for these dates.", "dashboard-note")); return; }
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 900 230"); svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Daily recorded visits and event opens. Exact figures are in Daily figures below.");
    const max = Math.max(1, ...available.flatMap(row => [row.visits, row.opens]));
    const x = index => 10 + (rows.length > 1 ? index / (rows.length - 1) : .5) * 880;
    const y = value => 210 - value / max * 195;
    for (let index = 0; index < 4; index++) {
      const line = document.createElementNS(NS, "line");
      for (const [attr, value] of Object.entries({ x1: 0, x2: 900, y1: 15 + index * 65, y2: 15 + index * 65, class: "chart-grid" })) line.setAttribute(attr, value);
      svg.append(line);
    }
    for (const [key, className] of [["visits", "visits"], ["opens", "opens"]]) {
      const line = document.createElementNS(NS, "polyline");
      line.setAttribute("class", `${className}-line`);
      line.setAttribute("points", rows.flatMap((row, index) => row[key] === null ? [] : [`${x(index)},${y(row[key])}`]).join(" "));
      svg.append(line);
      rows.forEach((row, index) => {
        if (row[key] === null) return;
        const dot = document.createElementNS(NS, "circle"), title = document.createElementNS(NS, "title");
        dot.setAttribute("cx", x(index)); dot.setAttribute("cy", y(row[key])); dot.setAttribute("r", rows.length < 35 ? "4" : "2"); dot.setAttribute("class", `${className}-dot`);
        title.textContent = `${dateLabel(row.day)}: ${number.format(row[key])} ${key === "visits" ? "visits" : "event opens"}`;
        dot.append(title); svg.append(dot);
      });
    }
    const axis = element("div", "", "analytics-chart-axis");
    axis.append(element("span", dateLabel(rows[0].day)), element("span", `Daily scale: 0–${number.format(max)}`), element("span", dateLabel(rows.at(-1).day)));
    $.Chart.append(svg, axis);
  }
  function emptyRow(host, columns, message) {
    const row = element("tr"), cell = element("td", message); cell.colSpan = columns; row.append(cell); host.append(row);
  }
  function publicLink(kind, id, name) {
    const url = new URL("/", location.origin);
    if (kind === "event") url.searchParams.set("event", id);
    else { url.searchParams.set("archive", kind); url.searchParams.set("id", id); }
    const link = element("a", name || id); link.href = url.href; link.target = "_blank"; link.rel = "noopener";
    return link;
  }
  function events() {
    $.Events.replaceChildren();
    const query = $.EventSearch.value.toLocaleLowerCase().trim();
    const rows = data.events.filter(row => `${row.id} ${row.name}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => sortDirection * (Number(a[sortKey]) - Number(b[sortKey])) || a.id.localeCompare(b.id));
    if (!rows.length) return emptyRow($.Events, 8, query ? "No matching events in these results." : "No event activity recorded in this period.");
    for (const item of rows) {
      const row = element("tr"), title = element("td");
      title.append(publicLink("event", item.id, item.name), element("small", item.id));
      const details = element("details"), summary = element("summary", "Action sources"), content = element("div");
      details.append(summary, content); title.append(details);
      details.addEventListener("toggle", async () => {
        if (!details.open || details.dataset.loaded) return;
        details.dataset.loaded = "1"; content.textContent = "Loading sources…";
        try {
          const result = await request({ from: data.range.start, to: data.range.end, event: item.id });
          content.replaceChildren();
          for (const source of result.rows) content.append(element("p", `${metrics[source.metric] || source.metric} · ${label(source.source)}: ${number.format(source.total)}`));
          if (!result.rows.length) content.textContent = "No recorded actions.";
        } catch (error) { content.textContent = error.message; delete details.dataset.loaded; }
      });
      row.append(title);
      for (const key of ["impressions", "opens", "copies", "shares", "calendar", "directions", "outbound"]) row.append(element("td", number.format(item[key] || 0)));
      $.Events.append(row);
    }
  }
  function profiles() {
    $.Profiles.replaceChildren();
    const query = $.ProfileSearch.value.toLocaleLowerCase().trim();
    const rows = data.profiles.filter(row => `${row.id} ${row.name}`.toLocaleLowerCase().includes(query));
    if (!rows.length) return emptyRow($.Profiles, 5, query ? "No matching profiles in these results." : "No profile activity recorded in this period.");
    for (const item of rows) {
      const row = element("tr"), title = element("td");
      title.append(publicLink(item.kind, item.id, item.name), element("small", item.id)); row.append(title, element("td", item.kind));
      for (const key of ["views", "focuses", "outbound"]) row.append(element("td", number.format(item[key] || 0)));
      $.Profiles.append(row);
    }
  }
  function render() {
    const timestamp = value => new Date(value).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    $.Updated.textContent = `Updated ${timestamp(data.generatedAt)} ET`;
    $.From.value = data.range.start; $.To.value = data.range.end;
    status(`${dateLabel(data.range.start)}–${dateLabel(data.range.end)} · ${data.range.days} ${data.range.days === 1 ? "day" : "days"} · Philadelphia time`);
    const notices = [];
    if (!data.startedAt) notices.push("Collection is ready. No public-site activity has been recorded yet.");
    else {
      notices.push(`Tracking began ${timestamp(data.startedAt)} ET.`);
      if (data.range.start <= data.startedAt.slice(0, 10)) notices.push("This period includes time before tracking began.");
      if (data.lastSeenAt) notices.push(`Last activity received ${timestamp(data.lastSeenAt)} ET.`);
    }
    const limited = data.budget.days.filter(day => day.limited && day.day >= data.range.start && day.day <= data.range.end);
    if (limited.length) notices.push(`Collection reached its daily budget on ${limited.map(day => day.day).join(", ")}; affected dates have incomplete counts.`);
    if (data.gaps?.length) notices.push("The selected or previous period includes paused collection. Affected dates are marked partial.");
    if (!data.enabled) notices.push("Collection is paused.");
    $.Coverage.textContent = notices.join(" ");
    $.Collection.textContent = data.enabled ? "Collection is enabled. Daily totals are retained; individual browsing histories are not recorded." : "Collection is paused. Existing figures remain available.";
    $.Pause.textContent = data.enabled ? "Pause collection" : "Resume collection";
    cards(); chart(); bars($.Sources, data.sources); bars($.Devices, data.devices); bars($.Usage, data.usage);
    bars($.Discovery, ["map_focus", "map_relationship", "search_use", "filter_use", "gallery_open"].map(key => ({ name: metrics[key], total: data.totals.current[key] || 0 })));
    $.Daily.replaceChildren();
    for (const day of data.series) {
      const row = element("tr");
      row.append(element("td", `${day.day}${day.partial ? " (partial)" : ""}`), element("td", day.visits === null ? "Unavailable" : number.format(day.visits)), element("td", day.opens === null ? "Unavailable" : number.format(day.opens)));
      $.Daily.append(row);
    }
    events(); profiles();
  }
  function exportCsv() {
    if (!data?.configured) return;
    const rows = [["Section", "Date", "Type", "ID", "Name", "Metric", "Count"]];
    for (const row of data.series) for (const metric of ["visits", "opens"]) rows.push(["Daily", row.day, "", "", "", metric, row[metric] ?? "Unavailable"]);
    for (const row of data.events) for (const metric of ["impressions", "opens", "copies", "shares", "calendar", "directions", "outbound"]) rows.push(["Events", "", "event", row.id, row.name, metric, row[metric] || 0]);
    for (const row of data.profiles) for (const metric of ["views", "focuses", "outbound"]) rows.push(["Profiles", "", row.kind, row.id, row.name, metric, row[metric] || 0]);
    for (const section of ["sources", "devices", "usage"]) for (const row of data[section]) rows.push([section, "", "", "", label(row.name), "total", row.total]);
    const cell = value => `"${String(value ?? "").replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
    const url = URL.createObjectURL(new Blob([rows.map(row => row.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const link = element("a"); link.href = url; link.download = `QDP_Analytics_${data.range.start}_${data.range.end}.csv`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  try {
    if (localStorage.getItem("qdp-analytics-exclude") === null) localStorage.setItem("qdp-analytics-exclude", "1");
    $.Exclude.checked = localStorage.getItem("qdp-analytics-exclude") !== "0";
  } catch { $.Exclude.disabled = true; }
  $.Exclude.addEventListener("change", () => {
    try { localStorage.setItem("qdp-analytics-exclude", $.Exclude.checked ? "1" : "0"); }
    catch { status("This browser could not save the exclusion setting.", true); }
  });
  $.Refresh.addEventListener("click", () => { if (!busy) void load(true); });
  $.Period.addEventListener("change", () => { $.CustomDates.hidden = $.Period.value !== "custom"; if ($.Period.value !== "custom") void load(); });
  $.RangeForm.addEventListener("submit", submit => { submit.preventDefault(); void load(); });
  $.EventSearch.addEventListener("input", () => { if (data?.configured) events(); });
  $.ProfileSearch.addEventListener("input", () => { if (data?.configured) profiles(); });
  $.Export.addEventListener("click", exportCsv);
  $.EventsTable.addEventListener("click", click => {
    const button = click.target.closest("button[data-sort]");
    if (!button || !data?.configured) return;
    if (sortKey === button.dataset.sort) sortDirection *= -1;
    else { sortKey = button.dataset.sort; sortDirection = -1; }
    $.EventsTable.querySelectorAll("th[aria-sort]").forEach(th => th.removeAttribute("aria-sort"));
    button.closest("th").setAttribute("aria-sort", sortDirection === 1 ? "ascending" : "descending"); events();
  });
  $.Pause.addEventListener("click", async () => {
    if (busy || !data?.configured) return;
    setBusy(true);
    try { await request({}, { enabled: !data.enabled }); await load(true); }
    catch (error) { status(error.message, true); setBusy(false); }
  });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  $.From.max = $.To.max = today;
  void load();
})();
