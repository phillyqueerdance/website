import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const client = fs.readFileSync(new URL('../admin/admin.js', import.meta.url), 'utf8');
const core = process.env.QDP_CORE_SOURCE ? fs.readFileSync(process.env.QDP_CORE_SOURCE, 'utf8') : null;
const plain = value => JSON.parse(JSON.stringify(value));

function browser() {
  const elements = new Map(), requests = [], messages = [], applied = [], timers = [];
  const context = vm.createContext({
    console, URL, TextEncoder,
    document: {querySelectorAll: () => [], getElementById(id) {
      if (!elements.has(id)) elements.set(id, {hidden: true, textContent: ''});
      return elements.get(id);
    }},
    window: {confirm: () => true},
    setTimeout(callback) { timers.push(callback); return timers.length; },
    clearTimeout() {}
  });
  vm.runInContext(client.slice(0, client.indexOf('\nelements.refreshButton.addEventListener(')), context);
  const state = vm.runInContext('state', context);
  state.capabilities = {directSync: true};
  state.referencesVersion = 'current-references';
  context.unsavedCount = () => 0;
  context.setBusy = value => { state.busy = value; };
  context.showToast = (message, error) => messages.push({message, error});
  context.applyDashboard = (result, options) => applied.push({result, options});
  context.refreshFeedFlyers = async () => {};
  context.adminRequest = async (action, body) => {
    requests.push({action, body});
    return {ok: 'yes', events: [], capabilities: {directSync: true}};
  };
  return {context, state, elements, requests, messages, applied, timers};
}

for (const kind of ['push', 'pull']) {
  test(`Admin ${kind} starts one request and remains busy until completion, without polling`, async () => {
    const h = browser();
    let finish;
    h.context.adminRequest = (action, body) => {
      h.requests.push({action, body});
      return new Promise(resolve => { finish = resolve; });
    };
    const running = h.context.runSync(kind);
    assert.equal(h.state.busy, true);
    assert.equal(h.elements.get('syncProgress').hidden, false);
    assert.match(h.elements.get('syncProgress').textContent, /running/);
    assert.deepEqual(plain(h.requests), [{action: `admin.${kind}`, body: {referencesVersion: 'current-references'}}]);
    assert.equal(h.applied.length, 0);
    finish({ok: 'yes', events: [{eventId: 'SYNCED'}], capabilities: {directSync: true}});
    await running;
    assert.equal(h.state.busy, false);
    assert.equal(h.applied.length, 1);
    assert.equal(h.applied[0].options.preserveDrafts, true);
    assert.match(h.elements.get('syncProgress').textContent, /complete\.$/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.timers.length, 0);
  });
}

test('an older deployment cannot silently submit another queued sync', async () => {
  const h = browser(); h.state.capabilities = {backgroundSync: true};
  await h.context.runSync('push');
  assert.equal(h.requests.length, 0);
  assert.match(h.messages.at(-1).message, /Core\.gs v7\.4\.27/);
  assert.equal(h.state.busy, false);
});

test('sync errors preserve the current data and release controls without retrying', async () => {
  const h = browser(); h.state.events = [{eventId: 'UNCHANGED'}];
  h.context.adminRequest = async action => {
    h.requests.push({action}); throw new Error('Calendar Push is blocked by Archive Review save.');
  };
  await h.context.runSync('push');
  assert.equal(h.state.busy, false);
  assert.deepEqual(plain(h.state.events), [{eventId: 'UNCHANGED'}]);
  assert.equal(h.applied.length, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.timers.length, 0);
  assert.match(h.elements.get('syncProgress').textContent, /Archive Review save/);
  assert.equal(h.messages.at(-1).error, true);
});

test('an interrupted request never retries the write or reports completion', async () => {
  const h = browser();
  h.context.adminRequest = async action => { h.requests.push({action}); throw new Error('Failed to fetch'); };
  await h.context.runSync('pull');
  assert.equal(h.requests.length, 1);
  assert.equal(h.applied.length, 0);
  assert.equal(h.state.busy, false);
  assert.equal(h.messages.some(({message}) => /complete\.$/.test(message)), false);
});

test('a stale queued response is rejected without polling or a false completion', async () => {
  const h = browser();
  h.context.adminRequest = async () => ({ok: 'yes', job: {state: 'queued'}});
  await h.context.runSync('push');
  assert.equal(h.applied.length, 0);
  assert.equal(h.state.busy, false);
  assert.equal(h.timers.length, 0);
  assert.match(h.messages.at(-1).message, /Completion was not confirmed/);
});

test('busy operations, refreshes and unsaved edits cannot start another sync', async () => {
  for (const field of ['busy', 'refreshing']) {
    const h = browser(); h.state[field] = true;
    await h.context.runSync('push'); assert.equal(h.requests.length, 0);
  }
  const h = browser(); h.context.unsavedCount = () => 1;
  await h.context.runSync('pull'); assert.equal(h.requests.length, 0);
  assert.match(h.messages.at(-1).message, /unsaved edits/);
});

test('Pull retains the existing confirmation when saved edits have not been pushed', async () => {
  const h = browser(); h.state.status = {pendingPushTotalCount: 2};
  h.context.window.confirm = () => false;
  await h.context.runSync('pull'); assert.equal(h.requests.length, 0);
});

function backend({legacy = false, blocked = false, fail = false} = {}) {
  const properties = new Map([['QDP_ADMIN_SHARED_SECRET', 'fixture-secret']]);
  const calls = [], deleted = [], waits = [];
  let locked = false;
  const trigger = (id, handler) => ({getUniqueId: () => id, getHandlerFunction: () => handler});
  const triggers = [trigger('OLD', 'qdpAdminRunSyncJob'), trigger('LIVE', 'qdpLivePublish')];
  if (legacy) properties.set('QDP_ADMIN_SYNC_JOB_V1', JSON.stringify({kind: 'push', state: 'queued'}));
  if (blocked) properties.set('QDP_ACTIVE_WRITE_V1', JSON.stringify({operation: 'Archive Review save', startedAt: Date.now()}));
  const context = vm.createContext({
    console,
    PropertiesService: {getScriptProperties: () => ({
      getProperty: key => properties.get(key) || null,
      setProperty(key, value) { properties.set(key, value); },
      deleteProperty(key) { properties.delete(key); }
    })},
    LockService: {getScriptLock: () => ({
      tryLock(wait) { waits.push(wait); if (blocked || locked) return false; locked = true; return true; },
      releaseLock() { assert.equal(locked, true); locked = false; }
    })},
    ScriptApp: {
      newTrigger() { throw new Error('A direct sync must never schedule a trigger.'); },
      getProjectTriggers: () => triggers.filter(item => !deleted.includes(item.getUniqueId())),
      deleteTrigger(item) { assert.equal(locked, true); deleted.push(item.getUniqueId()); }
    },
    Session: {getScriptTimeZone: () => 'America/New_York'},
    Utilities: {formatDate: date => date.toISOString()},
    Logger: {log() {}}
  });
  vm.runInContext(core, context);
  for (const kind of ['push', 'pull']) {
    context[kind === 'push' ? 'pushSheetToCalendarCore_' : 'pullCalendarToSheetCore_'] = () => {
      assert.equal(locked, true);
      calls.push(kind);
      if (fail) throw new Error('Calendar service unavailable');
      return {updated: 2};
    };
  }
  context.qdpAdminDashboard_ = body => {
    assert.equal(locked, true);
    return {events: [{eventId: 'AFTER-SYNC'}], capabilities: {directSync: true}, referencesVersion: body?.referencesVersion};
  };
  return {context, properties, calls, deleted, waits, locked: () => locked};
}

for (const kind of ['push', 'pull']) {
  test(`authenticated Admin ${kind} executes once before returning and records its result`, {skip: !core && 'Set QDP_CORE_SOURCE to the supplied Core.gs'}, () => {
    const h = backend();
    const result = h.context.qdpAdminHandlePost_({action: `admin.${kind}`, adminToken: 'fixture-secret', referencesVersion: 'CURRENT'});
    assert.deepEqual(h.calls, [kind]);
    assert.equal(result.ok, 'yes');
    assert.equal(result.operation.updated, 2);
    assert.equal(result.events[0].eventId, 'AFTER-SYNC');
    assert.equal(result.referencesVersion, 'CURRENT');
    assert.equal(result.job, undefined);
    assert.equal(JSON.parse(h.properties.get(`QDP_ADMIN_LAST_${kind.toUpperCase()}`)).status, 'success');
    assert.equal(h.properties.has('QDP_ADMIN_SYNC_JOB_V1'), false);
    assert.equal(h.properties.has('QDP_ACTIVE_WRITE_V1'), false);
    assert.equal(h.locked(), false);
    assert.deepEqual(h.waits, [20000]);
  });
}

test('direct sync remains behind Admin authentication', {skip: !core}, () => {
  const h = backend();
  assert.throws(() => h.context.qdpAdminHandlePost_({action: 'admin.push', adminToken: 'incorrect'}), /authorization failed/);
  assert.equal(h.calls.length, 0); assert.equal(h.waits.length, 0);
});

test('a real concurrent writer still blocks direct sync and identifies the active operation', {skip: !core}, () => {
  const h = backend({blocked: true, legacy: true});
  assert.throws(() => h.context.qdpAdminSync_('pull'), /Admin Calendar Pull is blocked by Archive Review save/);
  assert.equal(h.calls.length, 0); assert.equal(h.deleted.length, 0);
  assert.equal(h.properties.has('QDP_ADMIN_SYNC_JOB_V1'), true);
});

test('a failed direct sync records the error and releases the shared write lock', {skip: !core}, () => {
  const h = backend({fail: true});
  assert.throws(() => h.context.qdpAdminSync_('push'), /Calendar service unavailable/);
  assert.deepEqual(h.calls, ['push']);
  const history = JSON.parse(h.properties.get('QDP_ADMIN_LAST_PUSH'));
  assert.equal(history.status, 'error'); assert.match(history.error, /Calendar service unavailable/);
  assert.equal(h.properties.has('QDP_ACTIVE_WRITE_V1'), false); assert.equal(h.locked(), false);
});

test('legacy queue records cannot block sync and cleanup preserves unrelated scheduled tasks', {skip: !core}, () => {
  const h = backend({legacy: true});
  assert.equal(h.context.qdpAdminReadSyncJob_(), null);
  h.context.qdpAdminSync_('pull');
  assert.deepEqual(h.calls, ['pull']); assert.deepEqual(h.deleted, ['OLD']);
  assert.equal(h.properties.has('QDP_ADMIN_SYNC_JOB_V1'), false);
  h.context.qdpAdminRunSyncJob({triggerUid: 'OLD'});
  assert.deepEqual(h.calls, ['pull']);
});

test('an old scheduled trigger only retires queued work and never executes Calendar changes', {skip: !core}, () => {
  const h = backend({legacy: true}); h.context.qdpAdminRunSyncJob({triggerUid: 'OLD'});
  assert.equal(h.calls.length, 0); assert.deepEqual(h.deleted, ['OLD']);
  assert.equal(h.properties.has('QDP_ADMIN_SYNC_JOB_V1'), false);
});

test('spreadsheet Push and Pull still call the same cores directly', {skip: !core}, () => {
  const h = backend(); h.context.pushSheetToCalendar_Full(); h.context.pullCalendarToSheet_Full();
  assert.deepEqual(h.calls, ['push', 'pull']); assert.equal(h.properties.has('QDP_ADMIN_SYNC_JOB_V1'), false);
});
