/*
 * QDP archive feed extension for the existing Apps Script project.
 * The helpers can live in Code.gs or another .gs file in that same project.
 * Add the small dispatch to the existing doGet as documented in README.md.
 * This file reads the live spreadsheet through ss_(); it never writes to it.
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

function qdpArchiveEvents_(ss, includeActive, artists, venues) {
  const flags = qdpPublicArtistFlags_();
  const byId = new Map();
  const sheets = includeActive
    ? [...QDP_ARCHIVE_TABS_, CONFIG.SHEET_EVENTS]
    : QDP_ARCHIVE_TABS_;
  sheets.forEach(name => {
    const data = qdpArchiveSheet_(ss, name);
    if (!data) return;
    // A missing publication header excludes this entire sheet, even if rows
    // have public looking titles, because an archive may contain private data.
    if (data.index.publish_to_web == null && data.index['publish to web'] == null) return;
    data.rows.forEach(row => {
      const event = qdpArchivePublicEvent_(row, data.index, name, artists, venues, flags);
      if (event) byId.set(event.eventId, event);
    });
  });
  return [...byId.values()];
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
