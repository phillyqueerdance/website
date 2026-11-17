(() => {
  const api = window.QDPAdminProfiles;
  const el = Object.fromEntries(['eventReload', 'eventHeading', 'eventIdentity', 'eventStatus', 'eventForm', 'eventFields', 'eventSave']
    .map(id => [id, document.getElementById(id)]));
  const query = new URLSearchParams(window.location.search);
  const source = { eventId: query.get('eventId') || '', sheet: query.get('sheet') || '' };
  let current = null, references = {}, entries = new Map(), busy = false;
  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text != null) item.textContent = text;
    return item;
  }
  const ids = value => [...new Set(String(value || '').split(',').map(id => id.trim()).filter(Boolean))];
  function changes() {
    return Object.fromEntries([...entries].filter(([, entry]) => !entry.readOnly && !entry.disabled && entry.read() !== entry.original)
      .map(([key, entry]) => [key, entry.read()]));
  }
  function update() {
    const venue = [...entries.values()].find(entry => entry.type === 'venue');
    for (const entry of entries.values()) if (entry.manualLocation) {
      entry.disabled = !!venue?.read(); entry.input.disabled = entry.readOnly || entry.disabled;
    }
    el.eventFields.disabled = busy;
    el.eventReload.disabled = busy;
    el.eventSave.disabled = busy || !current || !Object.keys(changes()).length;
  }
  function render(event) {
    current = event; entries = new Map(); el.eventFields.replaceChildren();
    el.eventHeading.textContent = event.title;
    el.eventIdentity.textContent = `${event.eventId} · ${event.sheet}`;
    const groups = new Map();
    for (const field of event.fields) {
      if (!groups.has(field.group)) {
        const group = node('fieldset', 'profile-group'), grid = node('div', 'profile-grid');
        group.append(node('legend', '', field.group), grid); el.eventFields.append(group); groups.set(field.group, grid);
      }
      const multiple = ['artist', 'collective'].includes(field.type);
      const label = node(multiple ? 'div' : 'label', 'field' + (field.type === 'long' ? ' profile-long event-long' : multiple ? ' event-multiple' : ''));
      label.append(node('span', '', field.label));
      let input, read;
      if (multiple) {
        const original = ids(field.value), options = references[field.type] || [];
        const known = new Map(options.map(option => [option.id, option.name]));
        const ordered = [...original, ...options.map(option => option.id).filter(id => !original.includes(id))];
        const filter = node('input'); filter.type = 'search'; filter.placeholder = 'Find ' + field.label.toLowerCase();
        filter.setAttribute('aria-label', 'Find ' + field.label.toLowerCase()); label.append(filter);
        input = node('fieldset', 'event-options'); input.setAttribute('aria-label', field.label); input.disabled = field.readOnly;
        const choices = ordered.map(id => {
          const row = node('label', 'event-option'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = original.includes(id);
          row.append(checkbox, node('span', '', known.get(id) || id)); input.append(row); return {id, row, checkbox};
        });
        filter.addEventListener('input', () => { const text = filter.value.trim().toLowerCase();
          for (const choice of choices) choice.row.hidden = !((known.get(choice.id) || '') + ' ' + choice.id).toLowerCase().includes(text);
        });
        read = () => { const selected = choices.filter(choice => choice.checkbox.checked).map(choice => choice.id);
          return selected.length === original.length && selected.every(id => original.includes(id)) ? field.value : selected.join(', ');
        };
      } else {
        const options = ['venue', 'party'].includes(field.type) ? references[field.type] || [] :
          field.type === 'flag' ? [{id: 'Yes', name: 'Yes'}, {id: 'No', name: 'No'}] :
          field.type === 'neighborhood' ? api.neighborhoods.map(name => ({id: name, name})) : null;
        input = node(options ? 'select' : field.type === 'long' ? 'textarea' : 'input');
        if (options) {
          input.add(new Option('Unspecified', ''));
          if (field.value && !options.some(option => option.id === field.value)) input.add(new Option(field.value, field.value));
          for (const option of options) input.add(new Option(option.name, option.id));
        } else {
          input.maxLength = field.maxLength;
          if (field.type === 'long') input.rows = 12;
          else if (field.type === 'date' && (!field.value || /^\d{4}-\d{2}-\d{2}$/.test(field.value))) input.type = 'date';
          else if (field.type === 'time' && (!field.value || /^\d{2}:\d{2}(?::\d{2})?$/.test(field.value))) { input.type = 'time'; input.step = '1'; }
          else if (field.type === 'url') input.type = 'url';
        }
        input.value = field.value; input.disabled = field.readOnly;
        read = () => input.value;
      }
      label.append(input);
      if (field.readOnly) label.append(node('small', 'field-help', 'Calculated automatically.'));
      if (field.manualLocation) label.append(node('small', 'field-help', 'Clear the venue to enter a manual location.'));
      entries.set(field.key, {...field, input, read, original: field.value});
      groups.get(field.group).append(label);
    }
    el.eventForm.hidden = false; update();
  }
  function errorMessage(error) {
    return /Unknown archive action|Deploy the updated Core.gs|Unknown admin action/i.test(error.message) ?
      'Install ArchiveReview.gs v7.4.20 and update the existing Apps Script deployment to use the event editor.' : error.message;
  }
  async function load() {
    if (busy) return;
    if (current && Object.keys(changes()).length && !window.confirm('Reload this event and discard unsaved edits?')) return;
    busy = true; update(); api.message(el.eventStatus, 'Loading event…');
    try {
      const result = await api.request('admin.archive.event.read', source);
      references = result.references; render(result.event); api.message(el.eventStatus, '');
    } catch (error) { api.message(el.eventStatus, errorMessage(error), true); }
    finally { busy = false; update(); }
  }
  el.eventForm.addEventListener('input', update);
  el.eventForm.addEventListener('change', update);
  el.eventReload.addEventListener('click', load);
  el.eventForm.addEventListener('submit', async event => {
    event.preventDefault(); const fields = changes();
    if (busy || !current || !Object.keys(fields).length) return;
    busy = true; update(); api.message(el.eventStatus, 'Saving event…');
    try {
      const result = await api.request('admin.archive.event.save', {...source, expectedRevision: current.revision, fields});
      if (!result.event || result.event.eventId !== current.eventId || !result.event.revision) throw new Error('The save was not confirmed. Your edits have been kept.');
      render(result.event);
      api.message(el.eventStatus, 'Event saved. Publish saved changes in Archive Updates to update the website. Refresh or rescan the review to see the edited event.');
    } catch (error) { api.message(el.eventStatus, errorMessage(error), true); }
    finally { busy = false; update(); }
  });
  window.addEventListener('beforeunload', event => { if (Object.keys(changes()).length) { event.preventDefault(); event.returnValue = ''; } });
  load();
})();
