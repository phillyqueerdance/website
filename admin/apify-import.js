import { readScrapeWorkbook, REVIEW_FIELDS } from "./apify-workbook.js?v=20261120-daily-1";
import { suggestedCorrectionTimes } from "./apify-correction-times.js?v=20261116-corrections-1";

const elements = Object.fromEntries([
  "workbook", "workbook-status", "events-tab", "corrections-tab", "event-count",
  "correction-count", "events-view", "events-empty", "candidates", "save-panel",
  "save-count", "save-status", "save-apify", "corrections-view", "corrections-empty",
  "corrections-status", "corrections"
].map(id => [id, document.getElementById(id)]));

const state = {
  review: null,
  controls: [],
  busy: false,
  listings: null,
  listingStatus: "",
  correctionEdits: new Map(),
  correctionBusy: false
};

const dateLabel = new Intl.DateTimeFormat("en-US", {
  weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC"
});
const localDay = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York"
});
const localTime = new Intl.DateTimeFormat("en-US", {
  hour: "numeric", minute: "2-digit", timeZone: "America/New_York"
});

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

function openLink(label, value) {
  const url = httpsUrl(value);
  if (!url) return null;
  const anchor = element("a", "apify-link", label);
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  return anchor;
}

function flyerPreview(value, alt, useAdminProxy = false) {
  const frame = element("figure", "apify-flyer");
  const url = httpsUrl(value);
  const status = element("figcaption", "apify-muted", value ? "Flyer preview unavailable." : "No flyer supplied");
  if (!url) {
    frame.append(status);
    return frame;
  }

  const image = element("img");
  image.alt = alt;
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  status.hidden = true;
  image.addEventListener("error", () => {
    if (useAdminProxy && image.getAttribute("src") !== url) {
      image.src = url;
      return;
    }
    image.hidden = true;
    status.hidden = false;
  });
  image.src = useAdminProxy ? "/admin/flyer?url=" + encodeURIComponent(url) : url;
  frame.append(image, status);
  return frame;
}

function sheetDate(value) {
  if (!value) return "";
  const date = new Date(value + "T12:00:00Z");
  return Number.isFinite(+date) ? dateLabel.format(date) : value;
}

function candidateField(field, candidate, onChange) {
  const label = element("label", "field" + (field.wide ? " apify-wide" : ""));
  const control = element(
    field.type === "textarea" ? "textarea" : field.type === "yes-no" ? "select" : "input"
  );
  const value = candidate.fields[field.name];
  if (field.type === "yes-no") {
    for (const option of ["", "Yes", "No"]) {
      const item = element("option", "", option || "Unspecified");
      item.value = option;
      control.append(item);
    }
  } else if (field.type === "textarea") {
    control.rows = field.name === "Description" ? 4 : 2;
  } else {
    control.type = field.type || "text";
    if (field.type === "time") control.step = 1;
  }
  control.value = value;
  if (value && !control.value) {
    // Leave unusual source values visible and editable instead of blanking them.
    if (control.tagName === "SELECT") {
      const item = element("option", "", value);
      item.value = value;
      control.append(item);
    } else {
      control.type = "text";
    }
    control.value = value;
  }

  control.addEventListener("input", () => {
    candidate.fields[field.name] = control.value;
    onChange(field.name);
  });
  label.append(element("span", "", field.label), control);
  return label;
}

function candidateCard(candidate) {
  const fields = candidate.fields;
  const article = element("article", "apify-card");
  const heading = element("div", "apify-card-header");
  const summary = element("div", "apify-summary");
  const title = element("h2");
  const date = element("p", "apify-card-date");
  const metaText = [
    candidate.suggestion ? "Scrape recommendation: " + candidate.suggestion : "",
    candidate.readiness
  ].filter(Boolean).join(" · ");
  const recommendation = element("p", "apify-muted", metaText);
  recommendation.hidden = !metaText;
  summary.append(date, title, recommendation);

  const decisions = element("fieldset", "apify-decisions");
  const legend = element("legend", "sr-only");
  const buttons = ["INCLUDE", "WAIT", "EXCLUDE"].map(decision => {
    const button = element("button", "apify-decision", decision[0] + decision.slice(1).toLowerCase());
    button.type = "button";
    button.dataset.decision = decision;
    button.addEventListener("click", () => {
      candidate.decision = decision;
      candidate.decisionDirty = true;
      updateControls();
    });
    return button;
  });
  decisions.append(legend, ...buttons);
  const saved = element("p", "apify-saved", "Saved to Apify Import");
  saved.hidden = true;
  heading.append(summary, decisions, saved);

  const layout = element("div", "apify-review-layout");
  const media = element("div", "apify-media");
  const preview = flyerPreview(fields.RawFlyerURL, "Flyer for " + fields["Title (internal)"]);
  const mediaLinks = element("div", "apify-links");
  for (const field of REVIEW_FIELDS.filter(field => field.type === "link")) {
    const value = field.name === "Instagram_URL"
      ? fields.Instagram_URL || instagramEventUrl(fields.Event_URL)
      : fields[field.name];
    const link = openLink(field.label, value);
    if (link) mediaLinks.append(link);
  }
  media.append(preview, mediaLinks);

  const editor = element("fieldset", "apify-editor");
  const synchronizeSummary = () => {
    title.textContent = fields["Title (internal)"] || "Untitled event";
    legend.textContent = "Import decision for " + title.textContent;
    date.textContent = [sheetDate(fields.StartDate), fields.Location].filter(Boolean).join(" · ");
  };
  for (const field of REVIEW_FIELDS.filter(field => field.type !== "link")) {
    editor.append(candidateField(field, candidate, name => {
      if (name === "Title (internal)" || name === "StartDate" || name === "Location") {
        synchronizeSummary();
      }
    }));
  }

  synchronizeSummary();
  layout.append(media, editor);
  article.append(heading, layout);
  state.controls.push({ candidate, article, decisions, buttons, editor, saved });
  return article;
}

function instagramEventUrl(value) {
  return /^https:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\//i.test(value || "") ? value : "";
}

function selectedCandidates() {
  return (state.review?.candidates ?? []).filter(candidate =>
    candidate.decision === "INCLUDE" && !candidate.saved
  );
}

function pendingDecisions() {
  return (state.review?.candidates ?? []).filter(candidate => candidate.decisionDirty
    && !candidate.saved && candidate.decision !== "INCLUDE");
}

async function decisionRequest(operation, items) {
  const records = [];
  for (let offset = 0; offset < items.length; offset += 100) {
    const response = await fetch("/admin/discovery-decisions", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ operation, items: items.slice(offset, offset + 100) })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok !== "yes" || !Array.isArray(data.records)) {
      throw new Error(data?.error || "Saved discovery decisions are unavailable. Try again before importing.");
    }
    records.push(...data.records);
  }
  return records;
}

async function restoreDecisions(review) {
  const items = [...review.candidates, ...review.corrections];
  const records = await decisionRequest("read", items.map(item => ({ identity: item.discovery })));
  items.forEach((item, index) => {
    const record = records[index];
    if (!record) return;
    item.decision = record.decision;
    item.decisionSaved = true;
    item.saved = record.decision === "INCLUDE";
  });
}

function updateControls() {
  const selected = selectedCandidates();
  const pending = pendingDecisions();
  const withoutFlyer = selected.filter(candidate => !candidate.fields.RawFlyerURL.trim()).length;
  elements.workbook.disabled = state.busy || state.correctionBusy;
  elements["save-apify"].disabled = state.busy || state.correctionBusy || (!selected.length && !pending.length);
  elements["save-count"].textContent = selected.length + (selected.length === 1 ? " event" : " events")
    + " included" + (pending.length ? " · " + pending.length + " decisions to save" : "")
    + (withoutFlyer ? " · " + withoutFlyer + " without a flyer" : "");
  for (const { candidate, article, decisions, buttons, editor, saved } of state.controls) {
    article.dataset.decision = candidate.decision;
    decisions.hidden = candidate.saved;
    saved.hidden = !candidate.saved && !candidate.decisionSaved;
    saved.textContent = candidate.saved ? "Saved to Apify Import"
      : candidate.decision === "EXCLUDE" ? "Excluded from future scrapes" : "Waiting for a future review";
    decisions.disabled = state.busy || candidate.saved;
    editor.disabled = state.busy || candidate.saved;
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(button.dataset.decision === candidate.decision));
    }
  }
}

function setStatus(node, text, error = false) {
  node.textContent = text;
  node.classList.toggle("is-error", error);
}

async function loadWorkbook() {
  const file = elements.workbook.files[0];
  if (!file || state.busy || state.correctionBusy) return;
  state.busy = true;
  updateControls();
  setStatus(elements["workbook-status"], "Reading " + file.name + "…");
  try {
    const review = await readScrapeWorkbook(file);
    await restoreDecisions(review);
    state.review = review;
    state.controls = [];
    state.correctionEdits.clear();
    const { candidates, corrections } = state.review;
    elements["event-count"].textContent = candidates.length;
    elements["correction-count"].textContent = corrections.length;
    elements["events-empty"].textContent = "This workbook has no new event candidates.";
    elements["events-empty"].hidden = Boolean(candidates.length);
    elements["save-panel"].hidden = !candidates.length;
    elements.candidates.replaceChildren(...candidates.map(candidateCard));
    setStatus(elements["save-status"], "");
    setStatus(elements["workbook-status"], file.name + " loaded.");
  } catch (error) {
    setStatus(elements["workbook-status"], error.message || "The workbook could not be opened.", true);
    return;
  } finally {
    elements.workbook.value = "";
    state.busy = false;
    updateControls();
  }
  showView();
}

async function saveSelected() {
  const selected = selectedCandidates();
  const pending = pendingDecisions();
  if ((!selected.length && !pending.length) || state.busy || state.correctionBusy) return;
  state.busy = true;
  updateControls();
  setStatus(elements["save-status"], "Saving to Apify Import…");
  try {
    if (pending.length) {
      await decisionRequest("save", pending.map(candidate => ({ identity: candidate.discovery, decision: candidate.decision })));
      for (const candidate of pending) { candidate.decisionDirty = false; candidate.decisionSaved = true; }
    }
    if (!selected.length) {
      setStatus(elements["save-status"], pending.length + " decisions saved. Wait items carry forward; Exclude items will not return.");
      return;
    }
    let added = 0, alreadySaved = 0;
    for (let offset = 0; offset < selected.length; offset += 5) {
    const batch = selected.slice(offset, offset + 5);
    const response = await fetch("/admin/api", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "admin.apifyimport",
        rows: batch.map(({ key, fields, discovery }) => ({ key, fields, discovery }))
      })
    });
    const result = await response.json().catch(() => null);
    if (result?.error === "Unknown admin action.") {
      throw new Error("Apify Import needs the updated Apps Script web app deployment.");
    }
    if (!response.ok || result?.ok !== "yes"
      || result.added + result.alreadySaved !== batch.length) {
      throw new Error(result?.error || "The save could not be confirmed. You can retry this selection.");
    }
    for (const candidate of batch) { candidate.saved = true; candidate.decisionDirty = false; }
    added += result.added; alreadySaved += result.alreadySaved;
    }
    const detail = [
      added ? added + " saved to Apify Import." : "",
      alreadySaved ? alreadySaved + " already in Apify Import." : ""
    ].filter(Boolean).join(" ");
    setStatus(elements["save-status"], detail);
  } catch (error) {
    setStatus(elements["save-status"], error.message || "The save failed. Your decisions are still here.", true);
  } finally {
    state.busy = false;
    updateControls();
  }
}

function listingTiming(event) {
  const start = new Date(event.start || "");
  const end = new Date(event.end || "");
  if (!Number.isFinite(+start)) return "";
  const startDay = localDay.format(start);
  const first = startDay + " · " + localTime.format(start);
  if (!Number.isFinite(+end) || +end === +start) return first;
  const endDay = localDay.format(end);
  return first + " – " + (endDay === startDay ? "" : endDay + " · ") + localTime.format(end);
}

function publicEventId(value) {
  const url = httpsUrl(value);
  return url ? (new URL(url).searchParams.get("event") ?? "").toUpperCase() : "";
}

function correctionCard(correction) {
  const article = element("article", "apify-card apify-correction");
  const heading = element("div", "apify-card-header");
  const summary = element("div", "apify-summary");
  const workbookTitle = correction["Current title"];
  summary.append(
    element("p", "apify-card-date", [sheetDate(correction.Date), correction.Venue].filter(Boolean).join(" · ")),
    element("h2", "", workbookTitle)
  );
  const links = element("div", "apify-links");
  links.append(...[
    openLink("View QDP listing", correction["Public listing"]),
    openLink("Open Instagram post", correction["Instagram source"])
  ].filter(Boolean));
  heading.append(summary, links);
  const decisions = element("fieldset", "apify-decisions");
  decisions.append(element("legend", "sr-only", "Decision for " + workbookTitle));
  decisions.disabled = state.busy || state.correctionBusy || correction.saved;
  for (const decision of ["INCLUDE", "WAIT", "EXCLUDE"]) {
    const button = element("button", "apify-decision", decision[0] + decision.slice(1).toLowerCase());
    button.type = "button";
    button.dataset.decision = decision;
    button.setAttribute("aria-pressed", String(correction.decision === decision));
    button.addEventListener("click", () => { correction.decision = decision; renderCorrections(); });
    decisions.append(button);
  }
  heading.append(decisions);

  const compare = element("div", "apify-compare");
  const current = element("section", "apify-comparison apify-current");
  current.append(element("h3", "", "Current QDP listing"));
  const eventId = publicEventId(correction["Public listing"]);
  const live = state.listings?.get(eventId);
  if (live) {
    if (live.title && live.title !== workbookTitle) current.append(element("strong", "", live.title));
    const timing = listingTiming(live);
    const place = [live.venue, live.address].filter(Boolean).join(" · ");
    if (timing) current.append(element("p", "apify-current-detail", timing));
    if (place) current.append(element("p", "apify-current-detail", place));
    if (live.description) current.append(element("p", "apify-description", live.description));
    if (live.flyerUrl) current.append(flyerPreview(live.flyerUrl, "Current flyer", true));
  } else {
    current.append(element(
      "p", "apify-muted",
      state.listingStatus === "loading" ? "Loading the current listing…"
        : "The current listing details are unavailable. Use the QDP listing link to check it."
    ));
  }

  const proposed = element("section", "apify-comparison apify-proposed");
  proposed.append(
    element("h3", "", "Proposed correction"),
    element("p", "apify-description", correction.Correction)
  );
  if (correction["Suggested Description"]) {
    proposed.append(
      element("h4", "", "Suggested description"),
      element("p", "apify-description", correction["Suggested Description"])
    );
  }
  if (suggestedLineup(correction)) proposed.append(element("p", "apify-description", "Proposed lineup: " + suggestedLineup(correction)));
  if (correction.RawFlyerURL) proposed.append(flyerPreview(correction.RawFlyerURL, "Proposed flyer"));
  compare.append(current, proposed);
  article.append(heading, compare);
  if (correction["Apply to existing event only"]) {
    article.append(element("p", "apify-correction-note", correction["Apply to existing event only"]));
  }
  if (eventId) article.append(correctionEditor(correction, eventId, live));
  else article.append(element("p", "apify-muted", "A QDP listing link with an EventID is required to save this correction."));
  return article;
}

const CORRECTION_OPTIONS = [
  ["description", "Description"],
  ["lineup", "Lineup"],
  ["start", "Start date and time"],
  ["end", "End date and time"],
  ["flyer", "Flyer"]
];

function suggestedLineup(correction) {
  return correction["Suggested Lineup_Raw"] || /(?:^|\n)Proposed lineup:\s*([^\n]+)/i.exec(correction.Correction || "")?.[1] || "";
}

const philadelphiaDateTime = new Intl.DateTimeFormat("en-CA", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: "America/New_York"
});

function correctionDateTime(value) {
  const date = new Date(value || "");
  if (!Number.isFinite(+date)) return "";
  const parts = Object.fromEntries(philadelphiaDateTime.formatToParts(date).map(part => [part.type, part.value]));
  return [parts.year, parts.month, parts.day].join("-") + "T" +
    [parts.hour, parts.minute, parts.second].join(":");
}

function correctionEditor(correction, eventId, live) {
  let edit = state.correctionEdits.get(correction);
  if (!edit) {
    edit = { chosen: new Set(), draft: {}, message: "", error: false };
    state.correctionEdits.set(correction, edit);
  }

  const current = { start: correctionDateTime(live?.start), end: correctionDateTime(live?.end) };
  const suggested = suggestedCorrectionTimes(correction, current);
  const draft = {
    description: correction["Suggested Description"] || live?.description || "",
    lineup: suggestedLineup(correction),
    start: suggested.start || current.start,
    end: suggested.end || current.end,
    flyer: httpsUrl(correction.RawFlyerURL),
    ...edit.draft
  };

  const section = element("section", "apify-correction-editor");
  const fields = element("fieldset", "apify-correction-fields");
  fields.disabled = state.busy || state.correctionBusy || correction.saved || correction.decision !== "INCLUDE";
  fields.append(element("legend", "", "Choose correction fields to save"));
  fields.append(element("p", "apify-muted", "Times use Philadelphia time."));

  const status = element("p", "apify-status");
  status.setAttribute("role", "status");
  setStatus(status, edit.message, edit.error);

  const save = element("button", "save-all-button", correction.decision === "INCLUDE" ? "Save correction to Apify Import" : "Save decision");
  save.type = "button";
  save.addEventListener("click", () => void saveCorrection(correction, eventId, edit, draft));
  function updateSave() {
    save.disabled = state.busy || state.correctionBusy || correction.saved
      || (correction.decision === "INCLUDE" && !edit.chosen.size);
  }

  for (const [field, label] of CORRECTION_OPTIONS) {
    if (field === "flyer" && !draft.flyer) continue;
    const row = element("div", "apify-correction-choice");
    const header = element("label", "apify-correction-label");
    const toggle = element("input");
    toggle.type = "checkbox";
    toggle.checked = edit.chosen.has(field);
    toggle.addEventListener("change", () => {
      if (toggle.checked) edit.chosen.add(field);
      else edit.chosen.delete(field);
      updateSave();
    });
    header.append(toggle, element("span", "", label));
    row.append(header);

    if (field === "flyer") {
      row.append(openLink("Open replacement flyer", draft.flyer));
    } else {
      const editor = element(field === "description" || field === "lineup" ? "textarea" : "input");
      if (field === "description" || field === "lineup") editor.rows = 3;
      else { editor.type = "datetime-local"; editor.step = 1; }
      editor.value = draft[field];
      editor.setAttribute("aria-label", "Proposed " + label.toLowerCase());
      editor.addEventListener("input", () => {
        draft[field] = editor.value;
        edit.draft[field] = editor.value;
      });
      row.append(editor);
    }
    fields.append(row);
  }

  updateSave();
  section.append(fields, save, status);
  return section;
}

async function saveCorrection(correction, eventId, edit, draft) {
  if (state.busy || state.correctionBusy || correction.saved
      || (correction.decision === "INCLUDE" && !edit.chosen.size)) return;
  state.correctionBusy = true;
  edit.error = false;
  edit.message = "Saving to Apify Import…";
  updateControls();
  renderCorrections();
  try {
    if (correction.decision !== "INCLUDE") {
      await decisionRequest("save", [{ identity: correction.discovery, decision: correction.decision }]);
      edit.message = correction.decision === "EXCLUDE" ? "Excluded from future scrapes." : "Saved. This correction will carry forward.";
      return;
    }
    const response = await fetch("/admin/api", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "admin.apifycorrection.stage",
        key: correction.intakeKey,
        eventId,
        title: correction["Current title"],
        listingUrl: httpsUrl(correction["Public listing"]),
        sourceUrl: httpsUrl(correction["Instagram source"]),
        discovery: correction.discovery,
        changes: Object.fromEntries([...edit.chosen].map(field => [field, draft[field]]))
      })
    });
    const result = await response.json().catch(() => null);
    if (result?.error === "Unknown admin action.") {
      throw new Error("Saving corrections needs the updated Apps Script web app.");
    }
    if (edit.chosen.has("lineup") && /correction field is unavailable/i.test(result?.error || "")) {
      throw new Error("Lineup corrections need Core.gs v7.4.28 and a new version of the existing Apps Script deployment.");
    }
    if (!response.ok || result?.ok !== "yes" || typeof result.alreadySaved !== "boolean") {
      throw new Error(result?.error || "The correction could not be confirmed. You can retry this selection.");
    }
    edit.chosen.clear();
    correction.saved = true;
    edit.message = result.alreadySaved
      ? "This selection is already in Apify Import."
      : "Selected correction fields saved to Apify Import.";
  } catch (error) {
    edit.message = error.message || "The correction could not be confirmed. You can retry this selection.";
    edit.error = true;
  } finally {
    state.correctionBusy = false;
    updateControls();
    renderCorrections();
  }
}

function renderCorrections() {
  const corrections = state.review?.corrections ?? [];
  elements["corrections-empty"].hidden = Boolean(corrections.length);
  if (state.review) elements["corrections-empty"].textContent = "This workbook has no proposed corrections.";
  setStatus(
    elements["corrections-status"],
    state.listingStatus === "unavailable" && corrections.length
      ? "Current listings could not be loaded. Workbook corrections and source links are available." : ""
  );
  elements.corrections.replaceChildren(...corrections.map(correctionCard));
}

async function loadListings() {
  state.listingStatus = "loading";
  renderCorrections();
  try {
    const response = await fetch("/admin/post-data", { headers: { Accept: "application/json" } });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.events)) throw new Error("Current listings unavailable.");
    state.listings = new Map(data.events.filter(event => event.eventId).map(event =>
      [String(event.eventId).toUpperCase(), event]
    ));
    state.listingStatus = "ready";
  } catch {
    state.listingStatus = "unavailable";
  }
  if (!elements["corrections-view"].hidden) renderCorrections();
}

function showView() {
  const showCorrections = location.hash === "#corrections";
  elements["events-view"].hidden = showCorrections;
  elements["corrections-view"].hidden = !showCorrections;
  for (const [id, active] of [["events-tab", !showCorrections], ["corrections-tab", showCorrections]]) {
    if (active) elements[id].setAttribute("aria-current", "page");
    else elements[id].removeAttribute("aria-current");
  }
  if (showCorrections) {
    if (state.review?.corrections.length && !state.listings && state.listingStatus !== "loading") {
      void loadListings();
    } else {
      renderCorrections();
    }
  }
}

elements.workbook.addEventListener("change", loadWorkbook);
elements["save-apify"].addEventListener("click", saveSelected);
window.addEventListener("hashchange", showView);
showView();
