(() => {
  const api = window.QDPAdminProfiles;
  const ids = ["archiveRefresh", "archiveScanForm", "archiveScanFields", "archiveKind", "archiveProfile", "archiveFrom", "archiveTo",
    "archiveIncludeActive", "archiveStatus", "archiveProgress", "archiveLastScan", "archiveRetry", "archiveCounts", "archiveView",
    "archiveQuery", "archiveSelectPage", "archiveSave", "archiveClear", "archiveDraftCount", "archiveEmpty", "archiveEvents",
    "archivePrevious", "archiveNext", "archivePage", "archiveApply", "archivePublish", "archivePublishNote", "archiveRejectDetails",
    "archiveRejectStatus", "archiveRejectList", "archiveRejectPrevious", "archiveRejectNext"];
  const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const labels = { artist: "Artists", venue: "Venue", party: "Party", collective: "Collectives", classification: "Explicitly queer event" };
  let state = null, references = {}, busy = false, offset = 0, rejectOffset = 0, timer, searchTimer;
  let controls = new Map();
  const drafts = new Map();

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text != null) item.textContent = text;
    return item;
  }
  function active() {
    return ["scanning", "applying", "publishing-live", "publishing-archive"].includes(state?.job?.phase);
  }
  function locked() { return busy || active() || state?.scanInProgress; }
  function profileName(kind, id) {
    return references[kind]?.find(p => p.id === id)?.name || (kind === "classification" && id === "Yes" ? "Explicitly queer" : id);
  }
  function params() { return { offset, view: el.archiveView.value, query: el.archiveQuery.value }; }
  function status(text, error = false) { api.message(el.archiveStatus, text, error); }
  function updateButtons() {
    const lock = locked();
    el.archiveRefresh.disabled = busy;
    el.archiveScanFields.disabled = busy || active() || !state;
    el.archiveRetry.hidden = state?.job?.phase !== "failed";
    el.archiveRetry.disabled = busy;
    const canSave = drafts.size || state?.summary.approved;
    el.archiveSave.disabled = el.archiveApply.disabled = lock || !canSave;
    el.archiveSave.textContent = el.archiveApply.textContent = 'Save all changes' + (drafts.size ? ` (${drafts.size})` : '');
    el.archiveClear.disabled = lock || !drafts.size;
    el.archivePublish.disabled = lock || !state?.needsPublish || !!drafts.size;
    el.archiveDraftCount.textContent = drafts.size ? `${drafts.size} unsaved revision${drafts.size === 1 ? '' : 's'} across all result pages.` :
      'Check the revisions you approve. Unchecked suggestions stay pending.';
    const available = [...controls.values()].filter(c => c.reviewable && c.choices.length && (!c.single || c.choices.length === 1));
    const selected = available.filter(c => c.choices.every(choice => choice.checked));
    el.archiveSelectPage.disabled = lock || !available.length;
    el.archiveSelectPage.checked = !!available.length && selected.length === available.length;
    el.archiveSelectPage.indeterminate = available.some(c => c.choices.some(choice => choice.checked)) && selected.length < available.length;
    el.archivePrevious.disabled = busy || !state || offset <= 0;
    el.archiveNext.disabled = busy || !state || offset + state.pageSize >= state.totalEvents;
    for (const c of controls.values()) {
      c.fields.disabled = lock || !c.reviewable;
      c.reject.disabled = lock || !c.rejectable;
      c.reset.disabled = lock || (!c.reviewable && !drafts.has(c.proposal.key));
    }
  }
  function selectedIds(control) {
    return [...control.proposal.currentIds, ...control.choices.filter(c => c.checked).map(c => c.value)];
  }
  function showDraft(control) {
    const { proposal, choices, badge, reject } = control;
    const draft = drafts.get(proposal.key);
    const ids = draft ? (draft.decision === 'Approve' ? draft.proposedIds : []) :
      (proposal.state === 'approved' ? proposal.proposedIds : []);
    for (const choice of choices) choice.checked = ids.includes(choice.value);
    badge.textContent = draft ? (draft.decision === 'Approve' ? 'Checked · not saved' :
      draft.decision === 'Reject' ? 'Rejected · not saved' : 'Pending · not saved') :
      (proposal.state === 'approved' ? 'Approved · awaiting apply' : proposal.result);
    badge.dataset.state = draft ? 'draft' : proposal.state;
    reject.textContent = draft?.decision === 'Reject' ? 'Undo rejection' : 'Reject suggestion';
  }
  function stage(control, decision) {
    const proposal = control.proposal;
    if (decision === 'Approve' && !control.choices.some(choice => choice.checked)) {
      decision = proposal.state === 'approved' ? 'Pending' : '';
    }
    if (decision) drafts.set(proposal.key, { key: proposal.key, revision: proposal.revision, decision,
      ...(decision === 'Approve' ? { proposedIds: selectedIds(control) } : {}) });
    else drafts.delete(proposal.key);
    showDraft(control); updateButtons();
  }
  async function saveAll() {
    if (locked()) return;
    const changes = [...drafts.values()];
    if (!changes.length && !state?.summary.approved) return;
    if (changes.length > 5000) { status('Save up to 5,000 revisions at a time.', true); return; }
    if (new TextEncoder().encode(JSON.stringify({ changes })).length > 2 * 1024 * 1024) {
      status('These revisions are too large for one batch. Clear some selections and save a smaller group.', true); return;
    }
    await perform('save', { changes });
  }
  function renderProposal(proposal, event, parent) {
    const card = node("section", "archive-proposal");
    const heading = node("div", "archive-proposal-header");
    const selectLabel = node("strong", "", labels[proposal.kind]);
    const badge = node("span", "archive-result", proposal.state === "approved" ? "Approved · awaiting apply" : proposal.result);
    badge.dataset.state = proposal.state;
    heading.append(selectLabel, badge); card.append(heading);
    card.append(node("p", "archive-current", "Current: " + (proposal.currentIds.map(id => profileName(proposal.kind, id)).join(", ") || "None assigned")));
    const fields = node("fieldset", "archive-candidates"); fields.setAttribute("aria-label", "Proposed additions");
    const added = proposal.proposedIds.filter(id => !proposal.currentIds.includes(id));
    const single = ["venue", "party", "classification"].includes(proposal.kind);
    const choices = added.map(id => {
      const label = node("label", "archive-candidate");
      const input = node("input"); input.type = "checkbox";
      input.name = "candidate-" + proposal.key; input.value = id;
      input.checked = false;
      const name = node("span", "", profileName(proposal.kind, id)); name.title = id;
      label.append(input, name); fields.append(label); return input;
    });
    card.append(fields);
    const actions = node("div", "archive-actions");
    const reject = node("button", "quiet-button", "Reject suggestion"); reject.type = "button";
    const reset = node("button", "quiet-button", "Clear choices"); reset.type = "button";
    const reviewable = ["pending", "approved"].includes(proposal.state) && !event.sourceIssue;
    const rejectable = !["applied", "rejected"].includes(proposal.state);
    const control = { proposal, fields, choices, reject, reset, badge, single, reviewable, rejectable };
    controls.set(proposal.key, control);
    if (reviewable) actions.append(reset);
    if (rejectable) actions.append(reject);
    card.append(actions);
    const details = node("details", "archive-evidence"); details.append(node("summary", "", "Show matching evidence"),
      node("p", "", proposal.matched), node("p", "", proposal.evidence));
    card.append(details); parent.append(card);
    showDraft(control);
    for (const choice of choices) choice.addEventListener('change', () => {
      if (single && choice.checked) for (const other of choices) if (other !== choice) other.checked = false;
      stage(control, 'Approve');
    });
    reject.addEventListener('click', () => stage(control, drafts.get(proposal.key)?.decision === 'Reject' ? '' : 'Reject'));
    reset.addEventListener('click', () => {
      for (const choice of choices) choice.checked = false;
      stage(control, 'Approve');
    });
  }
  function dateLabel(value) {
    if (!value) return "Date unavailable";
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" })
      .format(new Date(value + "T12:00:00"));
  }
  function render(payload) {
    state = payload; offset = payload.offset;
    if (payload.references) { references = payload.references; populateProfiles(); }
    el.archiveCounts.replaceChildren(...Object.entries(payload.summary).map(([key, value]) => {
      const label = key === "blocked" ? "Needs attention" : key.charAt(0).toUpperCase() + key.slice(1);
      const item = node("div", "archive-count"); item.append(node("strong", "", String(value)), document.createTextNode(label)); return item;
    }));
    const fragment = document.createDocumentFragment(); controls = new Map();
    for (const event of payload.events) {
      const card = node("article", "archive-event"), flyer = node("div", "archive-flyer");
      let flyerUrl;
      try { const url = new URL(event.flyerUrl); if (["https:", "http:"].includes(url.protocol)) flyerUrl = url.href; } catch {}
      if (flyerUrl) {
        const image = node("img"); image.src = flyerUrl; image.alt = `Flyer for ${event.title}`;
        image.loading = "lazy"; image.referrerPolicy = "no-referrer";
        image.addEventListener("error", () => flyer.replaceChildren(node("span", "archive-no-flyer", "Flyer unavailable")), { once: true });
        flyer.append(image);
      } else flyer.append(node("span", "archive-no-flyer", "No flyer"));
      const body = node("div", "archive-event-body"); body.append(node("p", "archive-event-date", dateLabel(event.date)));
      const title = node("h3"), link = node("a", "", event.title);
      link.href = "/?event=" + encodeURIComponent(event.eventId); link.target = "_blank"; link.rel = "noopener";
      title.append(link); body.append(title, node("p", "event-id", `${event.eventId} · ${event.sheet}`));
      if (event.editUrl) {
        try {
          const url = new URL(event.editUrl);
          if (url.protocol === 'https:' && url.hostname === 'docs.google.com' && url.pathname.startsWith('/spreadsheets/')) {
            const edit = node('a', 'archive-edit-event', 'Edit event');
            edit.href = url.href; edit.target = '_blank'; edit.rel = 'noopener';
            edit.title = 'Edit this event in its source spreadsheet row';
            body.append(edit);
          }
        } catch {}
      }
      if (event.sourceIssue) body.append(node("p", "archive-result", event.sourceIssue));
      for (const proposal of event.proposals) renderProposal(proposal, event, body);
      card.append(flyer, body); fragment.append(card);
    }
    el.archiveEvents.replaceChildren(fragment);
    el.archiveEmpty.hidden = !!payload.events.length;
    el.archiveEmpty.textContent = payload.scan ? "No suggestions match this view." : "Start a scan to find missing associations in recorded events.";
    el.archivePage.textContent = payload.totalEvents ? `${offset + 1}–${Math.min(offset + payload.pageSize, payload.totalEvents)} of ${payload.totalEvents} events` : "";
    const scan = payload.scan;
    el.archiveProgress.hidden = !payload.scanInProgress;
    el.archiveProgress.max = Math.max(1, scan?.total || 1); el.archiveProgress.value = scan?.scanned || 0;
    el.archiveLastScan.textContent = scan ? `${scan.scanned.toLocaleString()} of ${scan.total.toLocaleString()} rows scanned · ${scan.proposed.toLocaleString()} suggestions` +
      (scan.finishedAt ? ` · Finished ${new Date(scan.finishedAt).toLocaleString()}` : "") : "";
    const job = payload.job;
    const messages = { scanning: "Scanning recorded events… You can leave this page; progress is saved.",
      applying: "Applying approved associations to their source records…", "publishing-live": "Publishing current event changes…",
      "publishing-archive": "Publishing the archive and profile histories…", ready: "Scan complete. Review the proposed additions below.",
      complete: "Website data published. Any suggestions that need attention remain in the review. Caches can take about a minute to refresh." };
    status(job?.phase === "failed" ? job.error : messages[job?.phase] || "Ready to scan recorded events.", job?.phase === "failed");
    el.archivePublishNote.textContent = payload.needsPublish ? "Saved archive changes are awaiting publication." :
      "Save all changes submits your checked revisions and rejections together, then applies approved revisions and publishes the website.";
    if (payload.lastPublishedAt) el.archivePublishNote.textContent += " Last published " + new Date(payload.lastPublishedAt).toLocaleString() + ".";
    updateButtons(); scheduleStep();
  }
  function scheduleStep() {
    clearTimeout(timer);
    if (active()) timer = setTimeout(() => perform("step"), 1500);
  }
  async function perform(action, data = {}, success = "") {
    if (busy) { scheduleStep(); return; }
    busy = true; updateButtons(); el.archiveEvents.setAttribute("aria-busy", "true");
    try {
      const result = await api.request("admin.archive." + action, { ...params(), ...data });
      if (action === 'save') {
        if (!Array.isArray(result.savedKeys) || data.changes.some(change => !result.savedKeys.includes(change.key))) {
          throw new Error('The save was not confirmed. Your selections have been kept; refresh to check the saved review.');
        }
        for (const key of result.savedKeys) drafts.delete(key);
      }
      if (action === 'scan') drafts.clear();
      render(result);
      if (action === 'save' && !active()) status(`${result.saved} revisions saved together.`);
      if (success) status(success);
    } catch (error) {
      let text = error.message;
      if (/Deploy the updated Core.gs|Unknown admin action/i.test(text)) {
        text = action === 'save' ? 'Install ArchiveReview.gs v7.4.19 and update the existing Apps Script deployment to save revisions together. Your selections have been kept.' :
          "Install the updated Core.gs and ArchiveReview.gs, then update the existing Apps Script deployment to use Archive Updates.";
      } else if (/Unknown archive action/i.test(text)) {
        text = 'Install ArchiveReview.gs v7.4.19 and update the existing Apps Script deployment to save revisions together. Your selections have been kept.';
      }
      status(text, true); clearTimeout(timer);
    } finally { busy = false; el.archiveEvents.setAttribute("aria-busy", "false"); updateButtons(); }
  }
  function populateProfiles() {
    const kind = el.archiveKind.value, selected = el.archiveProfile.value;
    el.archiveProfile.replaceChildren(new Option(kind ? "All " + labels[kind].toLowerCase() : "All profiles", ""));
    for (const profile of references[kind] || []) el.archiveProfile.add(new Option(profile.name, profile.id));
    el.archiveProfile.value = selected; el.archiveProfile.disabled = !kind;
  }
  el.archiveKind.addEventListener("change", () => { el.archiveProfile.value = ""; populateProfiles(); });
  el.archiveScanForm.addEventListener("submit", event => {
    event.preventDefault();
    const replaces = state && (state.summary.pending + state.summary.approved + state.summary.blocked > 0);
    if ((replaces || drafts.size) && !window.confirm("Replace the current review with a new scan? Unsaved selections will be cleared. Saved rejected matches and applied event changes will be kept.")) return;
    offset = 0;
    perform("scan", { includeActive: el.archiveIncludeActive.checked, from: el.archiveFrom.value, to: el.archiveTo.value,
      kind: el.archiveKind.value, profileId: el.archiveProfile.value, replaceReview: !!replaces });
  });
  el.archiveRefresh.addEventListener("click", () => perform("bootstrap", { references: true }));
  el.archiveRetry.addEventListener("click", () => perform("retry"));
  el.archiveView.addEventListener("change", () => { offset = 0; perform("bootstrap"); });
  el.archiveQuery.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { offset = 0; perform("bootstrap"); }, 300); });
  el.archiveSelectPage.addEventListener('change', () => {
    const checked = el.archiveSelectPage.checked;
    for (const c of controls.values()) if (c.reviewable && (!c.single || c.choices.length === 1)) {
      for (const choice of c.choices) choice.checked = checked;
      stage(c, 'Approve');
    }
  });
  el.archiveSave.addEventListener('click', saveAll);
  el.archiveApply.addEventListener('click', saveAll);
  el.archiveClear.addEventListener('click', () => { drafts.clear(); for (const c of controls.values()) showDraft(c); updateButtons(); });
  el.archivePublish.addEventListener("click", () => perform("publish"));
  el.archivePrevious.addEventListener("click", () => { offset -= state.pageSize; perform("bootstrap"); });
  el.archiveNext.addEventListener("click", () => { offset += state.pageSize; perform("bootstrap"); });

  async function loadRejects() {
    try {
      const data = await api.request("admin.archive.rejects", { rejectOffset });
      el.archiveRejectStatus.textContent = `${data.rejectedTotal} saved rejected matches`;
      el.archiveRejectList.replaceChildren(...data.rejects.map(item => {
        const row = node("div", "archive-rejected"), text = node("div");
        text.append(node("strong", "", item.title), node("p", "", `${item.eventId} · ${item.field} · ${item.value}`));
        const button = node("button", "quiet-button", "Restore"); button.type = "button"; button.disabled = locked();
        button.addEventListener("click", async () => { button.disabled = true; await perform("restore", { key: item.key }, "Match restored. It can appear on the next scan."); await loadRejects(); });
        row.append(text, button); return row;
      }));
      el.archiveRejectPrevious.disabled = rejectOffset === 0;
      el.archiveRejectNext.disabled = rejectOffset + 30 >= data.rejectedTotal;
    } catch (error) { el.archiveRejectStatus.textContent = error.message; }
  }
  el.archiveRejectDetails.addEventListener("toggle", () => { if (el.archiveRejectDetails.open) loadRejects(); });
  el.archiveRejectPrevious.addEventListener("click", () => { rejectOffset = Math.max(0, rejectOffset - 30); loadRejects(); });
  el.archiveRejectNext.addEventListener("click", () => { rejectOffset += 30; loadRejects(); });
  window.addEventListener('beforeunload', event => {
    if (drafts.size) { event.preventDefault(); event.returnValue = ''; }
  });
  perform("bootstrap", { references: true });
})();
