import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { onRequestGet } from '../functions/api/archive.js';
import { renderProfileDrawer, renderProfileInfo } from '../functions/profile-page.js';

const meta = globalThis.QDPProfileMetadata;
const imageKinds = [
  { kind: 'artist', directory: 'artists', sheet: 'Artists', image: 'ArtistImage_URL', id: 'ArtistID', name: 'StageName' },
  { kind: 'party', directory: 'parties', sheet: 'Parties', image: 'PartyImage_URL', id: 'PartyID', name: 'PartyName' }
];
const publisherSources = [['repository publisher', fs.readFileSync(new URL('../apps-script/archive-feed.gs', import.meta.url), 'utf8')]];
if (process.env.QDP_PUBLIC_DATA_FILE) publisherSources.push(['PublicData.gs release', fs.readFileSync(process.env.QDP_PUBLIC_DATA_FILE, 'utf8')]);

for (const [name, source] of publisherSources) {
  for (const { kind, directory, sheet, image, id, name: nameColumn } of imageKinds) {
    test(`${name}: publishes only approved ${kind} image URLs`, () => {
      const context = vm.createContext({ Map, Set, Date, Object, String, Array, JSON, RegExp,
        CONFIG: { SHEET_ARTISTS: 'Artists', SHEET_PARTIES: 'Parties' }, trim: value => String(value ?? '').trim() });
      vm.runInContext(source, context);
      context.qdpPublicReadContext_ = () => ({});
      // Deliberately shuffled headers: raw links must never substitute for the public URL.
      const headers = ['Raw_' + image, nameColumn, image, 'Public_OK', id];
      context.qdpArchiveSheet_ = (_, sheetName) => {
        assert.equal(sheetName, sheet);
        return { index: Object.fromEntries(headers.map((h, i) => [h.toLowerCase(), i])), rows: [
          ['https://drive.google.com/file/d/RAW/view', 'Alpha', 'https://drive.google.com/uc?export=view&id=FINAL', 'Yes', 'A'],
          ['https://drive.google.com/file/d/RAW_ONLY/view', 'No photo', '', 'Yes', 'B'],
          ['', 'Unsafe', 'javascript:alert(1)', 'Yes', 'C'],
          ['', 'Private', 'https://example.com/private.jpg', 'No', 'PRIVATE']
        ] };
      };
      const profiles = context.qdpArchiveProfiles_({}, directory, new Map());
      assert.equal(profiles.get('A').imageUrl, 'https://drive.google.com/uc?export=view&id=FINAL');
      assert.equal(profiles.get('B').imageUrl, '');
      assert.equal(profiles.get('C').imageUrl, '');
      assert.equal(profiles.has('PRIVATE'), false);
      const json = JSON.stringify([...profiles.values()]);
      assert.doesNotMatch(json, /Raw_(Artist|Party)Image_URL|RAW_ONLY|\/RAW\/|private\.jpg/);
    });
  }
}

test('archive API retains safe artist and party image URLs and omits the raw columns', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('This fixture must not make network requests'); });
  let serial = 0;
  for (const { kind, directory, image } of imageKinds) {
    for (const [imageUrl, expected] of [
      ['https://drive.google.com/uc?export=view&id=FINAL', 'https://drive.google.com/uc?export=view&id=FINAL'],
      ['javascript:alert(1)', ''], ['', '']
    ]) {
      const manifest = { schema: 1, revision: 'image-' + ++serial, [directory]: ['A'], partyPublicGate: true };
      const record = { revision: manifest.revision, entries: { A: { profile: {
        id: 'A', name: 'Alpha', publicOk: true, imageUrl, ['Raw_' + image]: 'private raw input'
      }, events: [] } } };
      const response = await onRequestGet({ request: new Request(`https://images.example/api/archive?resource=${kind}&id=A`),
        env: { QDP_ARCHIVE_KV: { get: async key => key.endsWith(':manifest') ? manifest : record } } });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.profile.imageUrl, expected);
      assert.equal(Object.hasOwn(data.profile, 'Raw_' + image), false);
    }
  }
});

test('artist and party pages use the same drawer for published images', () => {
  for (const id of ['A', 'CALLAIA-001']) {
    const profile = { id, name: 'Artist & Name', imageUrl: 'https://drive.google.com/uc?export=view&id=FINAL' };
    assert.equal(meta.profileImage('artist', profile).src, 'https://lh3.googleusercontent.com/d/FINAL=w1600');
    const html = renderProfileDrawer('artist', profile);
    assert.match(html, /src="https:\/\/lh3\.googleusercontent\.com\/d\/FINAL=w1600" alt="Artist &amp; Name"/);
    assert.match(html, /^<div class="archive-profile-drawer"><img/);
    assert.equal(renderProfileDrawer('party', profile), html);
    assert.equal(renderProfileDrawer('venue', profile), '');
    assert.doesNotMatch(renderProfileInfo('artist', profile, 'https://images.example'), /<img|archive-profile-heading/);
    assert.doesNotMatch(html, /callaia\.jpg|width="undefined"|height="undefined"/);
    assert.doesNotMatch(renderProfileInfo('venue', profile, 'https://images.example'), /<img/);
  }
  assert.equal(meta.profileImage('artist', { imageUrl: 'https://example.com/portrait.jpg' }).src, 'https://example.com/portrait.jpg');
});

test('an explicitly blank or unsafe image URL hides the photo, even for Callaia', () => {
  for (const imageUrl of ['', 'javascript:alert(1)', 'data:image/png;base64,abc']) {
    const profile = { id: 'CALLAIA-001', name: 'Callaia', imageUrl };
    for (const { kind } of imageKinds) {
      assert.equal(meta.profileImage(kind, profile), null);
      assert.equal(renderProfileDrawer(kind, profile), '');
    }
  }
});

const corePath = process.env.QDP_CORE_FILE;
for (const { kind, sheet: sheetName, image } of imageKinds) {
  test(`Core release: ${kind} image conversion preserves blank, invalid, unchanged, and unrelated cells`, { skip: !corePath }, () => {
    const core = fs.readFileSync(corePath, 'utf8');
    new vm.Script(core); // Syntax-check the complete installable file.
    assert.match(core, /\.addItem\('Update Artist Image URLs \(from Raw_ArtistImage_URL\)', 'updateArtistImageUrlsFromRawLinks'\)/);
    assert.match(core, /\.addItem\('Update Party Image URLs \(from Raw_PartyImage_URL\)', 'updatePartyImageUrlsFromRawLinks'\)/);
    assert.match(core, /qdpShowApifyMenu\(\);/);
    const fn = name => { const start = core.indexOf(`function ${name}(`); assert.ok(start >= 0);
      const end = core.indexOf('\nfunction ', start + 1); return core.slice(start, end < 0 ? undefined : end); };
    const direct = id => 'https://drive.google.com/uc?export=view&id=' + id;
    const rows = [
      [image, 'Unrelated', ' Raw_' + image + ' '],
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
    const context = vm.createContext({ CONFIG: { SHEET_ARTISTS: 'Artists', SHEET_PARTIES: 'Parties' },
      ss_: () => ({ getSheetByName: name => { assert.equal(name, sheetName); return sheet; } }),
      trim: value => String(value ?? '').trim(), ui_: () => null, Logger: { log: text => logs.push(text) } });
    const convert = kind === 'artist' ? 'updateArtistImageUrlsFromRawLinks' : 'updatePartyImageUrlsFromRawLinks';
    vm.runInContext(['getHeaderMap_', 'headerIndex_', 'directDriveImageUrl_', convert,
      'updateProfileImageUrlsFromRawLinks_'].map(fn).join('\n'), context);
    context[convert]();
    assert.deepEqual(writes, [[2, 1, 2, 1], [7, 1, 1, 1]]);
    assert.deepEqual(rows.slice(1).map(row => row[0]), [direct('ONE'), direct('TWO_ID'), 'manual photo', '=KEEP_FORMULA()', direct('SAME'), direct('LAST')]);
    assert.deepEqual(rows.slice(1).map(row => row[1]), ['keep 1', 'keep 2', 'keep 3', 'keep 4', 'keep 5', 'keep 6']);
    assert.ok(logs.join('\n').includes(`${sheetName} rows: 5`));
    writes.length = 0;
    context[convert]();
    assert.equal(writes.length, 0);
    rows[0][2] = 'Missing source';
    assert.throws(() => context[convert](), new RegExp('Raw_' + image + ' column'));
  });
}
