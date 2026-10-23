import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const start = app.indexOf('  const back = document.createElement("a");', app.indexOf('function openEventDetail('));
const end = app.indexOf('  detailCard.appendChild(back);', start);
assert.ok(start > 0 && end > start);
const source = app.slice(start, end) + '\nthis.back = back;';

function backLink(archive, header = '2026') {
  const context = vm.createContext({ window: { QDPArchive: archive },
    document: { createElement: () => ({ addEventListener() {} }),
      getElementById: () => ({ textContent: header }) },
    homepageUrl: () => '/', closeEventDetail() {}
  });
  vm.runInContext(source, context);
  return context.back.textContent;
}

for (const [kind, name] of [['artist', 'Callaia'], ['venue', "Val’s Lesbian Bar"],
  ['party', 'Melt'], ['collective', 'Queer Dance Philly']]) {
  test(`${kind} event Back label uses its profile name even while the tab displays a year`, () => {
    for (const header of ['2026', '2025', '2026\n2025']) {
      assert.equal(backLink({ active: true, profile: { kind, person: { name } } }, header), `← Back to ${name}`);
    }
  });
}

test('calendar and archive month event Back labels retain their existing destinations', () => {
  assert.equal(backLink(undefined), '← Back to Calendar');
  assert.equal(backLink({ active: false, profile: { person: { name: 'Callaia' } } }), '← Back to Calendar');
  assert.equal(backLink({ active: true, profile: null }, 'October 2026'), '← Back to October 2026');
  assert.equal(backLink({ active: true, profile: null }, ''), '← Back to Past Events');
});
