(() => {
  try {
    if (localStorage.getItem("qdp-analytics-exclude") === null) localStorage.setItem("qdp-analytics-exclude", "1");
  } catch {}
  const host = document.getElementById("analyticsSummaryTotals");
  const status = document.getElementById("analyticsSummaryState");
  if (!host || !status) return;
  let loading = false;
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const response = await fetch("/admin/analytics-data?days=7", { credentials: "same-origin", signal: AbortSignal.timeout(15000) });
      if (response.redirected || !response.ok) throw new Error("Visitor activity unavailable. Open Analytics to retry.");
      const data = await response.json();
      if (!data.configured) { host.replaceChildren(); status.textContent = "Analytics setup is incomplete. Open Analytics for setup status."; return; }
      status.textContent = `${data.range.start}–${data.range.end} · ${data.enabled ? "Collection enabled" : "Collection paused"}`;
      host.replaceChildren();
      const available = data.series.some(row => row.visits !== null);
      for (const [key, label] of [["visit", "Recorded visits"], ["event_open", "Event opens"], ["link_copy", "Link copies"], ["calendar_click", "Calendar clicks"]]) {
        const card = document.createElement("div"), dl = document.createElement("dl"); card.className = "analytics-total";
        const term = document.createElement("dt"), value = document.createElement("dd");
        term.textContent = label; value.textContent = available ? Number(data.totals.current[key] || 0).toLocaleString("en-US") : "—";
        dl.append(term, value); card.append(dl); host.append(card);
      }
    } catch (error) { host.replaceChildren(); status.textContent = error.name === "TimeoutError" ? "Visitor activity took too long to load. Open Analytics to retry." : error.message; }
    finally { loading = false; }
  }
  document.getElementById("refreshButton")?.addEventListener("click", refresh);
  void refresh();
})();
