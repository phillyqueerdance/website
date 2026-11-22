import test from 'node:test';
import assert from 'node:assert/strict';
import {onRequestGet} from '../functions/api/discovery-decisions.js';
test('retired decision feed never reads account configuration or storage',async()=>{
  const response=onRequestGet({env:new Proxy({},{get(){throw new Error('No legacy storage calls');}})});
  assert.equal(response.status,410);assert.match(response.headers.get('Cache-Control'),/no-store/);
  assert.match((await response.json()).error,/Apps Script/);
});
