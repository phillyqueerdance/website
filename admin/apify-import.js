import { readScrapeWorkbook, REVIEW_FIELDS } from "./apify-workbook.js?v=20261116-corrections-1";
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
  const buttons = ["INCLUDE", "EXCLUDE"].map(decision => {
    const button = element("button", "apify-decision", decision);
    button.type = "button";
    button.dataset.decision = decision;
    button.addEventListener("click", () => {
      candidate.decision = candidate.decision === decision ? "" : decision;
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

function updateControls() {
  const selected = selectedCandidates();
  const withoutFlyer = selected.filter(candidate => !candidate.fields.RawFlyerURL.trim()).length;
  elements.workbook.disabled = state.busy || state.correctionBusy;
  elements["save-apify"].disabled = state.busy || !selected.length;
  elements["save-count"].textContent = selected.length + (selected.length === 1 ? " event" : " events")
    + " selected" + (withoutFlyer ? " · " + withoutFlyer + " without a flyer" : "");
  for (const { candidate, article, decisions, buttons, editor, saved } of state.controls) {
    article.dataset.decision = candidate.decision;
    decisions.hidden = candidate.saved;
    saved.hidden = !candidate.saved;
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
    state.review = await readScrapeWorkbook(file);
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
    showView();
  } catch (error) {
    setStatus(elements["workbook-status"], error.message || "The workbook could not be opened.", true);
  } finally {
    elements.workbook.value = "";
    state.busy = false;
    updateControls();
  }
}

async function saveSelected() {
  const selected = selectedCandidates();
  if (!selected.length || state.busy) return;
  state.busy = true;
  updateControls();
  setStatus(elements["save-status"], "Saving to Apify Import…");
  try {
    const response = await fetch("/admin/api", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "admin.apifyimport",
        rows: selected.map(({ key, fields }) => ({ key, fields }))
      })
    });
    const result = await response.json().catch(() => null);
    if (result?.error === "Unknown admin action.") {
      throw new Error("Apify Import needs the updated Apps Script web app deployment.");
    }
    if (!response.ok || result?.ok !== "yes"
      || result.added + result.alreadySaved !== selected.length) {
      throw new Error(result?.error || "The save could not be confirmed. You can retry this selection.");
    }
    for (const candidate of selected) candidate.saved = true;
    const detail = [
      result.added ? result.added + " saved to Apify Import." : "",
      result.alreadySaved ? result.alreadySaved + " already in Apify Import." : ""
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

  const compare = element("div", "apify-compare");
  const current = element("section", "apify-comparison apify-current");
  current.append(element("h3", "", "Current QDP listing"));
  const eventId = publicEventId(correction["Public listing"]);
  const published = state.listings?.get(eventId);
  const index = state.correctionEdits.get(correction)?.review?.index;
  const live = index ? { ...published, ...index, flyerUrl: index.flyer || published?.flyerUrl } : published;
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
  if (correction.RawFlyerURL) proposed.append(flyerPreview(correction.RawFlyerURL, "Proposed flyer"));
  compare.append(current, proposed);
  article.append(heading, compare);
  if (correction["Apply to existing event only"]) {
    article.append(element("p", "apify-correction-note", correction["Apply to existing event only"]));
  }
  if (eventId) article.append(correctionEditor(correction, eventId));
  return article;
}

const CORRECTION_OPTIONS = [
  ["description", "Description"],
  ["start", "Start date and time"],
  ["end", "End date and time"],
  ["flyer", "Flyer"]
];

function correctionValueLabel(value, field) {
  if (!value) return "Blank";
  if (field !== "start" && field !== "end") return value;
  if (!value.includes("T")) return sheetDate(value) + " (all day)";
  const instant = new Date(value);
  return Number.isFinite(+instant) ? localDay.format(instant) + " · " + localTime.format(instant) : value;
}

function correctionEditor(correction, eventId) {
  let edit = state.correctionEdits.get(correction);
  if (!edit) {
    edit = { chosen: new Set(), draft: null, review: null, message: "", error: false, busy: false };
    state.correctionEdits.set(correction, edit);
  }

  const section = element("section", "apify-correction-editor");
  const actions = element("div", "apify-correction-actions");
  const status = element("p", "apify-status");
  status.setAttribute("role", "status");
  setStatus(status, edit.message, edit.error);

  function button(label, handler, primary = false) {
    const control = element("button", primary ? "save-all-button" : "apify-decision", label);
    control.type = "button";
    control.disabled = state.busy || state.correctionBusy;
    control.addEventListener("click", handler);
    return control;
  }
  actions.append(button(edit.review ? "Refresh values" : "Review changes", () =>
    void runCorrection(correction, eventId, edit, "review")
  ));
  if (!edit.review) {
    section.append(actions, status);
    return section;
  }

  const pending = edit.review.pendingFields;
  const isPending = pending.length > 0;
  const fields = element("fieldset", "apify-correction-fields");
  fields.disabled = edit.busy;
  fields.append(element("legend", "", isPending ? "Pending correction" : "Choose changes to apply"));
  fields.append(element("p", "apify-muted", isPending
    ? "Review the Index and Calendar values below before finishing the earlier approval."
    : "Check each field you want to apply. Times use Philadelphia time."));
  if (edit.review.calendarMessage) fields.append(element("p", "apify-muted", edit.review.calendarMessage));

  const apply = button(isPending ? "Finish pending correction" : "Apply checked changes", () =>
    void runCorrection(correction, eventId, edit, isPending ? "finish" : "apply"), true
  );
  function updateApply() {
    apply.disabled = state.busy || state.correctionBusy || (!isPending && !edit.chosen.size);
  }
  for (const [field, label] of CORRECTION_OPTIONS) {
    if (isPending ? !pending.includes(field) : field === "flyer" && !edit.draft.flyer) continue;
    const row = element("div", "apify-correction-choice");
    const header = element("label", "apify-correction-label");
    if (!isPending) {
      const toggle = element("input");
      toggle.type = "checkbox";
      toggle.checked = edit.chosen.has(field);
      toggle.disabled = !edit.review.available[field];
      toggle.addEventListener("change", () => {
        if (toggle.checked) edit.chosen.add(field);
        else edit.chosen.delete(field);
        updateApply();
      });
      header.append(toggle);
    }
    header.append(element("span", "", label));
    row.append(header);

    const index = edit.review.index[field];
    const calendar = edit.review.calendar?.[field];
    if (isPending || (calendar !== undefined && calendar !== index)) {
      if (field === "flyer") {
        const link = openLink("Current Index flyer", index);
        if (link) row.append(link);
      } else {
        row.append(element("p", "apify-correction-value", "Index · " + correctionValueLabel(index, field)));
        if (calendar !== undefined) {
          row.append(element("p", "apify-correction-value", "Calendar · " + correctionValueLabel(calendar, field)));
        }
      }
    }
    if (!isPending && edit.review.available[field]) {
      if (field === "flyer") {
        const link = openLink("Open replacement flyer", edit.draft.flyer);
        if (link) row.append(link);
      } else {
        const editor = element(field === "description" ? "textarea" : "input");
        if (field === "description") editor.rows = 3;
        else { editor.type = "datetime-local"; editor.step = 1; }
        editor.value = edit.draft[field];
        editor.setAttribute("aria-label", "Proposed " + label.toLowerCase());
        editor.addEventListener("input", () => { edit.draft[field] = editor.value; });
        row.append(editor);
      }
    }
    fields.append(row);
  }
  updateApply();
  actions.append(apply);
  section.append(fields, actions, status);
  return section;
}

async function correctionRequest(action, body) {
  const response = await fetch("/admin/api", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "admin.apifycorrection." + action, ...body })
  });
  const result = await response.json().catch(() => null);
  if (result?.error === "Unknown admin action.") {
    throw new Error("Applying corrections needs the updated Apps Script web app.");
  }
  if (!response.ok || result?.ok !== "yes" || !result.review) {
    throw new Error(result?.error || "The correction request could not be confirmed.");
  }
  return result;
}

function updateCorrectionReview(correction, edit, review) {
  edit.review = review;
  if (!edit.draft) {
    const suggested = suggestedCorrectionTimes(correction, review.localTime);
    edit.draft = {
      description: correction["Suggested Description"] || review.index.description,
      start: suggested.start || review.localTime.start,
      end: suggested.end || review.localTime.end,
      flyer: httpsUrl(correction.RawFlyerURL)
    };
  }
  for (const field of edit.chosen) {
    if (!review.available[field]) edit.chosen.delete(field);
  }
}

async function runCorrection(correction, eventId, edit, action) {
  if (state.busy || state.correctionBusy) return;
  const changes = Object.fromEntries([...edit.chosen].map(field => [field, edit.draft[field]]));
  const revisions = edit.review?.revisions;
  if (action === "apply" && !Object.keys(changes).length) return;
  state.correctionBusy = true;
  edit.busy = true;
  edit.error = false;
  edit.message = action === "review" ? "Checking the Index and Calendar…" : "Applying the selected fields…";
  updateControls();
  renderCorrections();
  try {
    const result = await correctionRequest(action, action === "apply"
      ? { eventId, changes, revisions } : { eventId });
    updateCorrectionReview(correction, edit, result.review);
    if (action !== "review") edit.chosen.clear();
    edit.message = result.message || "";
  } catch (error) {
    edit.message = error.message || "The correction could not be confirmed.";
    edit.error = true;
    if (action !== "review") {
      // Check for a pending write after a lost or failed response. Reading the
      // latest values never approves or retries the correction.
      try {
        const latest = await correctionRequest("review", { eventId });
        if (!latest.review.pendingFields.length) {
          for (const field of edit.chosen) {
            if (revisions?.[field] !== latest.review.revisions[field]) edit.chosen.delete(field);
          }
        }
        updateCorrectionReview(correction, edit, latest.review);
      } catch {}
    }
  } finally {
    edit.busy = false;
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
