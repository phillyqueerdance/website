import {REVIEW_FIELDS} from './apify-workbook.js?v=20261120-daily-1';
import {downloadReview} from './discovery-export.js?v=20261123-1';

const el = Object.fromEntries(['items','status','count','view','query','refresh','previous','next','page','add','selection','run-status','coverage','export','toast'].map(id => [id, document.getElementById(id)]));
const dirty = new Map(), saving = new Map(), cards = new Map();
let rows = [], offset = 0, total = 0, busy = 0, selected = 0, viewGeneration = 0;
let listingsJob = null, toastTimer, searchTimer, coverageRaw = '{}';
const fieldLabels = {description:'Description', lineup:'Lineup', start:'Start time', end:'End time', flyer:'Flyer'};
const decisionLabels = {INCLUDE:'Included · saved', WAIT:'Waiting · saved', EXCLUDE:'Excluded · saved'};
const node = (tag, text = '', cls = '') => {
  const element = document.createElement(tag);
  element.textContent = text;
  if (cls) element.className = cls;
  return element;
};
const locked = item => ['accepted','ready','importing','imported','existing'].includes(item.status) || !!item.result?.sheetSaved;
const title = item => item.fields['Title (internal)'] || item.title || 'Untitled lead';
const editable = item => ({fields:item.fields, changes:item.changes, selectedFields:item.selectedFields, decision:item.decision, baseline:item.baseline});

function link(label, url, cls = 'discovery-listing-link') {
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:') return null;
    const anchor = node('a', label, cls);
    anchor.href = target.href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
    return anchor;
  } catch { return null; }
}
function message(element, text, state = 'info') {
  element.textContent = text;
  element.dataset.state = state;
  element.hidden = !text;
  element.setAttribute('aria-busy', String(state === 'busy'));
}
function status(text, state = 'info', notify = true) {
  message(el.status, text, state);
  if (!notify) return;
  clearTimeout(toastTimer);
  message(el.toast, text, state);
  if (state === 'success') toastTimer = setTimeout(() => { el.toast.hidden = true; }, 7000);
}
function cardMessage(ui, text, state = 'info', notify = false) {
  message(ui.message, text, state);
  if (notify) status(text + ' — ' + title(ui.item), state);
}
async function request(action, data = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch('/admin/discovery', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action, ...data}), signal:controller.signal});
    if (response.redirected || !response.headers.get('Content-Type')?.includes('application/json')) {
      throw new Error('Your Admin session needs refreshing. Sign in to QDP Admin again, then retry.');
    }
    const result = await response.json();
    if (!response.ok || result.ok !== 'yes') throw new Error(result.error || 'Discovery Review could not complete that action.');
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The request took too long. Your edits are still here. Refresh the inbox to check the saved result before retrying.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function controls() {
  el.add.disabled = !!busy || saving.size > 0 || selected === 0;
  el.refresh.disabled = el.export.disabled = !!busy || saving.size > 0;
  el.view.disabled = el.query.disabled = !!busy || saving.size > 0;
  el.previous.disabled = !!busy || saving.size > 0 || offset === 0;
  el.next.disabled = !!busy || saving.size > 0 || offset + 25 >= total;
  el.selection.textContent = selected + ' selected';
  for (const ui of cards.values()) {
    const disabled = !!busy || saving.has(ui.item.id) || locked(ui.item);
    ui.save.disabled = disabled;
    ui.editor.disabled = !!busy || locked(ui.item);
    for (const button of ui.decisions) {
      button.disabled = disabled;
      button.setAttribute('aria-pressed', String(ui.item.decision === button.dataset.decision));
    }
    if (ui.retry) ui.retry.disabled = !!busy || ui.comparing || saving.has(ui.item.id);
  }
}
function markDirty(ui) {
  dirty.set(ui.item.id, ui);
  cardMessage(ui, 'Unsaved changes');
}
function comparisonChanged(ui) {
  const baseline = ui.item.baseline;
  return !!baseline && !!ui.current && Object.keys(ui.item.changes).some(key => String(baseline.fields?.[key] || '') !== String(ui.current.fields?.[key] || ''));
}
function comparisonNote(ui) {
  if (!ui.current) return;
  const changed = comparisonChanged(ui);
  message(ui.comparisonStatus, changed ? 'The QDP listing changed since this proposal was saved. Compare it below, then save Include again to confirm.' : 'Current QDP listing loaded. Choose the fields you want to apply.', changed ? 'warning' : 'info');
}
function save(ui, {decision, notify = false} = {}) {
  const item = ui.item;
  if (decision) item.decision = decision;
  dirty.set(item.id, ui);
  const progress = decision ? 'Saving ' + decision[0] + decision.slice(1).toLowerCase() + '…' : 'Saving edits…';
  cardMessage(ui, progress, 'busy', notify);
  const previous = saving.get(item.id) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    try {
      if (item.kind === 'correction' && item.decision === 'INCLUDE') {
        if (!item.selectedFields.length) throw new Error('Choose at least one correction field to apply, then select Include.');
        if (ui.comparing || !ui.current) {
          cardMessage(ui, 'Loading the current QDP listing before saving Include…', 'busy', notify);
          await loadComparisons();
        }
        if (!ui.current) throw new Error('The current QDP listing is unavailable. Retry the comparison before choosing Include. Wait and Exclude can still be saved.');
        item.baseline = ui.current;
      }
      const submitted = JSON.stringify(editable(item));
      const result = await request('save', {id:item.id, version:item.version, ...JSON.parse(submitted)});
      const saved = result.item;
      if (!saved || saved.id !== item.id || !Number.isInteger(saved.version) || saved.version <= item.version || saved.decision !== JSON.parse(submitted).decision) {
        throw new Error('The save was not confirmed. Your edits are still here; refresh to check the saved result.');
      }
      const unchanged = JSON.stringify(editable(item)) === submitted;
      item.version = saved.version;
      ui.savedDecision = saved.decision;
      if (unchanged) { Object.assign(item, saved); dirty.delete(item.id); }
      else { item.status = saved.status; item.error = saved.error; item.result = saved.result; }
      ui.error.hidden = true;
      const done = unchanged ? (decision ? decisionLabels[decision] : 'Edits saved') : 'Saved. Your newer edits still need saving.';
      cardMessage(ui, done, unchanged ? 'success' : 'info', notify);
      comparisonNote(ui);
      try { await refreshSummary(); }
      catch (error) { status('Your change was saved, but the selection count could not refresh. ' + error.message, 'error'); }
    } catch (error) {
      if (decision) item.decision = ui.savedDecision;
      cardMessage(ui, 'Not saved: ' + error.message, 'error', true);
      throw error;
    }
  });
  saving.set(item.id, operation);
  controls();
  const finish = () => { if (saving.get(item.id) === operation) saving.delete(item.id); controls(); };
  operation.then(finish, finish);
  return operation;
}
function field(ui, definition) {
  const label = node('label', definition.label, 'field' + (definition.wide ? ' apify-wide' : ''));
  const input = node(definition.type === 'textarea' ? 'textarea' : definition.type === 'yes-no' ? 'select' : 'input');
  if (input.tagName === 'SELECT') for (const value of ['', 'Yes', 'No']) {
    const option = node('option', value || 'Unspecified'); option.value = value; input.append(option);
  }
  else if (input.tagName === 'INPUT') input.type = ['date','time'].includes(definition.type) ? definition.type : 'text';
  if (input.type === 'time') input.step = 1;
  input.value = ui.item.fields[definition.name] || '';
  input.setAttribute('aria-label', definition.label + ' · ' + title(ui.item));
  if (ui.item.fields[definition.name] && !input.value) { input.type = 'text'; input.value = ui.item.fields[definition.name]; }
  input.addEventListener('input', () => { ui.item.fields[definition.name] = input.value; markDirty(ui); });
  input.addEventListener('change', () => save(ui).catch(() => {}));
  label.append(input);
  return label;
}
function dateLabel(date) {
  if (!date) return 'Date unconfirmed';
  try { return new Intl.DateTimeFormat('en-US', {weekday:'short', month:'short', day:'numeric', year:'numeric', timeZone:'UTC'}).format(new Date(date + 'T12:00:00Z')); }
  catch { return date; }
}
function timeLabel(value) {
  if (!value) return 'Not listed';
  try { return new Intl.DateTimeFormat('en-US', {weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', timeZone:'America/New_York', timeZoneName:'short'}).format(new Date(value)); }
  catch { return value; }
}
function localTime(value) {
  if (!value || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return value;
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'}).formatToParts(new Date(value));
  const read = key => parts.find(part => part.type === key)?.value;
  return `${read('year')}-${read('month')}-${read('day')}T${read('hour')}:${read('minute')}:${read('second')}`;
}
function flyer(url, label) {
  const figure = node('figure', '', 'discovery-flyer');
  const image = node('img'); image.alt = label; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
  image.src = '/admin/flyer?url=' + encodeURIComponent(url);
  const caption = node('figcaption', 'Flyer preview unavailable. Open the URL to view it.'); caption.hidden = true;
  image.addEventListener('error', () => { image.hidden = true; caption.hidden = false; });
  figure.append(image, caption);
  return figure;
}
function renderCurrent(ui) {
  for (const [key, element] of ui.currentCells) {
    const value = ui.current?.fields?.[key];
    element.replaceChildren();
    if (key === 'flyer' && value) {
      element.append(flyer(value, 'Current QDP flyer'));
      const url = link(value, value, 'discovery-url'); if (url) element.append(url);
    } else element.append(node('p', key === 'start' || key === 'end' ? timeLabel(value) : value || 'Not listed'));
  }
  comparisonNote(ui);
}
function loadComparisons(force = false) {
  if (listingsJob && !force) return listingsJob;
  const targets = [...cards.values()].filter(ui => ui.item.kind === 'correction');
  if (!targets.length) return Promise.resolve();
  const generation = viewGeneration;
  for (const ui of targets) {
    ui.comparing = true;
    message(ui.comparisonStatus, 'Loading the current QDP listing…', 'busy');
    for (const element of ui.currentCells.values()) message(element, 'Loading current listing…', 'busy');
  }
  controls();
  const job = request('listings', {eventIds:[...new Set(targets.map(ui => ui.item.eventId))]}).then(data => {
    if (generation !== viewGeneration) return;
    const byId = new Map(data.events.map(event => [event.eventId.toUpperCase(), event]));
    for (const ui of targets) {
      ui.current = byId.get(ui.item.eventId.toUpperCase()) || null;
      if (ui.current) {
        for (const element of ui.currentCells.values()) { element.dataset.state = 'info'; element.setAttribute('aria-busy', 'false'); }
        renderCurrent(ui);
      } else {
        message(ui.comparisonStatus, 'This event was not found in the current QDP Events sheet. Wait or exclude it, or check its QDP listing.', 'error');
        for (const element of ui.currentCells.values()) message(element, 'Listing not found', 'error');
      }
    }
  }).catch(error => {
    if (generation === viewGeneration) for (const ui of targets) {
      ui.current = null;
      message(ui.comparisonStatus, 'Could not load the current listing. ' + error.message, 'error');
      for (const element of ui.currentCells.values()) message(element, 'Current listing unavailable. Use Retry comparison above.', 'error');
    }
    throw error;
  }).finally(() => {
    for (const ui of targets) ui.comparing = false;
    controls();
  });
  listingsJob = job;
  return job;
}
function correctionEditor(ui) {
  const {item, editor} = ui;
  editor.classList.add('discovery-correction-editor');
  if (item.note) editor.append(node('p', item.note, 'discovery-correction-note'));
  const comparison = node('div', '', 'discovery-comparison-status');
  ui.comparisonStatus = node('p', 'Loading the current QDP listing…');
  ui.comparisonStatus.setAttribute('role', 'status'); ui.comparisonStatus.setAttribute('aria-live', 'polite');
  ui.retry = node('button', 'Refresh comparison', 'discovery-button'); ui.retry.type = 'button';
  ui.retry.addEventListener('click', async () => {
    const label = ui.retry.textContent; ui.retry.textContent = 'Refreshing…'; ui.retry.setAttribute('aria-busy', 'true');
    status('Refreshing current QDP comparisons…', 'busy');
    try { await loadComparisons(true); status('Current QDP comparisons refreshed.', 'success'); }
    catch (error) { status('Comparison refresh failed: ' + error.message, 'error'); }
    finally { ui.retry.textContent = label; ui.retry.setAttribute('aria-busy', 'false'); controls(); }
  });
  comparison.append(ui.comparisonStatus, ui.retry); editor.append(comparison);
  for (const [key, value] of Object.entries(item.changes)) {
    const row = node('section', '', 'discovery-change'); row.dataset.field = key;
    const heading = node('div', '', 'discovery-change-heading');
    heading.append(node('h3', fieldLabels[key] || key));
    const apply = node('label', '', 'discovery-apply'), checkbox = node('input');
    checkbox.type = 'checkbox'; checkbox.checked = item.selectedFields.includes(key);
    checkbox.setAttribute('aria-label', 'Apply ' + (fieldLabels[key] || key) + ' · ' + title(item));
    apply.append(checkbox, node('span', 'Apply change')); heading.append(apply);
    const columns = node('div', '', 'discovery-compare');
    const current = node('div', '', 'discovery-current'), proposed = node('div', '', 'discovery-proposed');
    current.append(node('p', 'Current QDP listing', 'discovery-column-label'));
    const currentValue = node('div', 'Loading current listing…', 'discovery-current-value');
    ui.currentCells.set(key, currentValue); current.append(currentValue);
    proposed.append(node('p', 'Recommended change', 'discovery-column-label'));
    const input = node(key === 'start' || key === 'end' || key === 'flyer' ? 'input' : 'textarea');
    input.setAttribute('aria-label', 'Proposed ' + (fieldLabels[key] || key) + ' · ' + title(item));
    if (key === 'start' || key === 'end') {
      input.type = 'datetime-local'; input.step = 1;
      item.changes[key] = localTime(value); input.value = item.changes[key];
    } else { if (key === 'flyer') input.type = 'url'; input.value = value; }
    if (key === 'flyer' && value) proposed.append(flyer(value, 'Recommended flyer'));
    proposed.append(input);
    checkbox.addEventListener('change', () => {
      item.selectedFields = checkbox.checked ? [...new Set([...item.selectedFields, key])] : item.selectedFields.filter(field => field !== key);
      markDirty(ui); save(ui, {notify:true}).catch(() => {});
    });
    input.addEventListener('input', () => { item.changes[key] = input.value; markDirty(ui); });
    input.addEventListener('change', () => save(ui).catch(() => {}));
    columns.append(current, proposed); row.append(heading, columns); editor.append(row);
  }
  if (!Object.keys(item.changes).length) editor.append(node('p', 'No correction fields were supplied for this lead. You can keep it with Wait or exclude it.', 'apify-muted'));
}
function eventEditor(ui) {
  const primary = REVIEW_FIELDS.filter(field => field.type !== 'link' && !['Timezone','Review_notes'].includes(field.name));
  for (const definition of primary) ui.editor.append(field(ui, definition));
  ui.editor.append(field(ui, {name:'Review_notes', label:'Review notes', type:'textarea', wide:true}));
  const more = node('details', '', 'discovery-more'); more.append(node('summary', 'Links & IDs'));
  const fields = node('div', '', 'discovery-more-fields');
  for (const definition of [
    {name:'Timezone', label:'Time zone'}, {name:'Event_URL', label:'Event URL', wide:true},
    {name:'Instagram_URL', label:'Instagram URL', wide:true}, {name:'RawFlyerURL', label:'Original flyer image URL', wide:true},
    {name:'VenueID', label:'Venue ID'}, {name:'ArtistIDs (comma-separated)', label:'Artist IDs'},
    {name:'PartyID', label:'Party ID'}, {name:'HostCollectiveIDs (comma-separated)', label:'Collective IDs'}
  ]) fields.append(field(ui, definition));
  more.append(fields); ui.editor.append(more);
}
function card(item) {
  const article = node('article', '', 'apify-card'); article.dataset.kind = item.kind; article.dataset.id = item.id;
  const heading = node('div', '', 'apify-card-header'), summary = node('div', '', 'discovery-card-title');
  const type = node('div', item.kind === 'correction' ? 'Listing correction' : 'New event', 'discovery-card-type');
  if (item.isNew || item.isUpdated) type.append(node('span', item.isUpdated ? 'Updated' : 'New', 'discovery-badge'));
  summary.append(type, node('h2', title(item)), node('p', [dateLabel(item.date), item.fields.Location].filter(Boolean).join(' · '), 'discovery-card-meta'));
  const state = item.status === 'ready' ? 'Saved to Events and Calendar; website refresh pending.' : item.status === 'accepted' ? 'Prepared for Calendar. Add selected to QDP will finish the remaining steps.' : item.status === 'imported' ? 'Website refresh completed.' : item.status === 'existing' ? 'Already present in QDP.' : item.status === 'importing' ? 'Import is processing. Refresh to check its result.' : item.readiness || '';
  if (state) summary.append(node('p', state, 'discovery-card-status'));
  heading.append(summary); article.append(heading);
  const ui = {item, article, savedDecision:item.decision, current:null, currentCells:new Map(), decisions:[], comparing:false};
  ui.message = node('p', locked(item) ? 'Saved to QDP' : decisionLabels[item.decision] || 'Choose a review decision', 'discovery-save-status');
  ui.message.setAttribute('role', 'status'); ui.message.setAttribute('aria-live', 'polite');
  const bar = node('div', '', 'discovery-decision-bar'), choices = node('fieldset', '', 'apify-decisions');
  choices.append(node('legend', 'Review decision'));
  for (const decision of ['INCLUDE','WAIT','EXCLUDE']) {
    const button = node('button', decision[0] + decision.slice(1).toLowerCase(), 'apify-decision');
    button.type = 'button'; button.dataset.decision = decision;
    button.setAttribute('aria-pressed', String(item.decision === decision));
    button.addEventListener('click', async () => {
      const label = button.textContent; button.textContent = 'Saving…'; button.setAttribute('aria-busy', 'true');
      try { await save(ui, {decision, notify:true}); }
      catch { /* The card and persistent notice retain the exact error. */ }
      finally { button.textContent = label; button.setAttribute('aria-busy', 'false'); controls(); }
    });
    choices.append(button); ui.decisions.push(button);
  }
  bar.append(choices, ui.message); article.append(bar);
  ui.error = node('p', item.error || '', 'discovery-notice discovery-error'); ui.error.hidden = !item.error;
  article.append(ui.error);
  const layout = node('div', '', 'apify-review-layout'), media = node('div', '', 'apify-media');
  const image = item.fields.Flyer_URL || item.fields.RawFlyerURL || item.changes.flyer;
  if (image && item.kind === 'event') media.append(flyer(image, title(item) + ' flyer'));
  const source = item.sourceUrl || item.fields.Instagram_URL || item.fields.Event_URL;
  const sourceBox = link(source, source, 'discovery-url'); if (sourceBox) media.append(sourceBox);
  const listing = item.listingUrl || (item.kind === 'correction' && item.eventId ? location.origin + '/?event=' + encodeURIComponent(item.eventId) : '');
  const publicLink = link('QDP listing', listing); if (publicLink) media.append(publicLink);
  if (item.result?.eventId) { const edit = link('Edit accepted event', location.origin + '/admin/?editEvent=' + encodeURIComponent(item.result.eventId) + '#events'); if (edit) media.append(edit); }
  ui.editor = node('fieldset', '', 'apify-editor'); ui.editor.disabled = locked(item);
  if (item.kind === 'correction') correctionEditor(ui); else eventEditor(ui);
  ui.save = node('button', 'Save edits', 'discovery-button'); ui.save.type = 'button';
  ui.save.addEventListener('click', async () => {
    ui.save.textContent = 'Saving…'; ui.save.setAttribute('aria-busy', 'true');
    try { await save(ui, {notify:true}); }
    catch { /* Displayed by save. */ }
    finally { ui.save.textContent = 'Save edits'; ui.save.setAttribute('aria-busy', 'false'); controls(); }
  });
  const saveRow = node('div', '', 'discovery-save-row'); saveRow.append(ui.save, node('span', 'Edits also save when you leave a field.', 'discovery-save-hint'));
  ui.editor.append(saveRow); layout.append(media, ui.editor); article.append(layout);
  cards.set(item.id, ui);
  return article;
}
function renderCoverage(coverage) {
  coverageRaw = JSON.stringify(coverage || {}, null, 2);
  el.coverage.replaceChildren();
  const entries = [];
  const read = (object, prefix = '') => {
    for (const [key, value] of Object.entries(object || {})) {
      const label = (prefix ? prefix + ' · ' : '') + key.replace(/[_-]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
      if (value && typeof value === 'object' && !Array.isArray(value)) read(value, label);
      else entries.push([label, Array.isArray(value) ? value.length + ' recorded' : String(value ?? 'Not recorded')]);
    }
  };
  read(coverage);
  if (!entries.length) { el.coverage.append(node('p', 'No coverage details recorded for the latest review.', 'apify-muted')); return; }
  const list = node('dl', '', 'discovery-coverage-list');
  for (const [label, value] of entries.slice(0, 50)) list.append(node('dt', label), node('dd', value));
  el.coverage.append(list);
}
async function refreshSummary() {
  const data = await request('bootstrap');
  selected = data.counts.selected || 0;
  const run = data.runs[0];
  el['run-status'].textContent = run ? 'Latest review · ' + dateLabel(run.day) + ' · ' + run.status.replace(/[_-]/g, ' ') : 'Your saved backlog is ready.';
  renderCoverage(data.checkpoint?.value?.coverage || run?.data?.coverage || {});
  controls();
}
async function load() {
  busy++; controls(); el.items.setAttribute('aria-busy', 'true');
  status('Loading discoveries…', 'busy', false);
  try {
    const data = await request('items', {view:el.view.value, query:el.query.value, offset});
    rows = data.items; total = data.total; cards.clear(); viewGeneration++; listingsJob = null;
    el.items.replaceChildren(...rows.map(card));
    if (!rows.length) {
      const empty = node('div', '', 'discovery-empty'); empty.append(node('h2', 'Nothing in this view'), node('p', 'Try another view or clear your search.')); el.items.append(empty);
    }
    el.count.textContent = total + ' ' + el.view.options[el.view.selectedIndex].text.toLowerCase() + ' item' + (total === 1 ? '' : 's');
    el.page.textContent = total ? (offset + 1) + '–' + Math.min(offset + 25, total) + ' of ' + total : 'No items';
    void loadComparisons().catch(() => {});
    await refreshSummary();
    status('', 'info', false);
  } catch (error) { status('Could not load the inbox: ' + error.message, 'error'); throw error; }
  finally { busy--; el.items.setAttribute('aria-busy', 'false'); controls(); }
}
async function flushEdits() {
  await Promise.all([...saving.values()]);
  for (const ui of [...dirty.values()]) await save(ui);
}
async function action(button, label, work) {
  busy++; const original = button.textContent; button.textContent = label; button.setAttribute('aria-busy', 'true'); controls();
  status(label, 'busy');
  try { await work(); }
  catch (error) { status(error.message, 'error'); }
  finally { busy--; button.textContent = original; button.setAttribute('aria-busy', 'false'); controls(); }
}
el.add.addEventListener('click', () => action(el.add, 'Adding selected items…', async () => {
  await flushEdits();
  const selection = await request('selected'), ids = new Set(), errors = [], warnings = [], completed = new Set(), calendar = [];
  if (!selection.items.length) { await refreshSummary(); status('No saved Include selections are ready to add.', 'info'); return; }
  const options = await request('import-options');
  const batchSize = options.phased ? 20 : 5;
  const collect = (data, preparing = false) => {
    for (const result of data.results) {
      if (result.warning) warnings.push(result.warning);
      if (result.error) errors.push(result.error);
      else if (result.needsCalendar) {
        if (!preparing) throw new Error('Calendar creation is still pending. Refresh before retrying the saved selection.');
        if (!Number.isInteger(result.version)) throw new Error('The saved row revision was not confirmed. Refresh before retrying.');
        calendar.push({id:result.id, version:result.version});
      } else { completed.add(result.id); if (result.needsPublish) ids.add(result.id); }
    }
  };
  // Finish every Sheet batch before starting any Calendar creation batch.
  for (let index = 0; index < selection.items.length; index += batchSize) {
    status((options.phased ? '1 of 3 · Saving event rows: ' : 'Adding selected items: ') + index + ' of ' + selection.items.length + ' checked…', 'busy');
    collect(await request('import', {items:selection.items.slice(index, index + batchSize), ...(options.phased ? {phase:'sheet'} : {})}), options.phased);
  }
  for (let index = 0; index < calendar.length; index += batchSize) {
    status('2 of 3 · Creating Calendar events and applying corrections: ' + index + ' of ' + calendar.length + ' checked…', 'busy');
    collect(await request('import', {phase:'calendar',items:calendar.slice(index, index + batchSize)}));
  }
  if (ids.size) {
    status(options.phased ? '3 of 3 · Matching IDs with one Calendar Pull, then refreshing QDP…' : 'Refreshing QDP for ' + ids.size + ' item(s)…', 'busy');
    await request('publish', {ids:[...ids]});
  }
  await load();
  status(completed.size + ' item(s) completed.' + (errors.length ? '\n' + errors.length + ' need attention:\n' + [...new Set(errors)].join('\n') : '') + (warnings.length ? '\n' + [...new Set(warnings)].join('\n') : '') + (options.notice ? '\n' + options.notice : ''), errors.length ? 'error' : 'success');
}));
el.refresh.addEventListener('click', () => action(el.refresh, 'Refreshing inbox…', async () => {
  await flushEdits(); await load(); status('Inbox refreshed.', 'success');
}));
el.view.addEventListener('change', () => action(el.refresh, 'Loading view…', async () => {
  await flushEdits(); offset = 0; await load(); status('View updated.', 'success');
}));
el.query.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => action(el.refresh, 'Searching…', async () => {
    await flushEdits(); offset = 0; await load(); status(total + ' matching item(s).', 'success');
  }), 350);
});
for (const [button, direction] of [[el.previous, -1], [el.next, 1]]) button.addEventListener('click', () => action(button, 'Loading…', async () => {
  await flushEdits(); offset = Math.max(0, offset + direction * 25); await load(); status('Page loaded.', 'success');
}));
el.export.addEventListener('click', () => action(el.export, 'Preparing Excel…', async () => {
  await flushEdits(); const all = []; let page = 0, count;
  do {
    status('Preparing Excel: ' + all.length + ' item(s) collected…', 'busy');
    const data = await request('items', {view:el.view.value, query:el.query.value, offset:page, limit:50});
    all.push(...data.items); count = data.total; page += 50;
  } while (page < count);
  downloadReview(all, coverageRaw); status('Excel ready. Your download has started.', 'success');
}));
window.addEventListener('beforeunload', event => { if (dirty.size || saving.size) { event.preventDefault(); event.returnValue = ''; } });
load().catch(() => {});
