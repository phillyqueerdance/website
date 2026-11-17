(() => {
  const panel = document.getElementById("databaseIntegrity");
  const status = document.getElementById("integrityStatus");
  const { request, editUrl, message } = window.QDPAdminProfiles;
  const checks = new Map();
  const dismissing = new Set();
  const dismissed = new Set();
  const linkStatuses = new Map();
  let entities = null;
  let events = [];
  let views = new Map();
  let artists = new Map();
  let loading = false;
  let scanning = false;
  let scanned = false;
  let generation = 0;
  let linkStatus = "";

  function addChecks(containerId, definitions) {
    const container = document.getElementById(containerId);
    for (const [id, label] of definitions) {
      const details = document.createElement("details");
      details.className = "integrity-check";
      const summary = document.createElement("summary");
      const title = document.createElement("span");
      title.textContent = label;
      const count = document.createElement("strong");
      count.textContent = "—";
      summary.append(title, count);
      const body = document.createElement("div");
      details.append(summary, body);
      container.append(details);
      checks.set(id, { details, summary, count, body, label, issues: [] });
      details.addEventListener("toggle", () => {
        if (!details.open) return;
        renderCheck(id);
        if (id === "broken-links") void scanLinks();
      });
    }
  }

  addChecks("eventIntegrity", [
    ["missing-flyer", "Missing flyers"],
    ["missing-description", "Missing descriptions"],
    ["unrecognized-artists", "Unrecognized artists"],
    ["possible-duplicate", "Potential duplicates"],
    ["unclassified-relevance", "Unclassified queer relevance"],
    ["missing-party", "Missing party associations"]
  ]);
  addChecks("entityIntegrity", [
    ["missing-photo", "Missing profile photos"],
    ["missing-instagram", "Missing Instagram handles"],
    ["missing-bio", "Missing descriptions"],
    ["broken-links", "Broken external links"],
    ["duplicate-entity", "Potential duplicate entities"],
    ["no-associated-events", "Entities without associated events"]
  ]);

  function eventIssue(check, event, detail = "") {
    const id = event.eventId;
    checks.get(check).issues.push({
      key: `event:${encodeURIComponent(id)}:${check}`,
      title: event.publicTitle || event.title || id,
      detail: detail ? `${id} · ${detail}` : id,
      href: `/admin/?editEvent=${encodeURIComponent(id)}#events`,
      eventId: id
    });
  }

  function entityIssue(check, entity, detail = "", fingerprint = "") {
    const { kind, id, name } = entity;
    const key = `${kind}:${id}:${check}${fingerprint ? ":" + fingerprint : ""}`;
    checks.get(check).issues.push({ key, title: name, detail: detail || id, href: editUrl(kind, id) });
    return key;
  }

  function render() {
    for (const check of checks.values()) check.issues = [];
    if (!entities) return;
    for (const id of ["missing-flyer", "missing-description", "possible-duplicate"]) {
      for (const event of views.get(id) || []) eventIssue(id, event);
    }
    for (const event of events) {
      const unknown = (event.artistIds || []).filter(id => !artists.has(id));
      if (unknown.length) eventIssue("unrecognized-artists", event, unknown.join(", "));
      if (event.relevanceClassified === false) eventIssue("unclassified-relevance", event);
      if (event.partyId === "") eventIssue("missing-party", event);
    }
    const byName = new Map();
    const duplicates = new Set();
    for (const entity of entities) {
      if (entity.photo === false) entityIssue("missing-photo", entity);
      if (entity.instagram === false) entityIssue("missing-instagram", entity);
      if (entity.description === false) entityIssue("missing-bio", entity);
      if (!entity.linked) entityIssue("no-associated-events", entity);
      for (const link of entity.links) {
        if (!link.url || linkStatuses.get(link.url) === "broken") {
          entityIssue("broken-links", entity, link.label, link.key + "_" + link.fingerprint);
        }
      }
      for (const name of new Set([...entity.names, ...entity.aliases].map(window.normalizeListingName).filter(Boolean))) {
        const key = `${entity.kind}:${name}`;
        if (byName.has(key)) {
          duplicates.add(entity);
          duplicates.add(byName.get(key));
        } else {
          byName.set(key, entity);
        }
      }
    }
    for (const entity of duplicates) entityIssue("duplicate-entity", entity);
    for (const [id, check] of checks) {
      check.issues = check.issues.filter(issue => !dismissed.has(issue.key));
      check.count.textContent = check.issues.length;
      if (check.details.open) renderCheck(id);
    }
  }

  function renderCheck(id) {
    const { body, issues, label, summary } = checks.get(id);
    if (!entities) return;
    const list = document.createElement("ul");
    for (const issue of issues) {
      const row = document.createElement("li");
      const copy = document.createElement("div");
      const link = document.createElement("a");
      link.href = issue.href;
      link.textContent = issue.title;
      if (issue.eventId) link.dataset.integrityEventId = issue.eventId;
      copy.append(link);
      if (issue.detail) {
        const detail = document.createElement("small");
        detail.textContent = issue.detail;
        copy.append(detail);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Dismiss";
      button.setAttribute("aria-label", `Dismiss ${label.toLowerCase()} for ${issue.title}`);
      button.disabled = dismissing.has(issue.key);
      button.addEventListener("click", async () => {
        if (dismissing.has(issue.key)) return;
        dismissing.add(issue.key);
        button.disabled = true;
        try {
          const { key } = await request("admin.integrity.dismiss", { key: issue.key });
          dismissed.add(key);
          message(status, "");
          render();
          summary.focus();
        } catch (error) {
          message(status, error.message, true);
          button.disabled = false;
        } finally {
          dismissing.delete(issue.key);
        }
      });
      row.append(copy, button);
      list.append(row);
    }
    body.replaceChildren(list);
    if ((id === "broken-links" && linkStatus) || !issues.length) {
      const note = document.createElement("p");
      note.className = "dashboard-note";
      note.setAttribute("role", "status");
      note.textContent = id === "broken-links" && linkStatus ? linkStatus : "No issues found.";
      body.append(note);
    }
  }

  async function scanLinks() {
    if (!entities || scanning || scanned) return;
    const urls = [...new Set(entities.flatMap(entity => entity.links.map(link => link.url)).filter(Boolean))]
      .filter(url => !linkStatuses.has(url));
    scanning = true;
    const current = generation;
    try {
      for (let i = 0; i < urls.length; i += 8) {
        linkStatus = `Checking links · ${i} of ${urls.length}`;
        renderCheck("broken-links");
        const links = urls.slice(i, i + 8);
        const { statuses } = await request("admin.integrity.links", { links });
        if (generation !== current) return;
        links.forEach((url, index) => linkStatuses.set(url, statuses[index]));
      }
      scanned = true;
      const unverified = [...linkStatuses.values()].filter(value => value === "unverified").length;
      linkStatus = unverified ? `${unverified} links could not be verified.` : "";
    } catch (error) {
      if (generation === current) linkStatus = error.message;
    } finally {
      if (generation === current) {
        scanning = false;
        render();
      }
    }
  }

  async function refresh() {
    if (!panel.open || loading) return;
    loading = true;
    message(status, "Checking the Index…");
    try {
      const result = await request("admin.integrity");
      entities = result.entities;
      for (const key of result.dismissed) dismissed.add(key);
      generation++;
      scanning = scanned = false;
      linkStatus = "";
      linkStatuses.clear();
      message(status, "");
      render();
      if (checks.get("broken-links").details.open) void scanLinks();
    } catch (error) {
      message(status, error.message, true);
    } finally {
      loading = false;
    }
  }

  panel.addEventListener("toggle", () => {
    if (!panel.open) return;
    if (entities) render();
    else void refresh();
  });
  window.QDPAdminIntegrity = {
    refresh,
    updateEvents(upcoming, nextViews, nextArtists) {
      events = upcoming;
      views = nextViews;
      artists = nextArtists;
      if (panel.open) render();
    }
  };
})();
