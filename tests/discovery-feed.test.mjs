import test from 'node:test';
import assert from 'node:assert/strict';
import {onRequestGet} from '../functions/api/discovery-decisions.js';
import {DECISION_PREFIX} from '../shared/discovery-identity.js';

const token='a'.repeat(64);
function context(authorization, kv) {
  return {request:new Request('https://queerdancephilly.com/api/discovery-decisions',{
    headers:authorization?{Authorization:authorization}:{}}),env:{QDP_DISCOVERY_READ_TOKEN:token,QDP_PUBLIC_FEED_KV:kv}};
}
test('discovery feedback requires its own read-only credential before any KV read',async()=>{
  let reads=0;const kv={list:async()=>{reads++;return {keys:[],list_complete:true};}};
  for(const authorization of [undefined,'Bearer '+'b'.repeat(64),'Bearer '+token+'extra']){
    const response=await onRequestGet(context(authorization,kv));assert.equal(response.status,403);
    assert.equal(JSON.stringify(await response.json()).includes(token),false);
  }
  assert.equal(reads,0);
});
test('feedback returns only decision metadata and a continuation cursor',async()=>{
  const id='c'.repeat(64);let options;
  const kv={list:async opts=>{options=opts;return {list_complete:false,cursor:'next',keys:[{
    name:DECISION_PREFIX+id,metadata:{id,kind:'event',date:'2026-12-19',decision:'EXCLUDE',updatedAt:'2026-11-20T20:00:00Z',title:'PRIVATE TITLE',token:'PRIVATE'}}]};}};
  const response=await onRequestGet(context('Bearer '+token,kv));const body=await response.json();
  assert.equal(response.status,200);assert.equal(options.prefix,DECISION_PREFIX);assert.equal(body.cursor,'next');
  assert.equal(body.records[0].decision,'EXCLUDE');assert.equal(JSON.stringify(body).includes('PRIVATE'),false);
  assert.match(response.headers.get('Cache-Control'),/no-store/);
});
test('unavailable feedback is an error rather than an empty exclusion list',async()=>{
  const response=await onRequestGet(context('Bearer '+token,{list:async()=>{throw new Error('KV down');}}));
  assert.equal(response.status,503);assert.equal((await response.json()).records,undefined);
});
