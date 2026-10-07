import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

test('the public CSP allows every executable inline script in the HTML', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const headers = fs.readFileSync(new URL('../_headers', import.meta.url), 'utf8');
  const sources = headers.match(/\bscript-src\s+([^;\n]+)/)?.[1].split(/\s+/);
  assert.ok(sources, 'The public script policy must exist');
  let checked = 0;
  for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(attributes)) continue;
    const type = attributes.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1];
    if (type && !/^(?:module|(?:text|application)\/(?:javascript|ecmascript))$/i.test(type)) continue;
    const hash = createHash('sha256').update(body).digest('base64');
    assert.ok(sources.includes(`'sha256-${hash}'`), `Inline script would be blocked: allow 'sha256-${hash}'`);
    checked++;
  }
  assert.ok(checked > 0, 'The inline-script check must inspect a script');
});
