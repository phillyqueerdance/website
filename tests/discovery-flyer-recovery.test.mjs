import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {sqliteD1} from './helpers/d1-sqlite.mjs';
import {stage,listItems,saveItem,record,meta} from '../functions/discovery-store.js';
import {flyerRecoveryAction} from '../functions/discovery-flyer-recovery.js';
import {performanceAction,syncSnapshot} from '../functions/discovery-performance.js';
import {pipelinePayload} from '../tools/discovery/pipeline-payload.mjs';
const candidate=(title='Party',extra={})=>({fields:{'Title (internal)':title,StartDate:'2099-12-19',EndDate:'2099-12-20',StartTime:'22:00',EndTime:'02:00',Location:'Room',Lineup_Raw:'DJ',Instagram_URL:'https://www.instagram.com/reel/RECOVER/',...extra}});
const call=(db,action,body={})=>flyerRecoveryAction(db,action,{runId:'daily',...body});
async function first(db){return (await listItems(db)).items[0];}
test('existing screened posts with missing flyers enter recovery; past, excluded and already illustrated editions do not',async()=>{
 const db=sqliteD1();await stage(db,[candidate(),candidate('Already illustrated',{Flyer_URL:'https://drive.google.com/uc?id=saved'}),candidate('Past',{StartDate:'2000-01-01'}),candidate('Excluded',{Instagram_URL:'https://www.instagram.com/p/EXCLUDED/'})]);
 const excluded=(await listItems(db)).items.find(i=>i.title==='Excluded');await saveItem(db,{id:excluded.id,version:excluded.version,decision:'EXCLUDE'});
 await db.prepare('INSERT INTO discovery_posts(id,data,updated_at) VALUES(?,?,?)').bind('old-screened',JSON.stringify({source_url:'https://www.instagram.com/p/RECOVER/',flyer_outcome:'no_usable_flyer'}),'old').run();
 const jobs=await call(db,'flyer-retries.claim');assert.equal(jobs.jobs.length,1);assert.deepEqual(jobs.jobs[0].items.map(i=>i.title),['Party']);assert.match(jobs.jobs[0].sourceUrl,/reel\/RECOVER/);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM discovery_posts').first()).n,1);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM discovery_runs').first()).n,0);
});
test('claims resume once, lease against concurrent runs and schedule honest unsuccessful retries',async()=>{
 const db=sqliteD1();await stage(db,[candidate()]);const job=(await call(db,'flyer-retries.claim')).jobs[0];
 const resumed=(await call(db,'flyer-retries.claim')).jobs[0];assert.equal(resumed.lease,job.lease);assert.equal(resumed.version,job.version);
 assert.equal((await call(db,'flyer-retries.claim',{runId:'other'})).jobs.length,0);
 const result=await call(db,'flyer-retries.complete',{id:job.id,version:job.version,lease:job.lease,outcome:'unavailable',saved:[],error:'HTTP 403'});assert.equal(result.status,'waiting');
 assert.equal((await call(db,'flyer-retries.claim',{runId:'tomorrow'})).jobs.length,0);
 await db.prepare("UPDATE discovery_meta SET value=json_set(value,'$.nextAttemptAt','2000-01-01T00:00:00Z') WHERE key=?").bind('flyer-retry:'+job.id).run();
 const retry=(await call(db,'flyer-retries.claim',{runId:'tomorrow'})).jobs[0];assert.equal(retry.attempts,1);
 const stale=call(db,'flyer-retries.complete',{id:job.id,version:job.version,lease:job.lease,outcome:'saved',saved:[]});await assert.rejects(()=>stale,/claim changed/);
});
test('a preservation receipt cannot close recovery until artwork is actually staged; retries preserve decisions and edits',async()=>{
 const db=sqliteD1();await stage(db,[candidate()]);let item=await first(db);await saveItem(db,{id:item.id,version:item.version,decision:'INCLUDE',fields:{Description:'Owner copy'}});
 const job=(await call(db,'flyer-retries.claim')).jobs[0];
 const unconfirmed=await call(db,'flyer-retries.complete',{id:job.id,version:job.version,lease:job.lease,outcome:'saved',saved:[{targetId:item.id,proposalId:item.id,url:'https://drive.google.com/uc?id=not-yet-staged'}]});assert.equal(unconfirmed.status,'waiting');
 await db.prepare("UPDATE discovery_meta SET value=json_set(value,'$.nextAttemptAt','2000-01-01T00:00:00Z') WHERE key=?").bind('flyer-retry:'+job.id).run();
 const next=(await call(db,'flyer-retries.claim',{runId:'next'})).jobs[0];item=await first(db);
 await stage(db,[{...candidate(),discovery:item.discovery,fields:{...candidate().fields,Flyer_URL:'https://drive.google.com/uc?id=saved'}}]);
 const done=await call(db,'flyer-retries.complete',{runId:'next',id:next.id,version:next.version,lease:next.lease,outcome:'saved',saved:[{targetId:item.id,proposalId:item.id,url:'https://drive.google.com/uc?id=saved'}]});assert.equal(done.status,'saved');
 const saved=await first(db);assert.equal(saved.decision,'INCLUDE');assert.equal(saved.fields.Description,'Owner copy');assert.equal((await call(db,'flyer-retries.claim',{runId:'later'})).jobs.length,0);
});
test('recovered pending artwork reuses identity; imported editions receive a separate supported correction',async()=>{
 const db=sqliteD1();await stage(db,[candidate()]);const item=await first(db),job={id:'b'.repeat(64),items:[item],sourceUrl:item.sourceUrl};
 const review={flyers:[{recoveryId:job.id,targetIds:[item.id],visualId:'visual-original',verified:true}],flyerRecoveryJobs:[job]};
 const snapshot={events:[],items:[item],references:{}};
 const pending=(await pipelinePayload(review,snapshot)).items[0];assert.equal(pending.discovery.id,item.id);assert.equal(pending._review.kind,'recovery');assert.equal(pending.fields.Description,item.fields.Description);
 const imported={...item,status:'imported',result:{eventId:'EVENT-121999'}},baseline={eventId:'EVENT-121999',title:'Party',location:'Room',fields:{start:'2099-12-20T03:00:00Z',flyer:''}};
 const correction=(await pipelinePayload({...review,flyerRecoveryJobs:[{...job,items:[imported]}]},{events:[baseline],items:[imported],references:{}})).items[0];
 assert.equal(correction.kind,'correction');assert.equal(correction.eventId,baseline.eventId);assert.equal(correction.baseline,baseline);assert.deepEqual(correction.changes,{flyer:''});
 const changed={...item,fields:{...item.fields,Flyer_URL:'https://drive.google.com/uc?id=human'}};
 assert.equal((await pipelinePayload(review,{...snapshot,items:[changed]})).items.length,0);
 await assert.rejects(()=>pipelinePayload({...review,flyers:[{...review.flyers[0],targetIds:['c'.repeat(64)]}]},snapshot),/Unrelated/);
});
test('successful flyer corrections can resolve an imported source without changing its import receipt',async()=>{
 const db=sqliteD1();await stage(db,[candidate()]);let item=await first(db);const receipt={eventId:'EVENT-121999',calendarId:'owned',publishedAt:'saved'};
 await db.prepare("UPDATE discovery_items SET status='imported',result=? WHERE id=?").bind(JSON.stringify(receipt),item.id).run();
 const job=(await call(db,'flyer-retries.claim')).jobs[0];await stage(db,[{kind:'correction',date:item.date,fields:item.fields,eventId:receipt.eventId,changes:{flyer:'https://drive.google.com/uc?id=recovered'}}]);
 const correction=(await listItems(db)).items.find(i=>i.kind==='correction');
 assert.equal((await call(db,'flyer-retries.complete',{id:job.id,version:job.version,lease:job.lease,outcome:'saved',saved:[{targetId:item.id,proposalId:correction.id,url:correction.changes.flyer}]})).status,'saved');
 const original=record(await db.prepare('SELECT * FROM discovery_items WHERE id=?').bind(item.id).first());assert.deepEqual(original.result,receipt);assert.equal(original.status,'imported');
});
test('static-image byte fallback preserves exact inspected bytes with no video timestamp or arbitrary account operation',async()=>{
 const db=sqliteD1(),bytes=Buffer.concat([Buffer.from([255,216,255]),Buffer.from('actual original static flyer')]),id='a'.repeat(64),sha256=createHash('sha256').update(bytes).digest('hex');let writes=0;
 const part={id,sha256,index:0,total:1,base64:bytes.toString('base64'),source:{postUrl:'https://www.instagram.com/p/STATIC/',verified:true}};
 await performanceAction(db,'flyers.image.part',part,async()=>{throw new Error('No account operation during part upload');});
 const apps=async body=>{writes++;assert.equal(body.action,'admin.discovery.flyers');assert.equal(body.items[0].frame.source.kind,'image');assert.deepEqual(Buffer.from(body.items[0].frame.base64,'base64'),bytes);return{flyers:[{id,url:'https://drive.google.com/uc?id=image'}]};};
 const result=await performanceAction(db,'flyers.image.commit',{id,sha256},apps);assert.equal(result.fromVideo,false);
 assert.equal((await performanceAction(db,'flyers.image.commit',{id,sha256},apps)).alreadySaved,true);assert.equal(writes,1);
});
test('flyer recovery is bounded and does not resurrect excluded or expired queue targets',async()=>{
 const db=sqliteD1();for(let i=0;i<12;i++)await stage(db,[candidate('Party '+i,{Instagram_URL:'https://www.instagram.com/p/P'+i+'/'})]);
 const claims=await call(db,'flyer-retries.claim');assert.equal(claims.jobs.length,10);assert.equal(claims.deferred,2);
 const item=claims.jobs[0].items[0];await saveItem(db,{id:item.id,version:item.version,decision:'EXCLUDE'});
 const next=await call(db,'flyer-retries.claim',{runId:'second'});assert.equal(next.jobs.length,2);assert.ok(next.jobs.every(j=>j.items.every(i=>i.id!==item.id)));
});
test('flyer recovery reads paged snapshots and skips artwork already saved on the imported event',async()=>{
 const db=sqliteD1();await stage(db,[candidate()]);const item=await first(db);
 await db.prepare("UPDATE discovery_items SET status='imported',result=? WHERE id=?").bind(JSON.stringify({eventId:'EXISTING'}),item.id).run();
 await syncSnapshot(db,async()=>({inboxVersion:1,readAt:'2099-01-01',events:[{eventId:'EXISTING',title:'Party',fields:{start:'2099-12-19T22:00:00Z',flyer:'https://drive.google.com/uc?id=saved'}}],calendar:[],intake:[],references:{venues:[],venueAliases:[]}}));
 assert.equal((await meta(db,'snapshot-head')).value.indexVersion,2);
 assert.equal((await call(db,'flyer-retries.claim')).jobs.length,0);
});
