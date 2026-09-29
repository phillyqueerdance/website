/*
 * QDP archive feed extension for the existing Apps Script project.
 * The helpers can live in Code.gs or another .gs file in that same project.
 * Add the small dispatch to the existing doGet as documented in README.md.
 * This file reads the live spreadsheet through ss_(). Publishing writes only
 * approved public display fields to the configured Cloudflare KV namespace.
 */

const QDP_ARCHIVE_TABS_ = ['Archive 2024', 'Archive 2025', 'Events_Archive'];

function qdpArchiveIndex_(headers) {
  const index = {};
  headers.forEach((header, column) => {
    const name = trim(header);
    if (name) index[name.toLowerCase()] = column;
  });
  return index;
}

function qdpArchiveValue_(row, index, names) {
  for (const name of names) {
    const column = index[name.toLowerCase()];
    if (column != null) return row[column];
  }
  return '';
}

function qdpArchiveText_(row, index, names) {
  return trim(qdpArchiveValue_(row, index, names));
}

function qdpArchiveFirstText_(row, index, names) {
  for (const name of names) {
    const value = qdpArchiveText_(row, index, [name]);
    if (value) return value;
  }
  return '';
}

function qdpArchiveYes_(value) {
  return /^yes$/i.test(trim(value));
}

function qdpArchiveSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return null;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const index = qdpArchiveIndex_(headers);
  const rows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
    : [];
  return { index, rows, name };
}

function qdpArchiveLink_(value, platform) {
  const text = trim(value);
  if (/^https?:\/\/[^\s]+$/i.test(text)) return text;
  if (platform === 'instagram' && /^@?[a-z0-9._]+$/i.test(text)) {
    return 'https://www.instagram.com/' + text.replace(/^@/, '') + '/';
  }
  return '';
}

function qdpArchiveProfiles_(ss, kind) {
  const name = kind === 'artists' ? CONFIG.SHEET_ARTISTS : CONFIG.SHEET_VENUES;
  const data = qdpArchiveSheet_(ss, name);
  if (!data) throw new Error('Missing ' + name + ' sheet.');
  const idHeader = kind === 'artists' ? 'artistid' : 'venueid';
  if (data.index[idHeader] == null || data.index.public_ok == null) {
    throw new Error(name + ' requires its ID and Public_OK headers.');
  }
  const profiles = new Map();
  data.rows.forEach(row => {
    if (!qdpArchiveYes_(qdpArchiveValue_(row, data.index, ['Public_OK']))) return;
    const id = qdpArchiveText_(row, data.index, [kind === 'artists' ? 'ArtistID' : 'VenueID']);
    const displayName = qdpArchiveFirstText_(row, data.index,
      kind === 'artists' ? ['StageName'] : ['Public_Name', 'VenueName']);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !displayName) return;
    const shared = {
      id, name: displayName, publicOk: true,
      bio: qdpArchiveText_(row, data.index, ['Public_Bio_Short']),
      website: qdpArchiveLink_(qdpArchiveFirstText_(row, data.index, ['Public_URL', 'Website'])),
      instagram: qdpArchiveLink_(qdpArchiveValue_(row, data.index, ['Instagram']), 'instagram')
    };
    profiles.set(id, kind === 'artists'
      ? {
          ...shared,
          music: qdpArchiveLink_(qdpArchiveFirstText_(row, data.index,
            ['Music_URL', 'Music', 'SoundCloud', 'Bandcamp', 'Mixcloud']))
        }
      : {
          ...shared,
          neighborhood: qdpArchiveText_(row, data.index, ['Neighborhood']),
          address: qdpArchiveText_(row, data.index, ['Address']),
          maps: qdpArchiveLink_(qdpArchiveValue_(row, data.index, ['GMaps_URL']))
        });
  });
  return profiles;
}

function qdpArchivePublicEvent_(row, index, source, artists, venues, flags) {
  // No legacy tab is assumed public merely because it has an archive name.
  if (!qdpArchiveYes_(qdpArchiveValue_(row, index, ['Publish_To_Web', 'Publish To Web']))) return null;
  const status = qdpArchiveText_(row, index, ['Status']);
  if (/cancel|delet|draft|private|reject/i.test(status)) return null;
  const eventId = qdpArchiveText_(row, index, ['EventID', 'Event ID']);
  const title = qdpArchiveFirstText_(row, index,
    ['Title_Public (auto w/ emojis)', 'Title_Public', 'Title (internal)', 'Title']);
  if (!eventId || !title || /^\(DELETED ENTRY\)/i.test(title)) return null;
  const timezone = qdpArchiveText_(row, index, ['Timezone', 'Time zone']) || 'America/New_York';
  const start = qdpPublicDateTime_(
    qdpArchiveValue_(row, index, ['StartDate', 'Start Date']),
    qdpArchiveValue_(row, index, ['StartTime', 'Start Time']), timezone);
  if (!start) return null;
  const end = qdpPublicDateTime_(
    qdpArchiveValue_(row, index, ['EndDate', 'End Date']),
    qdpArchiveValue_(row, index, ['EndTime', 'End Time']), timezone);
  const venueId = qdpArchiveText_(row, index, ['VenueID', 'Venue Id', 'Venue ID']);
  const publicVenue = venues.get(venueId);
  const rawArtistIds = qdpArchiveText_(row, index,
    ['ArtistIDs (comma-separated)', 'ArtistIDs', 'Artist IDs'])
    .split(',').map(id => id.trim()).filter(Boolean);
  const publicArtistIds = rawArtistIds.filter(id => artists.has(id));
  const rawDescription = qdpArchiveText_(row, index, ['Description']);
  const flyerCandidate = qdpArchiveText_(row, index, ['Flyer_URL', 'Flyer URL', 'FlyerURL']) ||
    extractFlyerUrl_(rawDescription);
  return {
    eventId, title, start, end,
    description: stripAllQdpMetadata_(rawDescription),
    venue: venueId
      ? (publicVenue ? publicVenue.name : 'Location not disclosed')
      : qdpArchiveText_(row, index, ['Location']),
    address: publicVenue ? publicVenue.address : '',
    venueId: publicVenue ? venueId : '',
    artistIds: [...new Set(publicArtistIds)],
    flyerUrl: qdpArchiveLink_(flyerCandidate),
    explicitQueer: qdpArchiveYes_(qdpArchiveValue_(row, index,
      ['ExplicitQueer (Yes/No)', 'ExplicitQueer'])),
    queerArtist: rawArtistIds.some(id => flags.get(id)?.queer === true),
    transArtist: rawArtistIds.some(id => flags.get(id)?.trans === true),
    status: status || (source === CONFIG.SHEET_EVENTS ? 'Current listing' : 'Past Event'),
    public: true
  };
}

function qdpArchiveEventSets_(ss, artists, venues, includeActive) {
  const flags = qdpPublicArtistFlags_();
  const archivedById = new Map();
  const allById = new Map();
  (includeActive ? [...QDP_ARCHIVE_TABS_, CONFIG.SHEET_EVENTS] : QDP_ARCHIVE_TABS_).forEach(name => {
    const data = qdpArchiveSheet_(ss, name);
    if (!data) return;
    // A missing publication header excludes this entire sheet, even if rows
    // have public looking titles, because an archive may contain private data.
    if (data.index.publish_to_web == null && data.index['publish to web'] == null) return;
    data.rows.forEach(row => {
      const event = qdpArchivePublicEvent_(row, data.index, name, artists, venues, flags);
      if (!event) return;
      allById.set(event.eventId, event);
      if (name !== CONFIG.SHEET_EVENTS) archivedById.set(event.eventId, event);
    });
  });
  return { archived: [...archivedById.values()], all: [...allById.values()] };
}

function qdpArchiveEvents_(ss, includeActive, artists, venues) {
  const sets = qdpArchiveEventSets_(ss, artists, venues, includeActive);
  return includeActive ? sets.all : sets.archived;
}

function qdpArchiveResource_(resource, parameters) {
  const params = parameters || {};
  const ss = ss_();
  const artists = qdpArchiveProfiles_(ss, 'artists');
  const venues = qdpArchiveProfiles_(ss, 'venues');
  const sortByName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  if (resource === 'archiveartists') {
    return { artists: [...artists.values()].sort(sortByName) };
  }
  if (resource === 'archivevenues') {
    return { venues: [...venues.values()].sort(sortByName) };
  }
  if (resource === 'archivemonths') {
    const counts = new Map();
    qdpArchiveEvents_(ss, false, artists, venues).forEach(event => {
      const month = event.start.slice(0, 7);
      counts.set(month, (counts.get(month) || 0) + 1);
    });
    return { months: [...counts].map(([month, count]) => ({ month, count }))
      .sort((a, b) => b.month.localeCompare(a.month)) };
  }
  const id = trim(params.id);
  if (resource === 'archiveartist' || resource === 'archivevenue') {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid profile ID.');
    const isArtist = resource === 'archiveartist';
    const profile = (isArtist ? artists : venues).get(id);
    if (!profile) throw new Error('Public profile not found.');
    const events = qdpArchiveEvents_(ss, true, artists, venues)
      .filter(event => isArtist ? event.artistIds.includes(id) : event.venueId === id);
    return { profile: { ...profile, count: events.length }, events };
  }
  if (resource === 'archivemonth') {
    const month = trim(params.month);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid archive month.');
    return { events: qdpArchiveEvents_(ss, false, artists, venues)
      .filter(event => event.start.slice(0, 7) === month) };
  }
  throw new Error('Unknown archive resource.');
}

// Safe manual check in the Apps Script editor; logs counts, never event data.
function qdpArchivePreviewCheck() {
  const months = qdpArchiveResource_('archivemonths', {}).months;
  const artists = qdpArchiveResource_('archiveartists', {}).artists;
  const venues = qdpArchiveResource_('archivevenues', {}).venues;
  Logger.log(JSON.stringify({
    artistCount: artists.length,
    venueCount: venues.length,
    archiveMonthCount: months.length,
    archivedEventCount: months.reduce((sum, month) => sum + month.count, 0)
  }));
}

// The publisher lives in this same Apps Script project. It prepares the
// public archive once, then the Pages preview reads small prebuilt records.
// Set these three Script Properties before running qdpArchivePublish:
// QDP_ARCHIVE_CF_ACCOUNT_ID, QDP_ARCHIVE_CF_NAMESPACE_ID,
// QDP_ARCHIVE_CF_API_TOKEN (Workers KV Storage Write permission).
const QDP_ARCHIVE_KV_PREFIX_ = 'qdp-archive:v1:';
const QDP_ARCHIVE_SHARDS_ = { artist: 4, venue: 2, month: 4 };

function qdpArchiveShard_(id, count) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % count;
}

function qdpArchivePublishSource_(ss) {
  for (const name of QDP_ARCHIVE_TABS_) {
    const sheet = ss.getSheetByName(name);
    const headers = sheet && sheet.getLastColumn() > 0
      ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] : [];
    const index = qdpArchiveIndex_(headers);
    if (!sheet || (index.publish_to_web == null && index['publish to web'] == null)) {
      throw new Error('Cannot publish: ' + name + ' is missing or has no Publish_To_Web header.');
    }
  }
  const artists = qdpArchiveProfiles_(ss, 'artists');
  const venues = qdpArchiveProfiles_(ss, 'venues');
  if (!artists.size || !venues.size) throw new Error('Cannot publish an empty public directory.');
  const sets = qdpArchiveEventSets_(ss, artists, venues, true);
  if (!sets.archived.length) throw new Error('Cannot publish an empty archive.');
  return qdpArchiveSnapshot_(artists, venues, sets);
}

function qdpArchiveSnapshot_(artists, venues, sets) {
  const sortByName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  const artistEntries = Object.create(null);
  const venueEntries = Object.create(null);
  const monthEntries = Object.create(null);
  artists.forEach((profile, id) => {
    artistEntries[id] = { profile: { ...profile, count: 0 }, events: [] };
  });
  venues.forEach((profile, id) => {
    venueEntries[id] = { profile: { ...profile, count: 0 }, events: [] };
  });
  sets.all.forEach(event => {
    event.artistIds.forEach(id => {
      if (Object.prototype.hasOwnProperty.call(artistEntries, id)) artistEntries[id].events.push(event);
    });
    if (Object.prototype.hasOwnProperty.call(venueEntries, event.venueId)) {
      venueEntries[event.venueId].events.push(event);
    }
  });
  Object.keys(artistEntries).forEach(id => {
    artistEntries[id].profile.count = artistEntries[id].events.length;
  });
  Object.keys(venueEntries).forEach(id => {
    venueEntries[id].profile.count = venueEntries[id].events.length;
  });
  sets.archived.forEach(event => {
    const month = event.start.slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return;
    if (!Object.prototype.hasOwnProperty.call(monthEntries, month)) monthEntries[month] = { events: [] };
    monthEntries[month].events.push(event);
  });
  return {
    artists: [...artists.values()].sort(sortByName),
    venues: [...venues.values()].sort(sortByName),
    months: Object.keys(monthEntries).sort().reverse()
      .map(month => ({ month, count: monthEntries[month].events.length })),
    artistEntries, venueEntries, monthEntries
  };
}

function qdpArchiveKvRecords_(snapshot, revision) {
  const records = [];
  const add = (key, data) => {
    const value = JSON.stringify({ revision, ...data });
    // The KV value limit is 25 MiB. Fail before writing any partial snapshot.
    if (Utilities.newBlob(value).getBytes().length > 25 * 1024 * 1024) {
      throw new Error('Archive record exceeds the Cloudflare KV value limit: ' + key);
    }
    records.push({ key: QDP_ARCHIVE_KV_PREFIX_ + key, value });
  };
  add('artists', { payload: { artists: snapshot.artists } });
  add('venues', { payload: { venues: snapshot.venues } });
  add('months', { payload: { months: snapshot.months } });
  for (const [kind, entries] of [
    ['artist', snapshot.artistEntries], ['venue', snapshot.venueEntries], ['month', snapshot.monthEntries]
  ]) {
    const shards = Array.from({ length: QDP_ARCHIVE_SHARDS_[kind] }, () => Object.create(null));
    Object.keys(entries).forEach(id => {
      shards[qdpArchiveShard_(id, shards.length)][id] = entries[id];
    });
    shards.forEach((items, index) => add(kind + ':' + index, { entries: items }));
  }
  return records;
}

function qdpArchiveCloudflareRequest_(url, token, method, payload, contentType) {
  const response = UrlFetchApp.fetch(url, {
    method, contentType,
    headers: { Authorization: 'Bearer ' + token },
    payload, muteHttpExceptions: true
  });
  let result;
  try { result = JSON.parse(response.getContentText()); } catch (_) { result = null; }
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300 || !result?.success) {
    // Never log the token or a response that might include archive content.
    throw new Error('Cloudflare archive write failed (HTTP ' + response.getResponseCode() + ').');
  }
  return result.result;
}

function qdpArchivePublish_(force) {
  const properties = PropertiesService.getScriptProperties();
  const account = trim(properties.getProperty('QDP_ARCHIVE_CF_ACCOUNT_ID'));
  const namespace = trim(properties.getProperty('QDP_ARCHIVE_CF_NAMESPACE_ID'));
  const token = trim(properties.getProperty('QDP_ARCHIVE_CF_API_TOKEN'));
  if (!/^[a-f0-9]{32}$/i.test(account) || !/^[a-f0-9]{32}$/i.test(namespace) || !token) {
    throw new Error('Set the Cloudflare account ID, KV namespace ID, and write token in Script Properties first.');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const snapshot = qdpArchivePublishSource_(ss_());
    const digest = Utilities.base64EncodeWebSafe(Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, JSON.stringify(snapshot)));
    const fingerprint = account + ':' + namespace + ':' + digest;
    if (!force && properties.getProperty('QDP_ARCHIVE_LAST_PUBLISHED') === fingerprint) {
      Logger.log('Public archive is unchanged; no Cloudflare write needed.');
      return;
    }
    const revision = Utilities.getUuid();
    const records = qdpArchiveKvRecords_(snapshot, revision);
    const base = 'https://api.cloudflare.com/client/v4/accounts/' + account +
      '/storage/kv/namespaces/' + namespace;
    const outcome = qdpArchiveCloudflareRequest_(base + '/bulk', token, 'put',
      JSON.stringify(records), 'application/json');
    if (outcome?.successful_key_count !== records.length || outcome.unsuccessful_keys?.length) {
      throw new Error('Cloudflare did not confirm all archive records. The manifest was not updated.');
    }
    // Publish the manifest last. Readers detect a mismatched revision and use
    // the live feed until all the new records have propagated to their region.
    const manifest = {
      schema: 1, revision, updatedAt: new Date().toISOString(),
      artists: Object.keys(snapshot.artistEntries),
      venues: Object.keys(snapshot.venueEntries),
      months: Object.keys(snapshot.monthEntries)
    };
    qdpArchiveCloudflareRequest_(base + '/values/' +
      encodeURIComponent(QDP_ARCHIVE_KV_PREFIX_ + 'manifest'), token, 'put',
      JSON.stringify(manifest), 'application/octet-stream');
    properties.setProperty('QDP_ARCHIVE_LAST_PUBLISHED', fingerprint);
    Logger.log(JSON.stringify({ artistCount: manifest.artists.length,
      venueCount: manifest.venues.length, archiveMonthCount: manifest.months.length,
      archivedEventCount: snapshot.months.reduce((sum, item) => sum + item.count, 0),
      recordCount: records.length, publishedAt: manifest.updatedAt }));
  } finally {
    lock.releaseLock();
  }
}

function qdpArchivePublish() { qdpArchivePublish_(false); }

// Use this if the namespace was cleared or its binding changed without a
// spreadsheet change. It rewrites the snapshot even when the data is the same.
function qdpArchiveForcePublish() { qdpArchivePublish_(true); }

// Run once to check for direct edits to the Sheet every 15 minutes.
// Unchanged data costs zero KV writes. Calling this again creates no duplicate.
function qdpArchiveInstallRefreshTrigger() {
  const name = 'qdpArchivePublish';
  if (ScriptApp.getProjectTriggers().some(trigger => trigger.getHandlerFunction() === name)) return;
  ScriptApp.newTrigger(name).timeBased().everyMinutes(15).create();
}

// Keep the existing public events response ready for first-time visitors. This
// calls the same doGet used by /api/events; it does not read a second event
// source or change the public Web app's dispatch.
function qdpLivePublish() {
  const properties = PropertiesService.getScriptProperties();
  const account = trim(properties.getProperty('QDP_ARCHIVE_CF_ACCOUNT_ID'));
  const namespace = trim(properties.getProperty('QDP_ARCHIVE_CF_NAMESPACE_ID'));
  const token = trim(properties.getProperty('QDP_ARCHIVE_CF_API_TOKEN'));
  if (!/^[a-f0-9]{32}$/i.test(account) || !/^[a-f0-9]{32}$/i.test(namespace) || !token) {
    throw new Error('Set the existing Cloudflare account ID, KV namespace ID, and write token first.');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const output = doGet({ parameter: { resource: 'events' } });
    const source = JSON.parse(output.getContent());
    if (!Array.isArray(source.events)) throw new Error('The public events feed is unavailable.');
    const events = source.events.map(event => {
      if (!event || !trim(event.eventId) || !trim(event.title) ||
          Number.isNaN(Date.parse(event.start))) {
        throw new Error('The public events feed contains an invalid event.');
      }
      return {
        eventId: trim(event.eventId),
        hasVenueId: event.hasVenueId === true,
        title: trim(event.title),
        start: trim(event.start),
        end: trim(event.end),
        venue: trim(event.venue),
        address: trim(event.address),
        explicitQueer: event.explicitQueer === true,
        queerArtist: event.queerArtist === true,
        transArtist: event.transArtist === true,
        description: stripAllQdpMetadata_(trim(event.description)),
        flyerUrl: qdpArchiveLink_(event.flyerUrl)
      };
    });
    const publishedAt = new Date().toISOString();
    const record = JSON.stringify({ schema: 1, publishedAt,
      payload: { generatedAt: source.generatedAt || publishedAt, events } });
    if (Utilities.newBlob(record).getBytes().length > 25 * 1024 * 1024) {
      throw new Error('The public events feed exceeds the Cloudflare KV value limit.');
    }
    const url = 'https://api.cloudflare.com/client/v4/accounts/' + account +
      '/storage/kv/namespaces/' + namespace + '/values/' +
      encodeURIComponent('qdp-live:v1:feed');
    qdpArchiveCloudflareRequest_(url, token, 'put', record, 'application/octet-stream');
    Logger.log(JSON.stringify({ liveEventCount: events.length, publishedAt }));
  } finally {
    lock.releaseLock();
  }
}

// Run once. The five-minute refresh retains the current feed's update cadence.
function qdpLiveInstallRefreshTrigger() {
  const name = 'qdpLivePublish';
  if (ScriptApp.getProjectTriggers().some(trigger => trigger.getHandlerFunction() === name)) return;
  ScriptApp.newTrigger(name).timeBased().everyMinutes(5).create();
}
