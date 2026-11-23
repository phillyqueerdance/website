import test from 'node:test';import assert from 'node:assert/strict';
import {sqliteD1} from './helpers/d1-sqlite.mjs';
import {stage,listItems,saveItem,reserveBudget,meta,setMeta,record} from '../functions/discovery-store.js';
import {discoveryRequest} from '../functions/discovery-api.js';
import {candidateItem,correctionItem} from '../tools/discovery/inbox-payload.mjs';
import {reviewBlob} from '../admin/discovery-export.js';
import fs from 'node:fs';import vm from 'node:vm';
const candidate=(extra={})=>({kind:'event',fields:{'Title (internal)':'Test party',StartDate:'2099-12-19',EndDate:'2099-12-20',StartTime:'21:00',EndTime:'02:00',Location:'Test venue',Lineup_Raw:'Named artist',Description:'Original copy',Event_URL:'https://www.instagram.com/p/TestPost/',...extra}});
async function item(db,extra){const result=await stage(db,[candidate(extra)]);return (await listItems(db)).items.find(i=>i.id===result.ids[0]);}
test('new evidence preserves user edits and decisions; unchanged carry-forward is not an update',async()=>{
  const db=sqliteD1(),first=await item(db);const saved=(await saveItem(db,{id:first.id,version:first.version,fields:{Description:'My copy'},decision:'WAIT'})).item;
  await stage(db,[{...candidate(),discovery:first.discovery,runId:'another-run'}]);let read=(await listItems(db)).items[0];assert.equal(read.isUpdated,false);assert.equal(read.fields.Description,'My copy');
  await stage(db,[{...candidate({Description:'Updated source copy'}),discovery:first.discovery}]);read=(await listItems(db)).items[0];assert.equal(read.isUpdated,true);assert.equal(read.fields.Description,'My copy');assert.equal(read.decision,'WAIT');
  await assert.rejects(()=>saveItem(db,{id:first.id,version:saved.version,fields:{Description:'Stale'}}),/changed/);
});
test('Exclude survives later staging; Wait restores the edition; different dates remain separate',async()=>{
  const db=sqliteD1(),first=await item(db);await saveItem(db,{id:first.id,version:first.version,decision:'EXCLUDE'});
  await stage(db,[candidate()]);assert.equal((await listItems(db)).total,0);const excluded=(await listItems(db,{view:'excluded'})).items[0];
  await saveItem(db,{id:excluded.id,version:excluded.version,decision:'WAIT'});assert.equal((await listItems(db)).total,1);
  await item(db,{StartDate:'2099-12-20',EndDate:'2099-12-21'});assert.equal((await listItems(db)).total,2);
});
test('two simultaneous saves cannot overwrite decisions or user edits',async()=>{
  const db=sqliteD1(),first=await item(db);const saved=await Promise.allSettled([
    saveItem(db,{id:first.id,version:first.version,fields:{Description:'First'},decision:'EXCLUDE'}),
    saveItem(db,{id:first.id,version:first.version,fields:{Description:'Second'},decision:'WAIT'})]);
  assert.equal(saved.filter(r=>r.status==='fulfilled').length,1);
  const row=record(await db.prepare('SELECT * FROM discovery_items WHERE id=?').bind(first.id).first());
  const decision=await db.prepare('SELECT decision FROM discovery_decisions WHERE alias=?').bind(first.id).first();assert.equal(decision.decision,row.decision);
});
test('budget reservations are atomic and unknown charges cannot be spent again',async()=>{
  const db=sqliteD1();const results=await Promise.allSettled([reserveBudget(db,{id:'one',amount:.59}),reserveBudget(db,{id:'two',amount:.59})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  await reserveBudget(db,{id:'one',amount:.59});await assert.rejects(()=>reserveBudget(db,{id:'three',amount:.01}),/insufficient/);
  await db.prepare('UPDATE discovery_runs SET actual_usd=? WHERE id=?').bind(.05,'one').run();await reserveBudget(db,{id:'three',amount:.54});
});
test('checkpoint updates require the current version',async()=>{const db=sqliteD1();await setMeta(db,'checkpoint',{activeRun:'one'},0);await assert.rejects(()=>setMeta(db,'checkpoint',{},0),/changed/);const current=await meta(db,'checkpoint');await setMeta(db,'checkpoint',{activeRun:'two'},current.version);assert.equal((await meta(db,'checkpoint')).value.activeRun,'two');});
test('task credential cannot import, publish, save user decisions, or invoke arbitrary Google actions',async()=>{
  const db=sqliteD1();for(const action of ['import','publish','save','listings','admin.push']){const result=await discoveryRequest({env:{QDP_DISCOVERY:db,QDP_DISCOVERY_TASK_TOKEN:'test-only'},request:new Request('https://queerdancephilly.com/api/discovery',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer test-only'},body:JSON.stringify({action})})},true);assert.equal(result.status,403);}
  const invalid=await discoveryRequest({env:{QDP_DISCOVERY:db,QDP_DISCOVERY_TASK_TOKEN:'test-only'},request:new Request('https://queerdancephilly.com/api/discovery',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer invalid'},body:'{"action":"bootstrap"}'})},true);assert.equal(invalid.status,403);
});
test('task staging and lightweight state reads work without a Cloudflare account token',async()=>{
  const db=sqliteD1(),call=async(action,body={})=>discoveryRequest({env:{QDP_DISCOVERY:db,QDP_DISCOVERY_TASK_TOKEN:'scoped-token'},request:new Request('https://queerdancephilly.com/api/discovery',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer scoped-token'},body:JSON.stringify({action,...body})})},true);
  assert.equal((await (await call('stage',{items:[candidate()]})).json()).staged,1);
  assert.equal((await (await call('items')).json()).items.length,1);
  const posts=await call('posts.save',{posts:[{id:'post',source_url:'https://www.instagram.com/p/post/',caption:'Private long caption'}]});assert.equal(posts.status,200);
  const read=await (await call('posts.read')).json();assert.equal(read.posts[0].caption,undefined);
});
test('legacy candidates and corrections retain stable edition and proposal identity',async()=>{
  assert.equal(await candidateItem({title:'Excluded venue party',date:'2099-01-01',location:'The Ave Live'}),null);
  const row=await candidateItem({title:'Test',date:'2099-01-01',start:'21:00',end:'02:00',nextDay:true,location:'Venue',lineup:'One'});assert.equal(row.fields.EndDate,'2099-01-02');
  const correction=await correctionItem({date:'2099-01-01',title:'Test',venue:'Venue',correction:'New poster.\nProposed lineup: Named artist',public_url:'https://queerdancephilly.com/?event=TEST-010199'});assert.equal(correction.eventId,'TEST-010199');assert.equal(correction.changes.lineup,'Named artist');
});
test('Excel export is a real ZIP with typed dates, four tabs, and literal formula-like text',async()=>{
  const blob=reviewBlob([{...candidate({'Title (internal)':'=HYPERLINK("unsafe")'}),id:'a'.repeat(64),decision:'WAIT',discovery:{id:'a'.repeat(64)},kind:'event'}],'Coverage');const text=new TextDecoder().decode(await blob.arrayBuffer());assert.ok(text.includes('New events'));assert.ok(text.includes('Corrections'));assert.ok(text.includes('Coverage'));assert.ok(text.includes('Readme'));assert.ok(text.includes('t="inlineStr"'));assert.ok(!text.includes('<f>'));assert.equal(new Uint8Array(await blob.arrayBuffer())[0],0x50);
});
test('Apps Script additions parse in the installed V8 syntax and are only reachable after Core authentication',()=>{
  const source=fs.readFileSync(new URL('../apps-script/DiscoveryInbox.gs',import.meta.url),'utf8');new vm.Script(source);
  const corePath=process.env.QDP_CORE_SOURCE;if(corePath){const core=fs.readFileSync(corePath,'utf8');new vm.Script(core);assert.ok(core.indexOf("Admin authorization failed.")<core.indexOf("'admin.discovery.snapshot'"));}
});
