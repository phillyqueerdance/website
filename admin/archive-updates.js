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
  let controls = new Map(), eventControls = new Map(), namesByKind = {}, restoreButtons = [];
  const drafts = new Map(), eventDrafts = new Map(), expandedEditors = new Set();
  const eventKey = event => JSON.stringify([event.sheet, event.eventId]);
  const idList = value => [...new Set(String(value || '').split(',').map(id => id.trim()).filter(Boolean))];
  const dirtyCount = () => drafts.size + eventDrafts.size;

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
    return namesByKind[kind]?.get(id) || (kind === "classification" && id === "Yes" ? "Explicitly queer" : id);
  }
  function params() { return { offset, view: el.archiveView.value, query: el.archiveQuery.value,
    includeRejects: el.archiveRejectDetails.open, rejectOffset }; }
  function status(text, error = false) { api.message(el.archiveStatus, text, error); }
  function updateButtons() {
    const lock = locked();
    el.archiveRefresh.disabled = busy;
    el.archiveScanFields.disabled = busy || !state;
    el.archiveRetry.hidden = state?.job?.phase !== "failed";
    el.archiveRetry.disabled = busy;
    const count = dirtyCount(), canSave = count || state?.summary.approved || state?.unsavedRejectCount;
    el.archiveSave.disabled = el.archiveApply.disabled = lock || !canSave || state?.separatePublish !== true;
    el.archiveSave.textContent = el.archiveApply.textContent = 'Save all changes' + (count ? ` (${count})` : '');
    el.archiveClear.disabled = lock || !count;
    el.archivePublish.disabled = lock || !state?.needsPublish || !!count;
    el.archiveDraftCount.textContent = count ? `${count} unsaved change${count === 1 ? '' : 's'} across all result pages.` :
      'Check the revisions you approve, or edit events directly. Unchecked suggestions stay pending.';
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
    for (const button of restoreButtons) button.disabled = lock;
    for (const control of eventControls.values()) control.setLocked(lock);
  }
  function renderEventEditor(event, parent) {
    if (!event.record) {
      parent.append(node('p', 'archive-result', event.sourceIssue || 'Install ArchiveReview.gs v7.4.23 and update the existing deployment to edit events here.'));
      if (event.description) parent.append(node('p', 'archive-original-description', event.description));
      return;
    }
    const record = event.record, key = eventKey(record), entries = new Map(), fitDescriptions = [];
    const editor = node('fieldset', 'archive-inline-editor');
    editor.append(node('legend', '', 'Edit event'));
    const core = node('div', 'archive-inline-grid archive-inline-core'), more = node('details', 'archive-inline-more');
    more.append(node('summary', '', 'Edit IDs and other event details'));
    editor.append(core, more); parent.append(editor);
    let moreLoaded = false;
    function valueFor(field) { return eventDrafts.get(key)?.fields[field.key] ?? field.value; }
    function locationState() {
      const venue = record.fields.find(field => field.type === 'venue');
      const linked = !!(venue && (entries.get(venue.key)?.read() ?? valueFor(venue)));
      for (const entry of entries.values()) {
        entry.disabled = !!entry.field.manualLocation && linked;
        entry.input.disabled = entry.field.readOnly || entry.disabled;
      }
    }
    function changed() {
      locationState();
      const previous = eventDrafts.get(key), fields = {...previous?.fields};
      for (const [name, entry] of entries) {
        if (entry.field.readOnly || entry.disabled || entry.read() === entry.field.value) delete fields[name];
        else fields[name] = entry.read();
      }
      if (Object.keys(fields).length) eventDrafts.set(key, {sheet: record.sheet, eventId: record.eventId,
        expectedRevision: previous?.expectedRevision || record.revision, fields});
      else eventDrafts.delete(key);
      updateButtons();
    }
    function addField(field, container) {
      const multiple = ['artist', 'collective'].includes(field.type);
      const label = node(multiple ? 'div' : 'label', 'field archive-inline-field' + (field.type === 'long' || multiple ? ' archive-inline-wide' : ''));
      label.append(node('span', '', field.label));
      let input, read, reset;
      if (multiple) {
        const original = idList(field.value), selected = new Set(idList(valueFor(field)));
        input = node('fieldset', 'archive-id-picker');
        const picker = node('details'), summary = node('summary'), search = node('input'), list = node('div', 'archive-id-options');
        search.type = 'search'; search.placeholder = 'Find ' + field.label.toLowerCase();
        search.setAttribute('aria-label', 'Find ' + field.label.toLowerCase() + ' · ' + record.eventId);
        input.append(picker); picker.append(summary, search, list);
        const options = references[field.type] || [], byId = namesByKind[field.type] || new Map();
        function summarize() { summary.textContent = selected.size ? [...selected].map(id => byId.get(id) || id).join(', ') : 'Choose ' + field.label.toLowerCase(); }
        function choices() {
          if (!picker.open) return;
          const query = search.value.trim().toLowerCase();
          const matches = options.filter(option => (option.name + ' ' + option.id).toLowerCase().includes(query));
          const shown = [...new Set([...selected].filter(id => !query || ((byId.get(id) || '') + ' ' + id).toLowerCase().includes(query)).concat(matches.slice(0, 40).map(option => option.id)))];
          list.replaceChildren(...shown.map(id => {
            const row = node('label', 'archive-id-option'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(id);
            row.append(checkbox, node('span', '', (byId.get(id) || id) + ' · ' + id));
            checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(id); else selected.delete(id); summarize(); changed(); });
            return row;
          }));
          if (matches.length > 40) list.append(node('small', 'field-help', 'Type to narrow the remaining matches.'));
          if (!shown.length) list.append(node('p', 'field-help', 'No matching profiles.'));
        }
        picker.addEventListener('toggle', choices); search.addEventListener('input', choices); summarize();
        read = () => selected.size === original.length && original.every(id => selected.has(id)) ? field.value : [...selected].join(', ');
        reset = () => { selected.clear(); for (const id of original) selected.add(id); summarize(); choices(); };
      } else {
        const catalog = ['venue', 'party'].includes(field.type) ? references[field.type] || [] : null;
        const options = catalog || (field.type === 'flag' ? [{id: 'Yes', name: 'Yes'}, {id: 'No', name: 'No'}] :
          field.type === 'neighborhood' ? api.neighborhoods.map(name => ({id: name, name})) : null);
        input = node(options ? 'select' : field.type === 'long' ? 'textarea' : 'input');
        if (options) {
          const current = valueFor(field); let loaded = false;
          input.add(new Option('Unspecified', ''));
          if (current) input.add(new Option(profileName(field.type, current), current));
          if (field.value && field.value !== current) input.add(new Option(profileName(field.type, field.value), field.value));
          function populate() {
            if (loaded) return; loaded = true;
            const selected = input.value;
            for (const option of options) if (option.id !== current && option.id !== field.value) input.add(new Option(option.name, option.id));
            input.value = selected;
          }
          if (catalog) input.addEventListener('focus', populate); else populate();
        } else {
          input.maxLength = field.maxLength;
          if (field.type === 'long') input.rows = field.label === 'Description' ? 10 : 5;
          else if (field.type === 'date') input.type = /^\d{4}-\d{2}-\d{2}$/.test(field.value) || !field.value ? 'date' : 'text';
          else if (field.type === 'time') { input.type = /^\d{2}:\d{2}(?::\d{2})?$/.test(field.value) || !field.value ? 'time' : 'text'; input.step = '1'; }
          else if (field.type === 'url') input.type = 'url';
        }
        input.value = valueFor(field); read = () => input.value; reset = () => { input.value = field.value; };
        input.addEventListener('input', changed); input.addEventListener('change', changed);
        if (field.label === 'Description') {
          const fit = () => { if (input.style && input.scrollHeight) { input.style.height = 'auto'; input.style.height = Math.max(170, input.scrollHeight + 2) + 'px'; } };
          fitDescriptions.push(fit); input.addEventListener('input', fit);
        }
      }
      input.setAttribute('aria-label', field.label + ' · ' + record.eventId);
      label.append(input);
      if (field.readOnly) label.append(node('small', 'field-help', 'Calculated automatically.'));
      if (field.manualLocation) label.append(node('small', 'field-help', 'Clear the venue to enter a manual location.'));
      entries.set(field.key, {field, input, read, reset}); container.append(label);
    }
    const primary = field => ['Title', 'Description'].includes(field.label);
    for (const field of record.fields.filter(primary)) addField(field, core);
    function loadMore() {
      if (more.open) {
        expandedEditors.add(key);
        if (!moreLoaded) {
          moreLoaded = true; const grid = node('div', 'archive-inline-grid');
          for (const field of record.fields.filter(field => !primary(field))) addField(field, grid);
          more.append(grid); locationState();
        }
      } else expandedEditors.delete(key);
    }
    more.addEventListener('toggle', loadMore);
    if (expandedEditors.has(key)) { more.open = true; loadMore(); }
    locationState();
    eventControls.set(key, {setLocked: lock => { editor.disabled = lock; }, fit: () => { for (const fit of fitDescriptions) fit(); }, reset: () => {
      for (const entry of entries.values()) entry.reset(); locationState(); for (const fit of fitDescriptions) fit();
    }});
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
    if (state?.separatePublish !== true) { status('Install the v7.4.22 script replacements and update the existing Apps Script deployment before saving. Your selections have been kept.', true); return; }
    const changes = [...drafts.values()];
    const eventEdits = [...eventDrafts.values()];
    if (eventEdits.length && state?.inlineEventEdits !== true) { status('Install ArchiveReview.gs v7.4.23 and update the existing deployment before saving event edits. Your edits have been kept.', true); return; }
    if (!changes.length && !eventEdits.length && !state?.summary.approved && !state?.unsavedRejectCount) return;
    if (changes.length > 5000) { status('Save up to 5,000 revisions at a time.', true); return; }
    if (eventEdits.length > 200) { status('Save up to 200 edited events at a time.', true); return; }
    if (new TextEncoder().encode(JSON.stringify({ changes, eventEdits })).length > 2 * 1024 * 1024) {
      status('These revisions are too large for one batch. Clear some selections and save a smaller group.', true); return;
    }
    await perform('save', { changes, eventEdits });
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
    if (payload.progressOnly) { state = { ...state, ...payload }; renderProgress(state); return; }
    state = payload; offset = payload.offset;
    if (payload.references) {
      references = payload.references;
      namesByKind = Object.fromEntries(Object.entries(references).map(([kind, profiles]) => [kind, new Map(profiles.map(p => [p.id, p.name]))]));
      populateProfiles();
    }
    el.archiveCounts.replaceChildren(...Object.entries(payload.summary).map(([key, value]) => {
      const label = key === "blocked" ? "Needs attention" : key.charAt(0).toUpperCase() + key.slice(1);
      const item = node("div", "archive-count"); item.append(node("strong", "", String(value)), document.createTextNode(label)); return item;
    }));
    const fragment = document.createDocumentFragment(); controls = new Map(); eventControls = new Map();
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
      if (event.sourceIssue) body.append(node("p", "archive-result", event.sourceIssue));
      renderEventEditor(event, body);
      for (const proposal of event.proposals) renderProposal(proposal, event, body);
      card.append(flyer, body); fragment.append(card);
    }
    el.archiveEvents.replaceChildren(fragment);
    for (const control of eventControls.values()) control.fit();
    el.archiveEmpty.hidden = !!payload.events.length;
    el.archiveEmpty.textContent = payload.scan ? "No suggestions match this view." : "Start a scan to find missing associations in recorded events.";
    el.archivePage.textContent = payload.totalEvents ? `${offset + 1}–${Math.min(offset + payload.pageSize, payload.totalEvents)} of ${payload.totalEvents} events` : "";
    if (payload.rejects) renderRejects(payload);
    renderProgress(payload);
  }
  function renderProgress(payload) {
    const scan = payload.scan;
    el.archiveProgress.hidden = !payload.scanInProgress;
    el.archiveProgress.max = Math.max(1, scan?.total || 1); el.archiveProgress.value = scan?.scanned || 0;
    el.archiveLastScan.textContent = scan ? `${scan.scanned.toLocaleString()} of ${scan.total.toLocaleString()} rows scanned · ${scan.proposed.toLocaleString()} suggestions` +
      (scan.finishedAt ? ` · Finished ${new Date(scan.finishedAt).toLocaleString()}` : "") : "";
    const job = payload.job;
    const messages = { scanning: "Scanning recorded events… You can leave this page; progress is saved.",
      applying: "Applying approved associations to their source records…", "publishing-live": "Publishing current event changes…",
      "publishing-archive": "Publishing the archive and profile histories…", ready: "Scan complete. Review the proposed additions below.",
      saved: "Changes saved to the sheet. Use Publish saved changes when you’re ready to update the website.",
      complete: "Website data published. Any suggestions that need attention remain in the review. Caches can take about a minute to refresh." };
    status(job?.phase === "failed" ? job.error : messages[job?.phase] || "Ready to scan recorded events.", job?.phase === "failed");
    if (payload.separatePublish !== true) status('Install the v7.4.22 script replacements and update the existing Apps Script deployment to use separate saving and publishing.', true);
    el.archivePublishNote.textContent = payload.needsPublish ? "Saved archive changes are awaiting publication." :
      "Save all changes writes event edits, approved revisions, and rejections to the sheet. Publish saved changes updates the website separately.";
    if (payload.lastPublishedAt) el.archivePublishNote.textContent += " Last published " + new Date(payload.lastPublishedAt).toLocaleString() + ".";
    updateButtons(); scheduleStep();
  }
  function scheduleStep() {
    clearTimeout(timer);
    if (active()) timer = setTimeout(() => perform("step", { progressOnly: true }), state?.job?.leaseUntil > Date.now() ? 1500 : 250);
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
        if (data.eventEdits.length && (!Array.isArray(result.savedEventKeys) || data.eventEdits.some(edit => !result.savedEventKeys.includes(eventKey(edit))))) {
          throw new Error('The event edits were not confirmed. Your edits have been kept; refresh to check the saved records.');
        }
        for (const key of result.savedKeys) drafts.delete(key);
        for (const key of result.savedEventKeys || []) eventDrafts.delete(key);
      }
      if (action === 'scan') { drafts.clear(); eventDrafts.clear(); expandedEditors.clear(); }
      render(result);
      if (action === 'save' && !active() && result.job?.phase !== 'failed') status('Changes saved to the sheet. The website has not been published.');
      if (success) status(success);
    } catch (error) {
      let text = error.message;
      if (/Deploy the updated Core.gs|Unknown admin action/i.test(text)) {
        text = action === 'save' ? 'Install ArchiveReview.gs v7.4.22 and update the existing Apps Script deployment to save revisions together. Your selections have been kept.' :
          "Install the updated Core.gs and ArchiveReview.gs, then update the existing Apps Script deployment to use Archive Updates.";
      } else if (/Unknown archive action/i.test(text)) {
        text = 'Install ArchiveReview.gs v7.4.22 and update the existing Apps Script deployment to save revisions together. Your selections have been kept.';
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
    clearTimeout(searchTimer);
    offset = 0; el.archiveView.value = ''; el.archiveQuery.value = '';
    perform("scan", { includeActive: el.archiveIncludeActive.checked, from: el.archiveFrom.value, to: el.archiveTo.value,
      kind: el.archiveKind.value, profileId: el.archiveProfile.value });
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
  el.archiveClear.addEventListener('click', () => { drafts.clear(); eventDrafts.clear(); for (const c of controls.values()) showDraft(c);
    for (const c of eventControls.values()) c.reset(); updateButtons(); });
  el.archivePublish.addEventListener("click", () => perform("publish"));
  el.archivePrevious.addEventListener("click", () => { offset -= state.pageSize; perform("bootstrap"); });
  el.archiveNext.addEventListener("click", () => { offset += state.pageSize; perform("bootstrap"); });

  async function loadRejects() {
    try {
      const data = await api.request("admin.archive.rejects", { rejectOffset });
      renderRejects(data);
    } catch (error) { el.archiveRejectStatus.textContent = error.message; }
  }
  function renderRejects(data) {
      restoreButtons = [];
      rejectOffset = data.rejectOffset || 0;
      el.archiveRejectStatus.textContent = `${data.rejectedTotal} saved rejected matches`;
      el.archiveRejectList.replaceChildren(...data.rejects.map(item => {
        const row = node("div", "archive-rejected"), text = node("div");
        text.append(node("strong", "", item.title), node("p", "", `${item.eventId} · ${item.field} · ${item.value}`));
        const button = node("button", "quiet-button", "Restore"); button.type = "button"; button.disabled = locked();
        restoreButtons.push(button);
        button.addEventListener("click", async () => { button.disabled = true; await perform("restore", { key: item.key }, "Match restored. It can appear on the next scan."); });
        row.append(text, button); return row;
      }));
      el.archiveRejectPrevious.disabled = rejectOffset === 0;
      el.archiveRejectNext.disabled = rejectOffset + 30 >= data.rejectedTotal;
  }
  el.archiveRejectDetails.addEventListener("toggle", () => { if (el.archiveRejectDetails.open) loadRejects(); });
  el.archiveRejectPrevious.addEventListener("click", () => { rejectOffset = Math.max(0, rejectOffset - 30); loadRejects(); });
  el.archiveRejectNext.addEventListener("click", () => { rejectOffset += 30; loadRejects(); });
  window.addEventListener('beforeunload', event => {
    if (dirtyCount()) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('focus', () => { if (state && !busy && !eventDrafts.size) perform('bootstrap'); });
  perform("bootstrap", { references: true });
})();
