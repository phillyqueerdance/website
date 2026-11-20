import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { discoveryIdentity, DECISION_PREFIX } from '../shared/discovery-identity.js';
import { readDiscoveryDecision, saveDiscoveryDecision, recordDiscoveryImports } from '../functions/discovery-decisions.js';
import { collectionPlan, prepareReview, decisionRecords } from '../tools/discovery/daily-review.mjs';

const fields = (extra = {}) => ({'Title (internal)': 'Melt', StartDate: '2026-12-19', EndDate: '2026-12-20',
  StartTime: '21:00:00', EndTime: '01:30:00', Location: "Val’s", Lineup_Raw: 'Artist One; Artist Two',
  RawFlyerURL: 'https://images.example/one.jpg', Event_URL: 'https://www.instagram.com/p/First/', ...extra});
const state = () => ({usernames: ['one'], actor: 'sones/instagram-posts-scraper-lowcost',
  last_completed_collection_at: '2026-11-20T13:00:00Z', intake_headers: [
    'Title (internal)', 'StartDate', 'EndDate', 'StartTime', 'EndTime', 'Location', 'Lineup_Raw', 'Review',
    'ImportSourceKey', 'ImportSourceSnapshot', ...Array.from({length: 33}, (_, i) => 'blank' + i)
  ], previously_delivered_candidates: [], pending_candidates: []});
function store() {
  const records = new Map();
  return {records, env: {QDP_PUBLIC_FEED_KV: {
    async get(key) { return records.has(key) ? JSON.parse(records.get(key).value) : null; },
    async put(key, value, options) { records.set(key, {value, metadata: options.metadata}); }
  }}};
}
test('Wait and Exclude survive another workbook and cross-post aliases', async () => {
  const h = store(), id = await discoveryIdentity(fields());
  await saveDiscoveryDecision(h.env, id, 'WAIT');
  assert.equal((await readDiscoveryDecision(h.env, await discoveryIdentity(fields()))).decision, 'WAIT');
  await saveDiscoveryDecision(h.env, id, 'EXCLUDE');
  assert.equal((await readDiscoveryDecision(h.env, await discoveryIdentity(fields({Event_URL:'https://www.instagram.com/p/CrossPost/'})))).decision, 'EXCLUDE');
  assert.equal(await readDiscoveryDecision(h.env, await discoveryIdentity(fields({StartDate:'2027-02-20',Event_URL:'https://www.instagram.com/p/Other/'}))), null);
});
test('a changed title on the same source is still the same decision; multi-date posts stay distinct', async () => {
  const h=store(), id=await discoveryIdentity(fields()); await saveDiscoveryDecision(h.env,id,'EXCLUDE');
  assert.equal((await readDiscoveryDecision(h.env,await discoveryIdentity(fields({'Title (internal)':'Melt with a newly announced lineup'})))).decision,'EXCLUDE');
  assert.equal(await readDiscoveryDecision(h.env,await discoveryIdentity(fields({StartDate:'2026-12-20'}))),null);
});
test('Include requires confirmation; a failed or partial import leaves no receipt', async () => {
  const h=store(), id=await discoveryIdentity(fields()), rows=[{discovery:id}];
  await assert.rejects(saveDiscoveryDecision(h.env,id,'INCLUDE'),/confirmed import/);
  await assert.rejects(recordDiscoveryImports(h.env,rows,{ok:'yes',added:0,alreadySaved:0}),/not fully confirmed/);
  assert.equal(h.records.size,0);
  await recordDiscoveryImports(h.env,rows,{ok:'yes',added:1,alreadySaved:0});
  assert.equal((await readDiscoveryDecision(h.env,id)).decision,'INCLUDE');
});
test('a later newly posted correction survives an earlier Include receipt', async () => {
  const h=store(), eventId=await discoveryIdentity(fields());
  await saveDiscoveryDecision(h.env,eventId,'INCLUDE',true);
  const first=await discoveryIdentity(fields(),'correction','first lineup');
  assert.equal(await readDiscoveryDecision(h.env,first),null);
  await saveDiscoveryDecision(h.env,first,'INCLUDE',true);
  assert.equal((await readDiscoveryDecision(h.env,first)).decision,'INCLUDE');
  const next=await discoveryIdentity(fields({Event_URL:'https://www.instagram.com/p/NewPoster/'}),'correction','new lineup');
  assert.equal(await readDiscoveryDecision(h.env,next),null);
});
test('day two carries pending events forward; Exclude suppresses them without reading QDP', async () => {
  const s=state(), h=store(), first=await prepareReview(s,{candidates:[{fields:fields()}]},[], '2026-11-20');
  const second=await prepareReview(first.nextState,{candidates:[{fields:fields({'Title (internal)':'Another night', Event_URL:'https://www.instagram.com/p/Another/'})}]},[], '2026-11-21');
  assert.equal(second.rows.length,2); assert.equal(second.headers.length,43);
  const id=await discoveryIdentity(fields()); await saveDiscoveryDecision(h.env,id,'EXCLUDE');
  const decisions=decisionRecords([...h.records].map(([name,item])=>({name,metadata:item.metadata})));
  const third=await prepareReview(second.nextState,{},decisions,'2026-11-22');
  assert.equal(third.rows.length,1); assert.equal(third.coverage.excluded,1);
  assert.equal(third.rows[0][0],'Another night');
});
test('normal public-calendar comparison still omits manually added events', async () => {
  const s=state(), id=await discoveryIdentity(fields());
  s.pending_candidates=[{fields:fields()}];
  const result=await prepareReview(s,{listedIds:[id.id],publicComparison:'Complete'},[], '2026-11-20');
  assert.equal(result.rows.length,0); assert.equal(result.coverage.includedOrAlreadyListed,1);
});
test('a missing-lineup lead can become an event on a NEW post; past leads expire', async () => {
  const s=state(); s.pending_candidates=[{fields:fields({Lineup_Raw:''})}];
  const first=await prepareReview(s,{},[],'2026-11-20'); assert.equal(first.rows.length,0);
  assert.equal(first.coverage.waitingForLineup,1);
  const next=await prepareReview(first.nextState,{candidates:[{fields:fields({Event_URL:'https://www.instagram.com/p/NewPoster/'})}]},[],'2026-11-21');
  assert.equal(next.rows.length,1);
  const ended=await prepareReview(next.nextState,{},[],'2027-01-01'); assert.equal(ended.rows.length,0);
});
test('collection plan has three posts, six-hour overlap and a shared daily budget under 60 cents', () => {
  const plan=collectionPlan(state(),new Date('2026-11-21T13:00:00Z'),0.20);
  assert.equal(plan.postsPerProfile,3); assert.equal(plan.newerThan,'2026-11-20T07:00:00.000Z');
  assert.equal(plan.maxTotalChargeUsd,0.39); assert.throws(()=>collectionPlan(state(),new Date(),0.59),/exhausted/);
});

const client=fs.readFileSync(new URL('../admin/apify-import.js',import.meta.url),'utf8')
  .replace(/^import .*;\r?\n/gm,'').split('\nelements.workbook.addEventListener')[0];
function ui() {
  const requests=[], elements=new Map();
  const c=vm.createContext({Intl,Date,URL,console,document:{getElementById(id){if(!elements.has(id)) elements.set(id,{});return elements.get(id);}},
    fetch:async(url,options)=>{const body=JSON.parse(options.body);requests.push({url,body});return Response.json(url.includes('discovery-decisions')?{ok:'yes',records:body.items.map(()=>({}))}:{ok:'yes',added:1,alreadySaved:0});}});
  vm.runInContext(client,c); c.updateControls=()=>{}; c.setStatus=()=>{};
  const state=vm.runInContext('state',c); return {c,state,requests};
}
test('saving Exclude alone persists the choice without importing any row', async () => {
  const h=ui();const candidate={decision:'EXCLUDE',decisionDirty:true,saved:false,fields:fields(),discovery:await discoveryIdentity(fields())};
  h.state.review={candidates:[candidate]};await h.c.saveSelected();
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].url,'/admin/discovery-decisions');
  assert.equal(h.requests[0].body.items[0].decision,'EXCLUDE');assert.equal(candidate.saved,false);assert.equal(candidate.decisionDirty,false);
});
test('Include uses the existing intake action and sends its persistent identity', async () => {
  const h=ui();const candidate={decision:'INCLUDE',decisionDirty:true,saved:false,key:'workbook:2',fields:fields(),discovery:await discoveryIdentity(fields())};
  h.state.review={candidates:[candidate]};await h.c.saveSelected();
  assert.equal(h.requests[0].body.action,'admin.apifyimport');assert.equal(h.requests[0].body.rows[0].discovery.id,candidate.discovery.id);
  assert.equal(candidate.saved,true);
});
test('Include batches stay within free-tier KV request limits and preserve completed batches on failure',async()=>{
  const h=ui();const identity=await discoveryIdentity(fields());
  const candidates=Array.from({length:7},(_,i)=>({decision:'INCLUDE',decisionDirty:true,saved:false,key:'book:'+(i+2),fields:fields(),discovery:identity}));
  h.state.review={candidates};
  h.c.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);h.requests.push({url,body});
    if(h.requests.length===2)return Response.json({error:'Temporary failure'},{status:503});
    return Response.json({ok:'yes',added:body.rows.length,alreadySaved:0});
  };
  await h.c.saveSelected();
  assert.deepEqual(h.requests.map(r=>r.body.rows.length),[5,2]);
  assert.equal(candidates.slice(0,5).every(item=>item.saved),true);
  assert.equal(candidates.slice(5).every(item=>!item.saved&&item.decisionDirty),true);
});
