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
  return value === true || /^yes$/i.test(trim(value));
}

function qdpArchiveIds_(value) {
  return [...new Set(trim(value).split(',').map(id => id.trim()).filter(Boolean))];
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

function qdpArchiveProfiles_(ss, kind, artistFlags) {
  const name = kind === 'artists' ? CONFIG.SHEET_ARTISTS : kind === 'venues'
    ? CONFIG.SHEET_VENUES : kind === 'parties'
      ? (CONFIG.SHEET_PARTIES || 'Parties') : (CONFIG.SHEET_COLLECTIVES || 'Collectives');
  const data = qdpArchiveSheet_(ss, name);
  if (!data) throw new Error('Missing ' + name + ' sheet.');
  const idField = { artists: 'ArtistID', venues: 'VenueID', parties: 'PartyID', collectives: 'CollectiveID' }[kind];
  if (!idField || data.index[idField.toLowerCase()] == null ||
      data.index.public_ok == null) {
    throw new Error(name + ' requires its ID and public fields.');
  }
  const flags = kind === 'artists' ? (artistFlags || qdpPublicArtistFlags_()) : null;
  const profiles = new Map();
  data.rows.forEach(row => {
    if (!qdpArchiveYes_(qdpArchiveValue_(row, data.index, ['Public_OK']))) return;
    const id = qdpArchiveText_(row, data.index, [idField]);
    const displayName = qdpArchiveFirstText_(row, data.index,
      { artists: ['StageName'], venues: ['Public_Name', 'VenueName'],
        parties: ['PartyName'], collectives: ['Public_Name', 'CollectiveName'] }[kind]);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !displayName) return;
    const shared = {
      id, name: displayName, publicOk: true,
      bio: qdpArchiveText_(row, data.index, kind === 'parties' ? ['PartyDesc'] :
        kind === 'collectives' ? ['CollBio'] : ['Public_Bio_Short']),
      website: qdpArchiveLink_(qdpArchiveFirstText_(row, data.index, ['Public_URL', 'Website'])),
      instagram: qdpArchiveLink_(qdpArchiveFirstText_(row, data.index,
        { artists: ['Instagram'], venues: ['Instagram'], parties: ['PartyInsta'],
          collectives: ['CollInsta'] }[kind]), 'instagram')
    };
    profiles.set(id, kind === 'artists'
      ? {
          ...shared,
          queerArtist: flags.get(id)?.queer === true,
          transArtist: flags.get(id)?.trans === true,
          partyIds: qdpArchiveIds_(qdpArchiveValue_(row, data.index, ['Artist_Parties'])),
          collectiveIds: qdpArchiveIds_(qdpArchiveValue_(row, data.index, ['Artist_Collectives'])),
          music: qdpArchiveLink_(qdpArchiveFirstText_(row, data.index,
            ['Music_URL', 'Music', 'SoundCloud', 'Bandcamp', 'Mixcloud']))
        }
      : kind === 'venues' ? {
          ...shared,
          queerVenue: qdpArchiveYes_(qdpArchiveValue_(row, data.index, ['VenueQueer', 'QueerVenue', 'Queer'])),
          neighborhood: qdpArchiveText_(row, data.index, ['Neighborhood']),
          address: qdpArchiveText_(row, data.index, ['Address']),
          maps: qdpArchiveLink_(qdpArchiveValue_(row, data.index, ['GMaps_URL']))
        } : kind === 'parties' ? {
          ...shared,
          queerParty: qdpArchiveYes_(qdpArchiveValue_(row, data.index, ['PartyQueer', 'QueerParty'])),
          artistIds: qdpArchiveIds_(qdpArchiveValue_(row, data.index, ['PartyArtists'])),
          collectiveIds: qdpArchiveIds_(qdpArchiveValue_(row, data.index, ['PartyColls']))
        } : {
          ...shared,
          queerCollective: qdpArchiveYes_(qdpArchiveValue_(row, data.index, ['CollQueer', 'QueerCollective'])),
          artistIds: qdpArchiveIds_(qdpArchiveValue_(row, data.index, ['CollArtists'])),
          partyIds: qdpArchiveIds_(qdpArchiveValue_(row, data.index, ['CollParty']))
        });
  });
  return profiles;
}

function qdpArchiveRelateProfiles_(artists, parties, collectives) {
  const maps = { artist: artists, party: parties, collective: collectives };
  Object.values(maps).forEach(map => map.forEach(profile => { profile.related = []; }));
  const add = (profile, kind, target) => {
    if (!profile.related.some(item => item.kind === kind && item.id === target.id)) {
      profile.related.push({ kind, id: target.id, name: target.name });
    }
  };
  const link = (kind, profile, targetKind, id) => {
    const target = maps[targetKind].get(id);
    if (!target) return;
    add(profile, targetKind, target);
    add(target, kind, profile);
    if (kind === 'collective' && targetKind === 'party' && !target.collectiveIds.includes(profile.id)) {
      target.collectiveIds.push(profile.id);
    }
  };
  // Use the declared ID columns in either direction, never event history.
  artists.forEach(profile => {
    profile.partyIds.forEach(id => link('artist', profile, 'party', id));
    profile.collectiveIds.forEach(id => link('artist', profile, 'collective', id));
  });
  parties.forEach(profile => {
    profile.collectiveIds = profile.collectiveIds.filter(id => collectives.has(id));
    profile.artistIds.forEach(id => link('party', profile, 'artist', id));
    profile.collectiveIds.forEach(id => link('party', profile, 'collective', id));
  });
  collectives.forEach(profile => {
    profile.artistIds.forEach(id => link('collective', profile, 'artist', id));
    profile.partyIds.forEach(id => link('collective', profile, 'party', id));
  });
  artists.forEach(profile => { delete profile.partyIds; delete profile.collectiveIds; });
  parties.forEach(profile => { delete profile.artistIds; });
  collectives.forEach(profile => { delete profile.artistIds; delete profile.partyIds; });
}

function qdpArchivePublicEvent_(row, index, source, artists, venues, parties, collectives, flags) {
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
  const rawArtistIds = qdpArchiveIds_(qdpArchiveValue_(row, index,
    ['ArtistIDs (comma-separated)', 'ArtistIDs', 'Artist IDs']));
  const publicArtistIds = rawArtistIds.filter(id => artists.has(id));
  const rawPartyId = qdpArchiveText_(row, index, ['PartyID']);
  const rawCollectiveIds = qdpArchiveIds_(qdpArchiveValue_(row, index,
    ['HostCollectiveIDs (comma-separated)', 'HostCollectiveIDs']));
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
    partyId: parties.has(rawPartyId) ? rawPartyId : '',
    collectiveIds: [...new Set([...rawCollectiveIds, ...(parties.get(rawPartyId)?.collectiveIds || [])]
      .filter(id => collectives.has(id)))],
    flyerUrl: qdpArchiveLink_(flyerCandidate),
    explicitQueer: qdpArchiveYes_(qdpArchiveValue_(row, index,
      ['ExplicitQueer (Yes/No)', 'ExplicitQueer'])),
    queerArtist: rawArtistIds.some(id => flags.get(id)?.queer === true),
    transArtist: rawArtistIds.some(id => flags.get(id)?.trans === true),
    status: status || (source === CONFIG.SHEET_EVENTS ? 'Current listing' : 'Past Event'),
    public: true
  };
}

function qdpArchiveEventSets_(ss, artists, venues, parties, collectives, includeActive,
  flags = qdpPublicArtistFlags_()) {
  const archivedById = new Map();
  const allById = new Map();
  const excludedIds = new Set();
  (includeActive ? [...QDP_ARCHIVE_TABS_, CONFIG.SHEET_EVENTS] : QDP_ARCHIVE_TABS_).forEach(name => {
    const data = qdpArchiveSheet_(ss, name);
    if (!data) return;
    // A missing publication header excludes this entire sheet, even if rows
    // have public looking titles, because an archive may contain private data.
    if (data.index.publish_to_web == null && data.index['publish to web'] == null) return;
    data.rows.forEach(row => {
      const event = qdpArchivePublicEvent_(row, data.index, name, artists, venues,
        parties, collectives, flags);
      if (!event) {
        // The active row is authoritative if an old archived copy has the same ID.
        if (name === CONFIG.SHEET_EVENTS) {
          const id = qdpArchiveText_(row, data.index, ['EventID', 'Event ID']);
          if (id) { allById.delete(id); archivedById.delete(id); excludedIds.add(id); }
        }
        return;
      }
      excludedIds.delete(event.eventId);
      allById.set(event.eventId, event);
      if (name !== CONFIG.SHEET_EVENTS) archivedById.set(event.eventId, event);
    });
  });
  return { archived: [...archivedById.values()], all: [...allById.values()], excludedIds: [...excludedIds] };
}

function qdpArchivePastEvents_(events) {
  const now = new Date();
  const today = Utilities.formatDate(now, 'America/New_York', 'yyyy-MM-dd');
  return events.filter(event => event.start.slice(0, 10) < today ||
    (event.end && Date.parse(event.end) <= now.getTime()));
}

function qdpArchiveEvents_(ss, includeActive, artists, venues, parties, collectives, flags) {
  const sets = qdpArchiveEventSets_(ss, artists, venues, parties, collectives, includeActive, flags);
  return includeActive ? sets.all : sets.archived;
}

function qdpArchiveResource_(resource, parameters) {
  const params = parameters || {};
  const ss = ss_();
  const flags = qdpPublicArtistFlags_();
  const artists = qdpArchiveProfiles_(ss, 'artists', flags);
  const venues = qdpArchiveProfiles_(ss, 'venues');
  const parties = qdpArchiveProfiles_(ss, 'parties');
  const collectives = qdpArchiveProfiles_(ss, 'collectives');
  qdpArchiveRelateProfiles_(artists, parties, collectives);
  const sortByName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  const directories = { archiveartists: ['artists', artists], archivevenues: ['venues', venues],
    archiveparties: ['parties', parties], archivecollectives: ['collectives', collectives] };
  if (directories[resource]) {
    const [key, profiles] = directories[resource];
    return { [key]: [...profiles.values()].sort(sortByName) };
  }
  if (resource === 'archivemonths') {
    const counts = new Map();
    qdpArchivePastEvents_(qdpArchiveEvents_(ss, true, artists, venues, parties, collectives, flags)).forEach(event => {
      const month = event.start.slice(0, 7);
      counts.set(month, (counts.get(month) || 0) + 1);
    });
    return { months: [...counts].map(([month, count]) => ({ month, count }))
      .sort((a, b) => b.month.localeCompare(a.month)) };
  }
  const id = trim(params.id);
  const profilesByResource = { archiveartist: artists, archivevenue: venues,
    archiveparty: parties, archivecollective: collectives };
  if (profilesByResource[resource]) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid profile ID.');
    const profile = profilesByResource[resource].get(id);
    if (!profile) throw new Error('Public profile not found.');
    const events = qdpArchiveEvents_(ss, true, artists, venues, parties, collectives, flags)
      .filter(event => resource === 'archiveartist' ? event.artistIds.includes(id) :
        resource === 'archivevenue' ? event.venueId === id :
          resource === 'archiveparty' ? event.partyId === id : event.collectiveIds.includes(id));
    return { profile: { ...profile, count: events.length }, events };
  }
  if (resource === 'archivemonth') {
    const month = trim(params.month);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid archive month.');
    return { events: qdpArchivePastEvents_(qdpArchiveEvents_(ss, true, artists, venues, parties, collectives, flags))
      .filter(event => event.start.slice(0, 7) === month) };
  }
  throw new Error('Unknown archive resource.');
}

// Safe manual check in the Apps Script editor; logs counts, never event data.
function qdpArchivePreviewCheck() {
  const months = qdpArchiveResource_('archivemonths', {}).months;
  const artists = qdpArchiveResource_('archiveartists', {}).artists;
  const venues = qdpArchiveResource_('archivevenues', {}).venues;
  const parties = qdpArchiveResource_('archiveparties', {}).parties;
  const collectives = qdpArchiveResource_('archivecollectives', {}).collectives;
  Logger.log(JSON.stringify({
    artistCount: artists.length,
    venueCount: venues.length,
    partyCount: parties.length,
    collectiveCount: collectives.length,
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
const QDP_ARCHIVE_SHARDS_ = { artist: 4, venue: 2, party: 2, collective: 2, month: 4, event: 8 };

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
  const flags = qdpPublicArtistFlags_();
  const artists = qdpArchiveProfiles_(ss, 'artists', flags);
  const venues = qdpArchiveProfiles_(ss, 'venues');
  const parties = qdpArchiveProfiles_(ss, 'parties');
  const collectives = qdpArchiveProfiles_(ss, 'collectives');
  qdpArchiveRelateProfiles_(artists, parties, collectives);
  if (!artists.size || !venues.size) throw new Error('Cannot publish an empty public directory.');
  const sets = qdpArchiveEventSets_(ss, artists, venues, parties, collectives, true, flags);
  if (!sets.archived.length) throw new Error('Cannot publish an empty archive.');
  return qdpArchiveSnapshot_(artists, venues, parties, collectives, sets);
}

function qdpArchiveSnapshot_(artists, venues, parties, collectives, sets) {
  const sortByName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  const artistEntries = Object.create(null);
  const venueEntries = Object.create(null);
  const partyEntries = Object.create(null);
  const collectiveEntries = Object.create(null);
  const monthEntries = Object.create(null);
  const eventEntries = Object.create(null);
  artists.forEach((profile, id) => {
    artistEntries[id] = { profile: { ...profile, count: 0 }, events: [] };
  });
  venues.forEach((profile, id) => {
    venueEntries[id] = { profile: { ...profile, count: 0 }, events: [] };
  });
  parties.forEach((profile, id) => {
    partyEntries[id] = { profile: { ...profile, count: 0 }, events: [] };
  });
  collectives.forEach((profile, id) => {
    collectiveEntries[id] = { profile: { ...profile, count: 0 }, events: [] };
  });
  sets.all.forEach(event => {
    const related = [];
    const addRelated = (kind, id, entries) => {
      if (id && entries[id]) related.push({ kind, id, name: entries[id].profile.name });
    };
    event.artistIds.forEach(id => addRelated('artist', id, artistEntries));
    addRelated('venue', event.venueId, venueEntries);
    addRelated('party', event.partyId, partyEntries);
    event.collectiveIds.forEach(id => addRelated('collective', id, collectiveEntries));
    eventEntries[event.eventId] = { ...event, related };
    event.artistIds.forEach(id => {
      if (Object.prototype.hasOwnProperty.call(artistEntries, id)) artistEntries[id].events.push(event);
    });
    if (Object.prototype.hasOwnProperty.call(venueEntries, event.venueId)) {
      venueEntries[event.venueId].events.push(event);
    }
    if (Object.prototype.hasOwnProperty.call(partyEntries, event.partyId)) {
      partyEntries[event.partyId].events.push(event);
    }
    event.collectiveIds.forEach(id => {
      if (Object.prototype.hasOwnProperty.call(collectiveEntries, id)) {
        collectiveEntries[id].events.push(event);
      }
    });
  });
  Object.keys(artistEntries).forEach(id => {
    artistEntries[id].profile.count = artistEntries[id].events.length;
  });
  Object.keys(venueEntries).forEach(id => {
    venueEntries[id].profile.count = venueEntries[id].events.length;
  });
  Object.keys(partyEntries).forEach(id => {
    partyEntries[id].profile.count = partyEntries[id].events.length;
  });
  Object.keys(collectiveEntries).forEach(id => {
    collectiveEntries[id].profile.count = collectiveEntries[id].events.length;
  });
  qdpArchivePastEvents_(sets.all).forEach(event => {
    const month = event.start.slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return;
    if (!Object.prototype.hasOwnProperty.call(monthEntries, month)) monthEntries[month] = { events: [] };
    monthEntries[month].events.push(event);
  });
  return {
    artists: [...artists.values()].sort(sortByName),
    venues: [...venues.values()].sort(sortByName),
    parties: [...parties.values()].sort(sortByName),
    collectives: [...collectives.values()].sort(sortByName),
    months: Object.keys(monthEntries).sort().reverse()
      .map(month => ({ month, count: monthEntries[month].events.length })),
    artistEntries, venueEntries, partyEntries, collectiveEntries, monthEntries, eventEntries,
    excludedEventIds: sets.excludedIds || []
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
  add('parties', { payload: { parties: snapshot.parties } });
  add('collectives', { payload: { collectives: snapshot.collectives } });
  add('months', { payload: { months: snapshot.months } });
  for (const [kind, entries] of [
    ['artist', snapshot.artistEntries], ['venue', snapshot.venueEntries],
    ['party', snapshot.partyEntries], ['collective', snapshot.collectiveEntries],
    ['month', snapshot.monthEntries], ['event', snapshot.eventEntries]
  ]) {
    const shards = Array.from({ length: QDP_ARCHIVE_SHARDS_[kind] }, () => Object.create(null));
    Object.keys(entries).forEach(id => {
      shards[qdpArchiveShard_(id, shards.length)][id] = entries[id];
    });
    shards.forEach((items, index) => add(kind + ':' + index, { entries: items }));
  }
  return records;
}

// Keep each Apps Script URL Fetch request comfortably below its 50 MiB body limit.
function qdpArchiveBulkBatches_(records, maxBytes = 24 * 1024 * 1024) {
  const batches = [];
  let batch = [];
  let bytes = 2; // JSON array brackets
  records.forEach(record => {
    const recordBytes = Utilities.newBlob(JSON.stringify(record)).getBytes().length;
    if (recordBytes + 2 > 50 * 1024 * 1024) {
      throw new Error('Archive record exceeds the Apps Script URL Fetch request limit.');
    }
    if (batch.length && bytes + recordBytes + 1 > maxBytes) {
      batches.push(batch);
      batch = [];
      bytes = 2;
    }
    bytes += recordBytes + (batch.length ? 1 : 0);
    batch.push(record);
  });
  if (batch.length) batches.push(batch);
  return batches;
}

function qdpArchiveCloudflareRequest_(url, token, method, payload, contentType) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = UrlFetchApp.fetch(url, {
        method, contentType,
        headers: { Authorization: 'Bearer ' + token },
        payload, muteHttpExceptions: true
      });
    } catch (error) {
      if (!/Address unavailable/i.test(String(error))) throw error;
      if (attempt === 2) throw new Error('Cloudflare connection unavailable after 3 attempts.');
      Utilities.sleep(1000 * (attempt + 1));
      continue;
    }
    const status = response.getResponseCode();
    if ((status === 429 || status >= 500) && attempt < 2) {
      Utilities.sleep(1000 * (attempt + 1));
      continue;
    }
    let result;
    try { result = JSON.parse(response.getContentText()); } catch (_) { result = null; }
    if (status < 200 || status >= 300 || !result?.success) {
      // Never log the token or a response that might include archive content.
      throw new Error('Cloudflare archive write failed (HTTP ' + status + ').');
    }
    return result.result;
  }
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
    const batches = qdpArchiveBulkBatches_(records);
    const base = 'https://api.cloudflare.com/client/v4/accounts/' + account +
      '/storage/kv/namespaces/' + namespace;
    batches.forEach(batch => {
      const outcome = qdpArchiveCloudflareRequest_(base + '/bulk', token, 'put',
        JSON.stringify(batch), 'application/json');
      if (outcome?.successful_key_count !== batch.length || outcome.unsuccessful_keys?.length) {
        throw new Error('Cloudflare did not confirm all archive records. The manifest was not updated.');
      }
    });
    // Publish the manifest last. Readers detect a mismatched revision and use
    // the live feed until all the new records have propagated to their region.
    const manifest = {
      schema: 1, revision, updatedAt: new Date().toISOString(),
      artists: Object.keys(snapshot.artistEntries),
      venues: Object.keys(snapshot.venueEntries),
      parties: Object.keys(snapshot.partyEntries),
      collectives: Object.keys(snapshot.collectiveEntries),
      months: Object.keys(snapshot.monthEntries),
      partyPublicGate: true,
      eventIndexVersion: 1, eventShards: QDP_ARCHIVE_SHARDS_.event,
      eventIds: Object.keys(snapshot.eventEntries),
      excludedEventIds: snapshot.excludedEventIds
    };
    qdpArchiveCloudflareRequest_(base + '/values/' +
      encodeURIComponent(QDP_ARCHIVE_KV_PREFIX_ + 'manifest'), token, 'put',
      JSON.stringify(manifest), 'application/octet-stream');
    properties.setProperty('QDP_ARCHIVE_LAST_PUBLISHED', fingerprint);
    Logger.log(JSON.stringify({ artistCount: manifest.artists.length,
      venueCount: manifest.venues.length, partyCount: manifest.parties.length,
      collectiveCount: manifest.collectives.length, archiveMonthCount: manifest.months.length,
      eventCount: manifest.eventIds.length,
      archivedEventCount: snapshot.months.reduce((sum, item) => sum + item.count, 0),
      recordCount: records.length, batchCount: batches.length, publishedAt: manifest.updatedAt }));
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
