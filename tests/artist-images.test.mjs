import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { onRequestGet } from '../functions/api/archive.js';
import { renderProfileInfo } from '../functions/profile-page.js';

const meta = globalThis.QDPProfileMetadata;
const publisherSources = [['repository publisher', fs.readFileSync(new URL('../apps-script/archive-feed.gs', import.meta.url), 'utf8')]];
if (process.env.QDP_PUBLIC_DATA_FILE) publisherSources.push(['PublicData.gs release', fs.readFileSync(process.env.QDP_PUBLIC_DATA_FILE, 'utf8')]);

for (const [name, source] of publisherSources) {
  test(`${name}: publishes only approved artists' converted image URLs`, () => {
    const context = vm.createContext({ Map, Set, Date, Object, String, Array, JSON, RegExp,
      CONFIG: { SHEET_ARTISTS: 'Artists' }, trim: value => String(value ?? '').trim() });
    vm.runInContext(source, context);
    context.qdpPublicReadContext_ = () => ({});
    // Deliberately shuffled headers: raw links must never substitute for the public URL.
    const headers = ['Raw_ArtistImage_URL', 'StageName', 'ArtistImage_URL', 'Public_OK', 'ArtistID'];
    context.qdpArchiveSheet_ = () => ({ index: Object.fromEntries(headers.map((h, i) => [h.toLowerCase(), i])), rows: [
      ['https://drive.google.com/file/d/RAW/view', 'Alpha', 'https://drive.google.com/uc?export=view&id=FINAL', 'Yes', 'A'],
      ['https://drive.google.com/file/d/RAW_ONLY/view', 'No photo', '', 'Yes', 'B'],
      ['', 'Unsafe', 'javascript:alert(1)', 'Yes', 'C'],
      ['', 'Private', 'https://example.com/private.jpg', 'No', 'PRIVATE']
    ] });
    const profiles = context.qdpArchiveProfiles_({}, 'artists', new Map());
    assert.equal(profiles.get('A').imageUrl, 'https://drive.google.com/uc?export=view&id=FINAL');
    assert.equal(profiles.get('B').imageUrl, '');
    assert.equal(profiles.get('C').imageUrl, '');
    assert.equal(profiles.has('PRIVATE'), false);
    const json = JSON.stringify([...profiles.values()]);
    assert.doesNotMatch(json, /Raw_ArtistImage_URL|RAW_ONLY|\/RAW\/|private\.jpg/);
  });
}

test('archive API retains a safe artist image URL and omits the raw column', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('This fixture must not make network requests'); });
  let serial = 0;
  for (const [imageUrl, expected] of [
    ['https://drive.google.com/uc?export=view&id=FINAL', 'https://drive.google.com/uc?export=view&id=FINAL'],
    ['javascript:alert(1)', ''], ['', '']
  ]) {
    const manifest = { schema: 1, revision: 'image-' + ++serial, artists: ['A'] };
    const record = { revision: manifest.revision, entries: { A: { profile: {
      id: 'A', name: 'Alpha', publicOk: true, imageUrl, Raw_ArtistImage_URL: 'private raw input'
    }, events: [] } } };
    const response = await onRequestGet({ request: new Request('https://images.example/api/archive?resource=artist&id=A'),
      env: { QDP_ARCHIVE_KV: { get: async key => key.endsWith(':manifest') ? manifest : record } } });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.profile.imageUrl, expected);
    assert.equal(Object.hasOwn(data.profile, 'Raw_ArtistImage_URL'), false);
  }
});

test('artist pages use the published image for any artist, including Callaia', () => {
  for (const id of ['A', 'CALLAIA-001']) {
    const profile = { id, name: 'Artist & Name', imageUrl: 'https://drive.google.com/uc?export=view&id=FINAL' };
    assert.equal(meta.artistImage(profile).src, 'https://lh3.googleusercontent.com/d/FINAL=w1600');
    const html = renderProfileInfo('artist', profile, 'https://images.example');
    assert.match(html, /src="https:\/\/lh3\.googleusercontent\.com\/d\/FINAL=w1600" alt="Artist &amp; Name"/);
    assert.ok(html.indexOf('<img') < html.indexOf('archive-profile-heading'));
    assert.doesNotMatch(html, /callaia\.jpg|width="undefined"|height="undefined"/);
    assert.doesNotMatch(renderProfileInfo('venue', profile, 'https://images.example'), /<img/);
  }
  assert.equal(meta.artistImage({ imageUrl: 'https://example.com/portrait.jpg' }).src, 'https://example.com/portrait.jpg');
});

test('an explicitly blank or unsafe image URL hides the photo, even for Callaia', () => {
  for (const imageUrl of ['', 'javascript:alert(1)', 'data:image/png;base64,abc']) {
    const profile = { id: 'CALLAIA-001', name: 'Callaia', imageUrl };
    assert.equal(meta.artistImage(profile), null);
    assert.doesNotMatch(renderProfileInfo('artist', profile, 'https://images.example'), /<img/);
  }
});

const corePath = process.env.QDP_CORE_FILE;
test('Core release: artist image conversion preserves blank, invalid, unchanged, and unrelated cells', { skip: !corePath }, () => {
  const core = fs.readFileSync(corePath, 'utf8');
  new vm.Script(core); // Syntax-check the complete installable file.
  assert.match(core, /\.addItem\('Update Artist Image URLs \(from Raw_ArtistImage_URL\)', 'updateArtistImageUrlsFromRawLinks'\)/);
  assert.match(core, /qdpShowApifyMenu\(\);/);
  const fn = name => { const start = core.indexOf(`function ${name}(`); assert.ok(start >= 0);
    const end = core.indexOf('\nfunction ', start + 1); return core.slice(start, end < 0 ? undefined : end); };
  const direct = id => 'https://drive.google.com/uc?export=view&id=' + id;
  const rows = [
    ['ArtistImage_URL', 'Unrelated', ' Raw_ArtistImage_URL '],
    ['', 'keep 1', 'https://drive.google.com/file/d/ONE/view?usp=sharing'],
    ['old', 'keep 2', 'https://drive.google.com/file/d/TWO\\_ID/view'],
    ['manual photo', 'keep 3', ''],
    ['=KEEP_FORMULA()', 'keep 4', 'https://unrelated.example/file/d/NO/view'],
    [direct('SAME'), 'keep 5', 'https://drive.google.com/file/d/SAME/view'],
    ['', 'keep 6', 'https://drive.google.com/file/d/LAST/view']
  ];
  const writes = [], logs = [];
  const sheet = { getLastRow: () => rows.length, getLastColumn: () => rows[0].length,
    getRange: (r, c, h, w) => ({ getValues: () => rows.slice(r - 1, r - 1 + h).map(row => row.slice(c - 1, c - 1 + w)),
      setValues: values => { writes.push([r, c, h, w]); values.forEach((row, i) => row.forEach((v, j) => { rows[r - 1 + i][c - 1 + j] = v; })); } }) };
  const context = vm.createContext({ CONFIG: { SHEET_ARTISTS: 'Artists' },
    ss_: () => ({ getSheetByName: name => { assert.equal(name, 'Artists'); return sheet; } }),
    trim: value => String(value ?? '').trim(), ui_: () => null, Logger: { log: text => logs.push(text) } });
  vm.runInContext(['getHeaderMap_', 'headerIndex_', 'directDriveImageUrl_', 'updateArtistImageUrlsFromRawLinks'].map(fn).join('\n'), context);
  context.updateArtistImageUrlsFromRawLinks();
  assert.deepEqual(writes, [[2, 1, 2, 1], [7, 1, 1, 1]]);
  assert.deepEqual(rows.slice(1).map(row => row[0]), [direct('ONE'), direct('TWO_ID'), 'manual photo', '=KEEP_FORMULA()', direct('SAME'), direct('LAST')]);
  assert.deepEqual(rows.slice(1).map(row => row[1]), ['keep 1', 'keep 2', 'keep 3', 'keep 4', 'keep 5', 'keep 6']);
  assert.match(logs.join('\n'), /Artists rows: 5/);
  writes.length = 0;
  context.updateArtistImageUrlsFromRawLinks();
  assert.equal(writes.length, 0);
  rows[0][2] = 'Missing source';
  assert.throws(() => context.updateArtistImageUrlsFromRawLinks(), /Raw_ArtistImage_URL column/);
});
