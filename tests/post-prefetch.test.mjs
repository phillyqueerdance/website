import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../admin/post-generator.js', import.meta.url), 'utf8');

async function generate(events, { assetFailure = false } = {}) {
  const elements = new Map(), slides = [], calls = [], aborted = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', listeners: {},
      addEventListener(name, handler) { this.listeners[name] = handler; }, replaceChildren() {} });
    return elements.get(id);
  };
  let active = 0, maximum = 0;
  const loadFlyer = (event, signal) => {
    calls.push(event.flyerUrl);
    if (!event.flyerUrl) return Promise.resolve(null);
    active++; maximum = Math.max(maximum, active);
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = () => { finished = true; active--; signal.removeEventListener('abort', abort); };
      const timer = setTimeout(() => {
        finish();
        if (event.flyerUrl === 'broken') reject(new Error('Unavailable flyer'));
        else resolve({ url: event.flyerUrl });
      }, event.flyerUrl === 'slow' ? 35 : 5);
      const abort = () => {
        if (finished) return;
        clearTimeout(timer); finish(); aborted.push(event.flyerUrl);
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      };
      signal.addEventListener('abort', abort, { once: true });
    });
  };
  const instrumented = source.replace(/\}\)\(\);\s*$/, `
    image = async () => { if (assetFailure) throw new Error('Asset unavailable'); return {}; };
    loadTitleFont = async () => {};
    flyerImage = loadFlyer;
    titleSlide = () => ({ type: 'title' });
    calendarSlide = (_, days) => ({ type: 'calendar', days });
    popupSlide = (_, event, flyer) => ({ type: 'event', id: event.eventId, flyer });
    addImage = async slide => { slides.push(slide); };
  })();`);
  vm.runInNewContext(instrumented, {
    Intl, Date, AbortController, slides, assetFailure, loadFlyer, navigator: {},
    console: { warn() {} },
    document: { documentElement: {}, getElementById: element },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    window: { addEventListener() {} },
    fetch: async () => ({ ok: true, json: async () => ({ events }) })
  });
  element('postStart').value = element('postEnd').value = '2030-10-14';
  await element('postForm').listeners.submit({ preventDefault() {} });
  return { slides, calls, maximum, active, aborted, status: element('postStatus').textContent,
    disabled: element('generatePost').disabled };
}

const events = ['slow', 'fast', 'third', 'fourth', 'broken', 'sixth', 'slow', 'broken'].map((flyerUrl, i) => ({
  eventId: `E${i}`, title: `Event ${i}`, flyerUrl, start: `2030-10-14T${12 + i}:00:00-04:00`
}));

test('flyers overlap with bounded concurrency while exports keep event order and reuse URLs', async () => {
  const result = await generate(events);
  assert.equal(result.maximum, 3);
  assert.deepEqual(result.slides.filter(s => s.type === 'event').map(s => s.id), events.map(e => e.eventId));
  assert.equal(result.calls.filter(url => url === 'slow').length, 1);
  assert.equal(result.calls.filter(url => url === 'broken').length, 1);
  assert.ok(result.slides.filter(s => s.type === 'event' && ['E4', 'E7'].includes(s.id)).every(s => s.flyer === null));
  assert.match(result.status, /11 PNG images ready\. 2 flyers could not be loaded/);
  assert.equal(result.active, 0);
  assert.equal(result.disabled, false);
});

test('an asset failure aborts pending flyer requests and releases the Generate button', async () => {
  const result = await generate(events, { assetFailure: true });
  assert.equal(result.active, 0);
  assert.equal(result.aborted.length, 3);
  assert.match(result.status, /Generation stopped: Asset unavailable/);
  assert.equal(result.disabled, false);
});
