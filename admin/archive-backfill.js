(() => {
  const api = window.QDPAdminProfiles;
  const controls = Object.fromEntries([
    'Refresh', 'Import', 'Resume', 'Status', 'Progress', 'Originals', 'Coverage', 'Query',
    'Queue', 'State', 'Missing', 'Counts', 'Items', 'Previous', 'Next', 'Page',
    'RequestsNote', 'Requests', 'Drafts', 'Save', 'SavedChoices', 'SaveStatus', 'Publish'
  ].map(name => [name, document.getElementById('backfill' + name)]));

  const MB = 1024 * 1024;
  const PAGE_SIZE = 15;
  const IMPORT_ROWS = 500;
  const SAVE_ROWS = 24;
  const SAVE_FLYERS = 8;
  const encoder = new TextEncoder();
  const fieldLabels = {
    'Title (internal)': 'Title', StartDate: 'Start date', EndDate: 'End date',
    StartTime: 'Start time', EndTime: 'End time', Timezone: 'Time zone',
    'ExplicitQueer (Yes/No)': 'Explicitly queer', VenueID: 'Venue ID',
    'ArtistIDs (comma-separated)': 'Artist IDs', PartyID: 'Party ID',
    'HostCollectiveIDs (comma-separated)': 'Collective IDs', Description: 'Update description',
    Event_URL: 'Event link', Instagram_URL: 'Instagram link', RawFlyerURL: 'Source flyer link'
  };
  const state = {
    workspace: null, offset: 0, busy: false, importJob: null, drafts: new Map(), errors: new Map(),
    originals: new Map(), chosenFiles: new Map(), objectUrls: new Map(), searchCache: new Map()
  };
  let searchTimer;

  function node(tag, cls, value) {
    const element = document.createElement(tag);
    if (cls) element.className = cls;
    if (value != null) element.textContent = value;
    return element;
  }
  function button(label, listener, cls = 'quiet-button') {
    const element = node('button', cls, label);
    element.type = 'button';
    element.addEventListener('click', listener);
    return element;
  }
  function link(label, url) {
    try {
      const parsed = new URL(url, window.location.origin);
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error();
      const element = node('a', 'admin-page-link', label);
      element.href = parsed.href;
      element.target = '_blank';
      element.rel = 'noopener noreferrer';
      return element;
    } catch {
      return node('span', '', label);
    }
  }
  function normalized(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/\s+/g, ' ').trim();
  }
  const targetKey = ({sheet, eventId}) => JSON.stringify([sheet, eventId]);
  const mediaKey = ({source, media}) => source.key + ':' + media.id;
  const pendingDrafts = () => [...state.drafts.values()].filter(draft => draft.dirty);
  const notice = (message, error = false) => api.message(controls.Status, message, error);
  const saveNotice = (message, error = false) => api.message(controls.SaveStatus, message, error);

  async function busy(work) {
    if (state.busy) return;
    state.busy = true;
    const inputs = [...document.querySelectorAll('main button, main input, main select, main textarea'), controls.Refresh];
    const previous = inputs.map(input => input.disabled);
    inputs.forEach(input => { input.disabled = true; });
    controls.Items.setAttribute('aria-busy', 'true');
    try {
      return await work();
    } finally {
      state.busy = false;
      inputs.forEach((input, index) => { input.disabled = previous[index]; });
      controls.Items.setAttribute('aria-busy', 'false');
      renderToolbar();
    }
  }

  function targetFor(item) {
    if (item.targetEventId) {
      return state.workspace.targets.get(targetKey({sheet: item.targetSheet, eventId: item.targetEventId}));
    }
    for (const match of item.matches) {
      const target = state.workspace.targets.get(targetKey(match));
      if (target) return target;
    }
    return null;
  }

  function draftFor(item) {
    if (!state.drafts.has(item.key)) {
      state.drafts.set(item.key, {
        key: item.key, revision: item.revision, indexSignature: item.indexSignature,
        state: item.state, target: targetFor(item),
        selected: new Set(item.selectedFields.filter(key => key !== 'Description' || !item.draftDescription)),
        values: {...item.fields, Description: item.draftDescription}, dirty: false,
        flyer: null, slide: 0, stale: false
      });
    }
    return state.drafts.get(item.key);
  }

  function queue(item, draft, decision = draft.state) {
    draft.state = decision;
    draft.dirty = true;
    if (!draft.stale) state.errors.delete(item.key);
    renderToolbar();
  }

  function savedChoices() {
    return (state.workspace?.items || []).filter(item =>
      item.state === 'confirmed' && item.approvedIndexSignature === item.indexSignature &&
      item.selectedFields.length && !item.selectedFields.includes('Description') &&
      !state.drafts.get(item.key)?.dirty && targetFor(item));
  }

  function renderToolbar() {
    const count = pendingDrafts().length;
    controls.Save.textContent = count ? 'Save all changes (' + count + ')' : 'Save all changes';
    controls.Save.disabled = state.busy || !count;
    controls.Import.disabled = state.busy || !state.workspace;
    controls.SavedChoices.hidden = !savedChoices().length;
    controls.SavedChoices.disabled = state.busy;
    controls.Publish.hidden = !state.workspace?.needsPublish;
    const failed = state.importJob && state.importJob.next < state.importJob.batches.length;
    controls.Resume.hidden = state.busy || !failed;
  }

  function image(src, alt, current = false, local = false) {
    const element = node('img', 'backfill-image' + (current ? ' backfill-current-flyer' : ''));
    element.alt = alt;
    element.loading = 'lazy';
    element.referrerPolicy = 'no-referrer';
    element.src = local ? src : '/admin/flyer?url=' + encodeURIComponent(src);
    element.addEventListener('error', () => {
      element.replaceWith(node('p', 'backfill-notice', 'Image unavailable. Choose the downloaded original or open the source post.'));
    });
    return element;
  }
  function download(name, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
    const element = node('a');
    element.href = url;
    element.download = name;
    element.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function originalFile(asset) {
    const name = String(asset.media.originalFile || '').split('/').pop();
    return state.chosenFiles.get(mediaKey(asset)) || state.originals.get(name);
  }
  function previewUrl(file) {
    if (!state.objectUrls.has(file)) state.objectUrls.set(file, URL.createObjectURL(file));
    return state.objectUrls.get(file);
  }

  function renderCoverage(runs) {
    controls.Coverage.replaceChildren();
    for (const run of runs) {
      const wrap = node('div', 'backfill-coverage-wrap');
      const table = node('table', 'backfill-coverage-table');
      const header = node('tr');
      for (const label of ['Account', 'Posts returned', 'Posted in 2025', 'Oldest post', 'Coverage note']) {
        header.append(node('th', '', label));
      }
      table.append(header);
      for (const account of run.coverage.accounts || []) {
        const row = node('tr');
        for (const value of [account.account, account.posts, account.posts2025, account.oldest, account.note]) {
          row.append(node('td', '', String(value ?? '')));
        }
        table.append(row);
      }
      wrap.append(table);
      controls.Coverage.append(wrap);
    }
  }

  async function readWorkspace() {
    const workspace = {items: [], sources: new Map(), targets: new Map()};
    let offset = 0;
    do {
      const part = await api.request('admin.backfill.bootstrap', {workspace: true, offset});
      if (part.workflowVersion !== 2) {
        throw new Error('Install ArchiveBackfill.gs v1.1.0 and update the existing Apps Script deployment to use batch review.');
      }
      workspace.items.push(...part.items);
      for (const [key, source] of Object.entries(part.sources)) workspace.sources.set(key, source);
      for (const [key, target] of Object.entries(part.targets)) workspace.targets.set(key, target);
      workspace.sourceCount = part.sourceCount;
      workspace.runs = part.runs;
      workspace.needsPublish = part.needsPublish;
      offset = part.nextOffset;
    } while (offset !== null);

    state.workspace = workspace;
    state.searchCache.clear();
    for (const item of workspace.items) {
      item.searchText = normalized([
        ...Object.values(item.fields), item.targetEventId, ...item.matches.map(match => match.eventId),
        ...item.postKeys.map(key => {
          const source = workspace.sources.get(key);
          return source ? source.account + ' ' + source.caption : '';
        })
      ].join(' '));
      const draft = state.drafts.get(item.key);
      if (!draft?.dirty || item.state === 'applied') {
        state.drafts.delete(item.key);
        state.errors.delete(item.key);
        continue;
      }
      const latest = draft.target && workspace.targets.get(targetKey(draft.target));
      draft.stale = draft.revision !== item.revision ||
        (draft.state === 'confirmed' && draft.indexSignature !== item.indexSignature) ||
        (latest && latest.revision !== draft.target.revision);
      if (draft.stale) state.errors.set(item.key, 'This review changed. Check the current match before saving.');
    }
    renderCoverage(workspace.runs);
  }

  async function refresh() {
    await busy(async () => {
      notice('Loading backfill review…');
      try {
        await readWorkspace();
        notice('Choose a match or approve the displayed flyer. Save your queued changes together.');
      } catch (error) {
        notice(error.message, true);
      }
    });
    render();
  }

  function visibleItems() {
    const query = normalized(controls.Query.value);
    const queue = controls.Queue.value;
    const status = controls.State.value;
    return state.workspace.items.filter(item => {
      const draft = state.drafts.get(item.key);
      const matches = item.matches.length || item.targetEventId || (draft?.dirty && draft.target);
      if ((queue === 'matches' && !matches) || (queue === 'unmatched' && matches)) return false;
      if (status === 'queued' ? !draft?.dirty : status && item.state !== status) return false;
      if (controls.Missing.checked) {
        const field = (draft?.target || targetFor(item))?.fields.find(field => field.key === 'Flyer_URL');
        if (!field || field.readOnly || field.value) return false;
        if (!item.postKeys.some(key => state.workspace.sources.get(key)?.media.length)) return false;
      }
      return !query || item.searchText.includes(query);
    });
  }

  function render() {
    if (!state.workspace) return;
    const visible = visibleItems();
    state.offset = Math.min(state.offset, Math.max(0, Math.floor((visible.length - 1) / PAGE_SIZE) * PAGE_SIZE));
    controls.Items.replaceChildren();
    for (const item of visible.slice(state.offset, state.offset + PAGE_SIZE)) {
      controls.Items.append(renderCard(item));
    }
    if (!visible.length) controls.Items.append(node('p', 'backfill-empty', 'No proposals match this view.'));
    controls.Counts.textContent = state.workspace.sourceCount + ' source posts · ' + visible.length + ' proposals in this view';
    controls.Page.textContent = visible.length
      ? (state.offset + 1) + '–' + Math.min(state.offset + PAGE_SIZE, visible.length) + ' of ' + visible.length
      : '0 proposals';
    controls.Previous.disabled = state.offset === 0;
    controls.Next.disabled = state.offset + PAGE_SIZE >= visible.length;
    const requests = state.workspace.items.filter(item =>
      item.state === 'confirmed' && item.selectedFields.includes('Description') && !item.draftDescription
    ).length;
    controls.RequestsNote.textContent = requests + ' selected events waiting for a draft.';
    controls.Requests.disabled = !requests;
    renderToolbar();
  }

  function renderCard(item) {
    const draft = draftFor(item);
    const card = node('article', 'backfill-card');
    const status = node('p', 'backfill-meta backfill-row-state');
    const rowMessage = node('p', 'backfill-notice');
    const undo = button('Undo queued change', () => {
      state.drafts.delete(item.key);
      state.errors.delete(item.key);
      render();
    });
    card.append(status, node('h3', '', item.fields['Title (internal)'] || 'Event lead'));
    const compare = node('div', 'backfill-compare');
    const sourceBox = node('section', 'backfill-source');
    const targetBox = node('section', 'backfill-target');
    compare.append(sourceBox, targetBox);
    card.append(compare, rowMessage);

    const assets = item.postKeys.flatMap(key => {
      const source = state.workspace.sources.get(key);
      return source ? source.media.map(media => ({source, media})) : [];
    });
    if (!draft.slid) {
      draft.slide = Math.max(0, assets.findIndex(asset => (item.visual.mediaIds || []).includes(asset.media.id)));
      draft.slid = true;
    }
    const sourceMedia = node('div');
    const sourceActions = node('div', 'backfill-actions');
    const previous = button('←', () => turn(-1));
    const next = button('→', () => turn(1));
    previous.setAttribute('aria-label', 'Previous source image');
    next.setAttribute('aria-label', 'Next source image');
    const slideCount = node('span');
    const selectFlyer = button('Approve match + flyer', chooseFlyer, 'save-button');
    const flyerAvailability = node('p', 'backfill-meta backfill-flyer-availability');
    flyerAvailability.id = 'backfill-flyer-reason-' + item.key;
    flyerAvailability.setAttribute('role', 'status');
    selectFlyer.setAttribute('aria-describedby', flyerAvailability.id);
    sourceActions.append(previous, slideCount, next, selectFlyer);
    const caption = node('details');
    caption.append(node('summary', '', 'Caption and visual findings'));
    const captionText = node('div', 'backfill-caption');
    const sourceLink = node('div', 'backfill-actions');
    caption.append(captionText);
    const restore = node('label', 'field');
    const original = node('input');
    original.type = 'file';
    original.accept = 'image/jpeg,image/png,image/gif,image/webp';
    const fileHint = node('small', 'backfill-meta');
    let shownSource = '', currentFlyer = null, currentFlyerUrl = '';
    restore.append(node('span', '', 'Choose this slide’s downloaded original'), original, fileHint);
    sourceBox.append(node('h4', '', 'Instagram evidence'), sourceMedia, sourceActions, flyerAvailability, sourceLink, caption, restore);

    function showStatus() {
      const label = draft.dirty ? 'Queued: ' + draft.state : item.state;
      status.textContent = label + ' · ' + (item.fields.StartDate || 'Event date uncertain') +
        (item.draftDescription && item.state !== 'applied' ? ' · Description draft ready' : '');
      card.toggleAttribute('data-queued', draft.dirty);
      undo.hidden = !draft.dirty;
      const error = state.errors.get(item.key);
      api.message(rowMessage, error || item.result || '', Boolean(error));
    }
    function turn(step) {
      if (assets.length) draft.slide = (draft.slide + step + assets.length) % assets.length;
      showSlide();
    }
    function flyerBlockedReason() {
      if (item.state === 'applied') return 'This proposal has already been saved.';
      if (draft.stale) return 'Use “Review current match” before approving this flyer.';
      if (!draft.target) return 'Choose an archive event under “Choose another archive match” first.';
      const field = draft.target.fields.find(field => field.key === 'Flyer_URL');
      if (!field) return 'This archive needs the updated ArchiveBackfill.gs v1.1.1 to add its flyer field.';
      if (field.readOnly) return 'The archive flyer cell contains a formula and cannot be replaced here.';
      return '';
    }
    function showSlide() {
      sourceLink.replaceChildren();
      const asset = assets[draft.slide];
      previous.disabled = next.disabled = assets.length < 2;
      const reason = !asset ? 'This source post has no image to approve.' : flyerBlockedReason();
      selectFlyer.disabled = Boolean(reason);
      selectFlyer.title = reason;
      flyerAvailability.textContent = reason;
      flyerAvailability.hidden = !reason;
      restore.hidden = !asset;
      if (!asset) {
        sourceMedia.replaceChildren(node('p', '', 'No source image was returned.'));
        return;
      }
      const {source, media} = asset;
      const file = originalFile(asset);
      const imageUrl = file ? previewUrl(file) : media.savedUrl || media.url;
      if (shownSource !== mediaKey(asset) + '\n' + imageUrl) {
        sourceMedia.replaceChildren(image(imageUrl, 'Source image ' + media.order + ' from @' + source.account, false, Boolean(file)));
        shownSource = mediaKey(asset) + '\n' + imageUrl;
      }
      slideCount.textContent = (draft.slide + 1) + ' / ' + assets.length;
      sourceLink.append(link('@' + source.account + ' · open post', source.url));
      captionText.textContent = [source.caption, item.evidence.notes,
        'Visual review: ' + (item.visual.status || 'pending'), item.visual.notes].filter(Boolean).join('\n\n');
      fileHint.textContent = file ? file.name : (media.originalFile || '');
      const chosen = draft.flyer?.postKey === source.key && draft.flyer.mediaId === media.id && draft.selected.has('Flyer_URL');
      selectFlyer.textContent = chosen ? 'Flyer queued' : 'Approve match + flyer';
      selectFlyer.setAttribute('aria-pressed', String(chosen));
    }
    function chooseFlyer() {
      const asset = assets[draft.slide];
      if (!asset || flyerBlockedReason()) return;
      draft.flyer = {postKey: asset.source.key, mediaId: asset.media.id};
      draft.selected.add('Flyer_URL');
      queue(item, draft, 'confirmed');
      showTarget();
      showSlide();
      showStatus();
    }
    original.addEventListener('change', () => {
      const asset = assets[draft.slide], file = original.files[0];
      if (!asset || !file) return;
      if (file.size > 6 * MB) {
        api.message(rowMessage, 'Choose a source image no larger than 6 MB.', true);
      } else {
        state.chosenFiles.set(mediaKey(asset), file);
        if (!flyerBlockedReason()) chooseFlyer();
        else showSlide();
      }
      original.value = '';
    });

    function selectTarget(target) {
      if (!target || item.state === 'applied' || draft.stale) return;
      draft.target = target;
      for (const key of draft.selected) {
        if (!target.fields.some(field => field.key === key && !field.readOnly)) draft.selected.delete(key);
      }
      queue(item, draft, 'confirmed');
      showTarget();
      showSlide();
      showStatus();
    }

    function appendMatches(box) {
      const choices = node('details', 'backfill-match-details');
      choices.open = !draft.target;
      choices.append(node('summary', '', 'Choose another archive match'));
      for (const match of item.matches) {
        const target = state.workspace.targets.get(targetKey(match));
        if (!target) continue;
        const choice = button(match.title + ' · ' + match.date + ' · ' + match.eventId,
          () => selectTarget(target), 'backfill-match');
        choice.setAttribute('aria-pressed', String(draft.target && targetKey(draft.target) === targetKey(match)));
        choice.append(node('small', '', match.reasons.join(' · ')));
        if (match.conflicts.length) choice.append(node('small', 'backfill-conflict', match.conflicts.join(' · ')));
        choices.append(choice);
      }
      const form = node('div', 'backfill-manual');
      const query = node('input');
      query.type = 'search';
      query.placeholder = 'Search 2025 archive events';
      query.maxLength = 250;
      const results = node('div');
      const search = button('Find archive event', async () => {
        const value = normalized(query.value);
        if (!value || search.disabled) return;
        search.disabled = true;
        try {
          if (!state.searchCache.has(value)) {
            const data = await api.request('admin.backfill.find', {query: query.value.trim()});
            state.searchCache.set(value, data.events);
          }
          results.replaceChildren();
          for (const target of state.searchCache.get(value)) {
            state.workspace.targets.set(targetKey(target), target);
            const date = target.fields.find(field => field.key === 'StartDate')?.value || '';
            results.append(button(target.title + ' · ' + date + ' · ' + target.eventId,
              () => selectTarget(target), 'backfill-match'));
          }
          if (!results.childNodes.length) results.append(node('p', '', 'No 2025 archive event matched.'));
        } catch (error) {
          api.message(rowMessage, error.message, true);
        } finally {
          search.disabled = false;
        }
      });
      form.append(query, search);
      choices.append(form, results);
      box.append(choices);
    }

    function appendFields(box) {
      const details = node('details', 'backfill-fields');
      details.append(node('summary', '', 'Edit event details and description'));
      for (const [key, label] of Object.entries(fieldLabels)) {
        const field = draft.target.fields.find(field => field.key === key);
        if (!field || field.readOnly) continue;
        const row = node('div', 'backfill-change');
        const option = node('label', 'backfill-choice');
        const check = node('input');
        check.type = 'checkbox';
        check.checked = draft.selected.has(key);
        option.append(check, node('span', '', label));
        const values = node('div');
        const input = node(key === 'Description' ? 'textarea' : 'input');
        input.value = draft.values[key] || '';
        input.maxLength = field.maxLength || 40000;
        if (['date', 'time', 'url'].includes(field.type)) input.type = field.type;
        input.setAttribute('aria-label', label + ' proposal');
        if (key === 'Description') input.placeholder = 'Leave this blank to request a draft.';
        function syncInput() {
          input.readOnly = key === 'Description' && !check.checked;
        }
        check.addEventListener('change', () => {
          if (check.checked) draft.selected.add(key);
          else draft.selected.delete(key);
          queue(item, draft, 'confirmed');
          syncInput();
          showStatus();
        });
        input.addEventListener('input', () => {
          draft.values[key] = input.value;
          if (check.checked) {
            queue(item, draft, 'confirmed');
            showStatus();
          }
        });
        syncInput();
        values.append(node('p', 'backfill-before', 'Current: ' + (field.value || '(blank)')), input);
        row.append(option, values);
        details.append(row);
      }
      box.append(details);
    }

    function showTarget() {
      targetBox.replaceChildren(node('h4', '', 'Archive event'));
      const target = draft.target;
      if (target) {
        const suggestion = item.matches.find(match => targetKey(match) === targetKey(target));
        targetBox.append(node('h4', '', target.title), node('p', 'backfill-meta', target.sheet + ' · ' + target.eventId),
          link('Open current event', '/?event=' + encodeURIComponent(target.eventId)));
        if (suggestion) {
          targetBox.append(node('p', 'backfill-meta', suggestion.reasons.join(' · ')));
          if (suggestion.conflicts.length) targetBox.append(node('p', 'backfill-conflict', suggestion.conflicts.join(' · ')));
        }
        const description = target.fields.find(field => field.key === 'Description');
        if (description?.value) {
          const details = node('details');
          details.append(node('summary', '', 'Current description'), node('p', 'backfill-caption', description.value));
          targetBox.append(details);
        }
        const flyer = target.fields.find(field => field.key === 'Flyer_URL');
        if (flyer?.value) {
          if (flyer.value !== currentFlyerUrl) {
            currentFlyer = image(flyer.value, 'Current archive flyer', true);
            currentFlyerUrl = flyer.value;
          }
          targetBox.append(currentFlyer);
        } else targetBox.append(node('p', 'backfill-meta', 'No archive flyer.'));
      } else {
        targetBox.append(node('p', 'backfill-meta', 'Choose an archive event to approve a match.'));
      }
      if (item.state === 'applied') return;
      if (draft.stale) {
        targetBox.append(button('Review current match', () => {
          const latest = draft.target && state.workspace.targets.get(targetKey(draft.target));
          draft.target = latest || targetFor(item);
          draft.revision = item.revision;
          draft.indexSignature = item.indexSignature;
          draft.stale = false;
          draft.state = 'pending';
          state.errors.delete(item.key);
          showTarget();
          showSlide();
          showStatus();
        }), undo);
        return;
      }
      const actions = node('div', 'backfill-actions');
      if (target) {
        actions.append(button(draft.selected.size ? 'Queue selected updates' : 'Approve shown match',
          () => selectTarget(target)));
        if (draft.selected.has('Flyer_URL')) {
          actions.append(button('Remove flyer update', () => {
            draft.flyer = null;
            draft.selected.delete('Flyer_URL');
            queue(item, draft);
            showTarget();
            showSlide();
            showStatus();
          }));
        }
      }
      for (const [label, decision] of [['Defer', 'deferred'], ['Reject', 'rejected']]) {
        actions.append(button(label, () => {
          queue(item, draft, decision);
          showStatus();
        }));
      }
      actions.append(undo);
      targetBox.append(actions);
      if (target) appendFields(targetBox);
      appendMatches(targetBox);
    }

    showTarget();
    showSlide();
    showStatus();
    return card;
  }

  function base64(bytes) {
    if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    }
    return btoa(binary);
  }

  async function importBatches(data) {
    const batches = [];
    const metadata = new Map();
    for (const [key, value] of Object.entries(data.assetMetadata || {})) {
      const post = key.slice(0, key.lastIndexOf(':'));
      if (!metadata.has(post)) metadata.set(post, {});
      metadata.get(post)[key] = value;
    }

    async function pack(rows, kind, coverage) {
      const payload = {runId: data.runId, [kind]: rows, coverage};
      if (kind === 'posts') {
        payload.assetMetadata = {};
        for (const post of rows) {
          const key = 'ig:' + String(post.pk || post.id).split('_')[0];
          Object.assign(payload.assetMetadata, metadata.get(key));
        }
      }
      const bytes = encoder.encode(JSON.stringify(payload));
      let body = null;
      if (bytes.length < 1.9 * MB) body = payload;
      if (typeof CompressionStream === 'function' && bytes.length <= 6 * MB) {
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
        const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
        if (compressed.length * 4 / 3 < 1.9 * MB) body = {gzip: base64(compressed)};
      }
      if (body) {
        batches.push({body, count: rows.length, kind});
        return;
      }
      if (rows.length < 2) throw new Error('A source record exceeds the import size limit.');
      const midpoint = Math.ceil(rows.length / 2);
      await pack(rows.slice(0, midpoint), kind, coverage);
      await pack(rows.slice(midpoint), kind);
    }

    for (const kind of ['posts', 'candidates']) {
      for (let offset = 0; offset < data[kind].length; offset += IMPORT_ROWS) {
        const rows = data[kind].slice(offset, offset + IMPORT_ROWS);
        await pack(rows, kind, batches.length ? undefined : data.coverage);
      }
    }
    if (!batches.length && data.coverage) await pack([], 'posts', data.coverage);
    return batches;
  }

  async function waitForWrite(action, body, waiting) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await api.request(action, body);
      } catch (error) {
        if (attempt >= 4 || !/^Another QDP (?:save or sync is running|sync is already running for this account)\./.test(error.message)) throw error;
        waiting();
        await new Promise(resolve => setTimeout(resolve, 2000 + attempt * 1000));
      }
    }
  }

  async function runImport(file) {
    await busy(async () => {
      try {
        if (file) {
          if (file.size > 40 * MB) throw new Error('Use a backfill JSON collection smaller than 40 MB.');
          const data = JSON.parse(await file.text());
          if (data.schema !== 'qdp-backfill-v1' || !Array.isArray(data.posts) ||
              !Array.isArray(data.candidates) || !data.runId) throw new Error('Choose a prepared QDP backfill collection.');
          notice('Preparing the collection…');
          state.importJob = {
            batches: await importBatches(data), next: 0, done: 0,
            total: data.posts.length + data.candidates.length, newPosts: 0, newCandidates: 0
          };
        }
        const job = state.importJob;
        if (!job) return;
        controls.Progress.hidden = false;
        controls.Progress.max = Math.max(1, job.total);
        controls.Progress.value = job.done;
        while (job.next < job.batches.length) {
          const {body, count, kind} = job.batches[job.next];
          notice('Importing ' + (kind === 'posts' ? 'source posts' : 'review proposals') +
            ' · batch ' + (job.next + 1) + ' of ' + job.batches.length);
          const result = await waitForWrite('admin.backfill.ingest', body,
            () => notice('Waiting for the current QDP save or sync. Completed batches are saved.'));
          job.next++;
          job.done += count;
          job.newPosts += result.addedPosts;
          job.newCandidates += result.addedCandidates;
          controls.Progress.value = job.done;
        }
        const status = 'Import complete · ' + job.newPosts + ' new source posts and ' + job.newCandidates + ' new proposals.';
        state.importJob = null;
        notice(status + ' Loading the review queue…');
        await readWorkspace();
        state.offset = 0;
        notice(status);
      } catch (error) {
        notice(error.message, true);
      } finally {
        controls.Progress.hidden = true;
        controls.Import.value = '';
      }
    });
    render();
  }

  async function preparedChange(draft) {
    const selectedFields = [...draft.selected];
    const change = {
      key: draft.key, state: draft.state, expectedRevision: draft.revision,
      expectedIndexSignature: draft.indexSignature, expectedTargetRevision: draft.target?.revision,
      targetSheet: draft.target?.sheet || '', targetEventId: draft.target?.eventId || '',
      selectedFields, fields: Object.fromEntries(selectedFields
        .filter(key => key !== 'Description' && (key !== 'Flyer_URL' || !draft.flyer))
        .map(key => [key, draft.values[key] || ''])),
      draftDescription: draft.selected.has('Description') ? draft.values.Description || '' : ''
    };
    if (draft.state === 'confirmed' && draft.flyer && draft.selected.has('Flyer_URL')) {
      change.flyer = {...draft.flyer};
      const source = state.workspace.sources.get(change.flyer.postKey);
      const media = source?.media.find(media => media.id === change.flyer.mediaId);
      if (media && !media.savedUrl) {
        const file = originalFile({source, media});
        if (file) {
          if (file.size > 6 * MB) throw new Error('Choose a source image no larger than 6 MB.');
          change.flyer.imageBase64 = base64(new Uint8Array(await file.arrayBuffer()));
        }
      }
    }
    return change;
  }

  async function saveAll() {
    const queued = pendingDrafts();
    if (!queued.length) return;
    const items = new Map(state.workspace.items.map(item => [item.key, item]));
    const targetCounts = new Map();
    for (const draft of queued) {
      if (draft.state !== 'confirmed' || !draft.target || !draft.selected.size) continue;
      const key = targetKey(draft.target);
      targetCounts.set(key, (targetCounts.get(key) || 0) + 1);
    }
    let saved = 0, edited = 0;
    await busy(async () => {
      let batch = [], bytes = 0, flyers = 0;
      async function send() {
        if (!batch.length) return;
        saveNotice('Saving ' + batch.length + ' queued changes · ' + saved + ' saved so far…');
        const response = await waitForWrite('admin.backfill.savebatch', {changes: batch},
          () => saveNotice('Waiting for the current QDP save or sync. Queued choices are kept.'));
        for (const source of response.sources) state.workspace.sources.set(source.key, source);
        for (const outcome of response.results) {
          if (outcome.error) {
            state.errors.set(outcome.key, outcome.error);
            continue;
          }
          const item = items.get(outcome.key);
          Object.assign(item, outcome);
          if (outcome.target) {
            item.targetSheet = outcome.target.sheet;
            item.targetEventId = outcome.target.eventId;
            state.workspace.targets.set(targetKey(outcome.target), outcome.target);
          }
          state.errors.delete(outcome.key);
          state.drafts.delete(outcome.key);
          saved++;
        }
        edited += response.editedEvents;
        state.workspace.needsPublish = response.needsPublish;
        batch = [];
        bytes = flyers = 0;
      }

      try {
        for (const draft of queued) {
          if (draft.stale) continue;
          if (draft.state === 'confirmed' && draft.target && draft.selected.size &&
              targetCounts.get(targetKey(draft.target)) > 1) {
            state.errors.set(draft.key, 'More than one proposal targets this event. Keep one update queued for this event.');
            continue;
          }
          let change;
          try {
            change = await preparedChange(draft);
          } catch (error) {
            state.errors.set(draft.key, error.message);
            continue;
          }
          const size = encoder.encode(JSON.stringify(change)).length;
          if (batch.length >= SAVE_ROWS || bytes + size > 9 * MB || (change.flyer && flyers >= SAVE_FLYERS)) await send();
          batch.push(change);
          bytes += size + 1;
          if (change.flyer) flyers++;
        }
        await send();
        const left = pendingDrafts().length;
        const summary = 'Saved ' + saved + ' reviews and updated ' + edited + ' archive events.';
        saveNotice(summary + (left ? ' ' + left + ' still queued. See their row messages.' : ''), Boolean(left));
      } catch (error) {
        saveNotice(error.message + ' ' + saved + ' reviews saved. Remaining choices are queued.', true);
      }
    });
    render();
  }

  async function importDrafts(file) {
    if (!file) return;
    await busy(async () => {
      try {
        if (pendingDrafts().length) throw new Error('Save your queued changes before importing description drafts.');
        const json = JSON.parse(await file.text());
        const drafts = Array.isArray(json) ? json : json.drafts;
        if (!Array.isArray(drafts) || drafts.length > 500) throw new Error('Choose a prepared description file with up to 500 drafts.');
        const items = new Map(state.workspace.items.map(item => [item.key, item]));
        let saved = 0, failed = 0, batch = [], bytes = 0;
        async function send() {
          if (!batch.length) return;
          const data = await api.request('admin.backfill.draftbatch', {drafts: batch});
          for (const result of data.results) {
            const item = items.get(result.key);
            if (result.error) {
              state.errors.set(result.key, result.error);
              failed++;
            } else {
              if (item) Object.assign(item, result);
              state.drafts.delete(result.key);
              state.errors.delete(result.key);
              saved++;
            }
          }
          batch = [];
          bytes = 0;
        }
        for (const {key, expectedRevision, description} of drafts) {
          const draft = {key, expectedRevision, description};
          const size = encoder.encode(JSON.stringify(draft)).length;
          if (size > 1.9 * MB) { failed++; continue; }
          if (batch.length >= 100 || bytes + size > 1.9 * MB) await send();
          batch.push(draft);
          bytes += size + 1;
        }
        await send();
        saveNotice(saved + ' description drafts ready for review.' + (failed ? ' ' + failed + ' could not be saved.' : ''), Boolean(failed));
      } catch (error) {
        saveNotice(error.message, true);
      } finally {
        controls.Drafts.value = '';
      }
    });
    render();
  }

  controls.Refresh.addEventListener('click', refresh);
  controls.Import.addEventListener('change', () => {
    if (controls.Import.files[0]) return runImport(controls.Import.files[0]);
  });
  controls.Resume.addEventListener('click', () => runImport());
  controls.Originals.addEventListener('change', () => {
    for (const file of controls.Originals.files) state.originals.set(file.name, file);
    notice(state.originals.size + ' downloaded images available for preview.');
    render();
  });
  controls.Save.addEventListener('click', saveAll);
  controls.SavedChoices.addEventListener('click', () => {
    for (const item of savedChoices()) queue(item, draftFor(item), 'confirmed');
    saveNotice('Saved approvals queued for review and saving.');
    render();
  });
  function resetView() { state.offset = 0; render(); }
  controls.Query.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(resetView, 120);
  });
  for (const name of ['Queue', 'State', 'Missing']) controls[name].addEventListener('change', resetView);
  controls.Previous.addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE_SIZE); render(); });
  controls.Next.addEventListener('click', () => { state.offset += PAGE_SIZE; render(); });
  controls.Requests.addEventListener('click', () => busy(async () => {
    try {
      const data = await api.request('admin.backfill.requests');
      download('QDP_Backfill_Description_Requests.json', data);
      saveNotice(data.requests.length + ' selected description requests downloaded.');
    } catch (error) { saveNotice(error.message, true); }
  }));
  controls.Drafts.addEventListener('change', () => importDrafts(controls.Drafts.files[0]));
  window.addEventListener('beforeunload', event => {
    if (pendingDrafts().length || state.importJob) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  refresh();
})();
