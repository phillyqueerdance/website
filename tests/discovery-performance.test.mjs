import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {sqliteD1} from './helpers/d1-sqlite.mjs';
import {performanceAction,syncSnapshot,matchFacts} from '../functions/discovery-performance.js';
import {readSnapshot} from '../functions/discovery-snapshot.js';
import {stage,saveItem,listItems,meta,setMeta} from '../functions/discovery-store.js';
import {discoveryRequest} from '../functions/discovery-api.js';
import {pipelinePayload} from '../tools/discovery/pipeline-payload.mjs';
const event=(id,date,title='Party')=>({eventId:id,title,location:'Test room',venueId:'ROOM',sourceUrl:'https://www.instagram.com/p/'+id+'/',fields:{start:date+'T22:00:00-05:00',lineup:'DJ Test',description:'Verified copy'},revision:'revision-'+id});
const refs={venues:[{id:'ROOM',name:'Test room'}],venueAliases:[{id:'ROOM',key:'Alias room',exactOnly:true}],artistAliases:[{id:'DJ',key:'DJ Test'}]};
const snapshot=(events)=>({inboxVersion:1,readAt:'2099-01-01T00:00:00Z',events,calendar:[],intake:[],references:refs});
const noop=async()=>{throw new Error('No account operation permitted');};
const op=(db,action,body={})=>performanceAction(db,action,body,noop);

test('batch lookup reads only collected IDs; delta cursor uses timestamp and ID without dropping ties',async()=>{
 const db=sqliteD1();for(const id of ['a','b','c'])await db.prepare('INSERT INTO discovery_posts(id,data,updated_at) VALUES(?,?,?)').bind(id,'{}','2099-01-01').run();
 assert.deepEqual((await op(db,'posts.lookup',{ids:['b','new']})).screenedIds,['b']);
 const one=await op(db,'posts.delta',{limit:2});assert.deepEqual(one.posts.map(p=>p.id),['a','b']);assert.equal(one.hasMore,true);
 const two=await op(db,'posts.delta',{cursor:one.cursor,limit:2});assert.deepEqual(two.posts.map(p=>p.id),['c']);assert.equal(two.hasMore,false);
});
test('snapshot retrieval sends delta hashes, transfers only relevant event dates and retains full correction baselines',async()=>{
 const db=sqliteD1(),events=[event('ONE','2099-12-19'),event('TWO','2099-12-20')];let calls=0;
 const apps=async body=>{calls++;if(calls===1)return snapshot(events);
  assert.ok(body.known.events.ONE);return {...snapshot([]),references:undefined,deltaVersion:1,hashes:{events:body.known.events,calendar:{},intake:{},references:body.known.references}};};
 assert.equal((await syncSnapshot(db,apps)).changedRecords,3);
 assert.equal((await syncSnapshot(db,apps)).changedRecords,0);
 const result=await matchFacts(db,{facts:[{date:'2099-12-19'}]});assert.deepEqual(result.events.map(e=>e.eventId),['ONE']);
 assert.equal(result.events[0].fields.description,'Verified copy');assert.equal(result.references.venueAliases[0].key,'Alias room');
 const source=await matchFacts(db,{facts:[{date:'2099-11-01',sources:['https://instagram.com/reel/TWO/?x=1']}]});assert.equal(source.events[0].eventId,'TWO');
});
test('snapshot deletions remove current matching entries while historical cache remains intact',async()=>{
 const db=sqliteD1();await syncSnapshot(db,async()=>snapshot([event('ONE','2099-12-19')]));
 const head=(await readSnapshot(db)).value;
 await syncSnapshot(db,async()=>({...snapshot([]),deltaVersion:1,references:undefined,hashes:{events:{},calendar:{},intake:{},references:head.referencesHash}}));
 assert.equal((await matchFacts(db,{facts:[{date:'2099-12-19'}]})).events.length,0);
 assert.ok(await meta(db,head.index[0].key));
});
test('an interrupted snapshot never exposes a partial head or loses an old baseline',async()=>{
 const db=sqliteD1();await syncSnapshot(db,async()=>snapshot([event('ONE','2099-12-19')]));
 let changed=false;await assert.rejects(()=>syncSnapshot(db,async()=>{await setMeta(db,'snapshot-head',{...(await meta(db,'snapshot-head')).value,readAt:'newer'},1);changed=true;return snapshot([event('TWO','2099-12-20')]);}),/checkpoint changed/);
 assert.equal(changed,true);const result=await matchFacts(db,{facts:[{date:'2099-12-19'}]});assert.equal(result.events[0].eventId,'ONE');
});
test('large snapshots use bounded index pages without losing records, sources or correction baselines',async()=>{
 const db=sqliteD1(),events=Array.from({length:900},(_,i)=>({...event('EVENT-'+i,i===0?'2099-12-19':'2099-12-20','Party '+i+' 🏳️‍⚧️ '+ 'x'.repeat(80)),location:'Venue '+i+' '+ 'v'.repeat(80)}));
 const result=await syncSnapshot(db,async()=>snapshot(events)),saved=await meta(db,'snapshot-head'),hydrated=await readSnapshot(db);
 assert.ok(JSON.stringify(hydrated.value.index).length>150000);assert.ok(JSON.stringify(saved.value).length<2000);assert.equal(saved.value.index,undefined);assert.equal(saved.value.indexCount,900);assert.ok(result.indexPages>1);
 for(const key of saved.value.indexParts){const page=await meta(db,key);assert.ok(JSON.stringify(page.value).length<=100000);}
 assert.equal(hydrated.value.index.length,900);const match=await matchFacts(db,{facts:[{date:'2099-12-19'}]});assert.deepEqual(match.events,[events[0]]);assert.deepEqual(match.references,refs);
 const all=await matchFacts(db,{facts:[{eventId:'EVENT-899'}]});assert.equal(all.events[0].eventId,'EVENT-899');
 const unchanged=await syncSnapshot(db,async body=>({...snapshot([]),references:undefined,deltaVersion:1,hashes:{...body.known}}));
 assert.equal(unchanged.changedRecords,0);assert.deepEqual((await meta(db,'snapshot-head')).value.indexParts,saved.value.indexParts);
 for(const key of saved.value.indexParts)assert.equal((await meta(db,key)).version,1);
});
test('old inline snapshot heads migrate without a full transfer or losing aliases',async()=>{
 const db=sqliteD1();await syncSnapshot(db,async()=>snapshot([event('ONE','2099-12-19')]));
 const saved=await readSnapshot(db),legacy={...saved.value};delete legacy.indexVersion;delete legacy.indexParts;delete legacy.indexCount;
 await setMeta(db,'snapshot-head',legacy,saved.version);let seen;
 await syncSnapshot(db,async body=>{seen=body.known;return {...snapshot([]),references:undefined,deltaVersion:1,hashes:body.known};});
 assert.ok(seen.events.ONE);assert.equal((await meta(db,'snapshot-head')).value.indexVersion,2);assert.equal((await matchFacts(db,{facts:[{eventId:'ONE'}]})).events[0].eventId,'ONE');
});
test('a missing or corrupt index page blocks matching instead of claiming absence',async()=>{
 const db=sqliteD1();await syncSnapshot(db,async()=>snapshot([event('ONE','2099-12-19')]));const head=(await meta(db,'snapshot-head')).value,key=head.indexParts[0],page=(await meta(db,key)).value;
 await db.prepare('DELETE FROM discovery_meta WHERE key=?').bind(key).run();await assert.rejects(()=>matchFacts(db,{facts:[{eventId:'ONE'}]}),/index is incomplete/);
 await setMeta(db,key,[{...page[0],id:'CHANGED'}],0);await assert.rejects(()=>matchFacts(db,{facts:[{eventId:'ONE'}]}),/index is incomplete/);
});
test('cross-posts reuse pending identity through venue aliases and preserve owner edits, choices and receipts',async()=>{
 const db=sqliteD1(),fields={'Title (internal)':'Party',StartDate:'2099-12-19',Location:'Test room',Event_URL:'https://www.instagram.com/p/OLD/',Lineup_Raw:'DJ Test'};
 await stage(db,[{fields}]);let pending=(await listItems(db)).items[0];await saveItem(db,{id:pending.id,version:pending.version,decision:'EXCLUDE',fields:{Description:'Owner copy'}});
 await syncSnapshot(db,async()=>snapshot([]));const matching=await matchFacts(db,{facts:[{date:'2099-12-19',sources:['https://www.instagram.com/p/NEW/']}]});
 const payload=await pipelinePayload({candidates:[{fields:{...fields,Location:'Alias room',Event_URL:'https://www.instagram.com/p/NEW/',Description:'New source copy'}}]},matching);
 assert.equal(payload.items[0].discovery.id,pending.id);await stage(db,payload.items);
 pending=(await listItems(db,{view:'excluded'})).items[0];assert.equal(pending.decision,'EXCLUDE');assert.equal(pending.fields.Description,'Owner copy');
});
test('corrections keep fresh EventID baselines and existing correction identity format',async()=>{
 const baseline=event('ONE','2099-12-19');const result=await pipelinePayload({corrections:[{eventId:'ONE',date:'2099-12-19',title:'Party',venue:'Test room',changes:{lineup:'DJ New'},source_url:'https://www.instagram.com/p/NEW/'}]},snapshot([baseline]));
 assert.equal(result.items[0].kind,'correction');assert.equal(result.items[0].baseline.eventId,'ONE');assert.equal(result.items[0].changes.lineup,'DJ New');
 await assert.rejects(()=>pipelinePayload({corrections:[{eventId:'MISSING',date:'2099-12-19'}]},snapshot([])),/baseline/);
});
test('checkpoint patches retain profile gaps and reject stale writers; journal writes cannot alter config',async()=>{
 const db=sqliteD1();await setMeta(db,'checkpoint',{profileResults:{keep:true},deferredGaps:['old'],activeRun:null},0);
 await op(db,'checkpoint.patch',{version:1,value:{activeRun:'run'}});
 assert.deepEqual((await meta(db,'checkpoint')).value.deferredGaps,['old']);
 await assert.rejects(()=>op(db,'checkpoint.patch',{version:1,value:{activeRun:null}}),/changed/);
 await assert.rejects(()=>op(db,'work.save',{runId:'run',key:'config',version:0,value:{}}),/section/);
 await op(db,'work.save',{runId:'run',key:'inputs:1',version:0,value:'source bytes'});
 await op(db,'work.save',{runId:'run',key:'state:0',version:0,value:{state:{},manifest:{inputs:{parts:['inputs:1']}}}});
 assert.equal((await op(db,'work.read',{runId:'run'})).records.find(r=>r.key==='inputs:1').value,'source bytes');
});
test('verified frame uploads are chunked, hashed, MIME checked, resumable and receipt-idempotent',async()=>{
 const db=sqliteD1(),bytes=Buffer.concat([Buffer.from([255,216,255]),Buffer.from('fixture frame bytes')]),sha=createHash('sha256').update(bytes).digest('hex'),id='a'.repeat(64),source={postUrl:'https://www.instagram.com/reel/FRAME/',seconds:1.25,verified:true};
 const parts=[bytes.subarray(0,9),bytes.subarray(9)];let calls=0;
 const apps=async body=>{calls++;assert.equal(body.action,'admin.discovery.flyers');assert.equal(body.items[0].frame.sha256,sha);assert.deepEqual(Buffer.from(body.items[0].frame.base64,'base64'),bytes);return{flyers:[{id,url:'https://drive.google.com/uc?id=verified'}]};};
 await op(db,'flyers.frame.part',{id,sha256:sha,index:1,total:2,source,base64:parts[1].toString('base64')});
 await assert.rejects(()=>performanceAction(db,'flyers.frame.commit',{id,sha256:sha},apps),/incomplete/);
 const part={id,sha256:sha,index:0,total:2,source,base64:parts[0].toString('base64')};await op(db,'flyers.frame.part',part);await op(db,'flyers.frame.part',part);
 assert.ok((await performanceAction(db,'flyers.frame.commit',{id,sha256:sha},apps)).url);
 assert.equal((await performanceAction(db,'flyers.frame.commit',{id,sha256:sha},apps)).alreadySaved,true);assert.equal(calls,1);
});
test('bad frame evidence, content, permissions or hashes cannot call storage',async()=>{
 const db=sqliteD1(),id='a'.repeat(64),source={postUrl:'https://www.instagram.com/p/FRAME/',seconds:1,verified:true};
 await assert.rejects(()=>op(db,'flyers.frame.part',{id,sha256:'b'.repeat(64),index:0,total:1,source:{...source,verified:false},base64:'AAAA'}),/verified/);
 await op(db,'flyers.frame.part',{id,sha256:'b'.repeat(64),index:0,total:1,source,base64:Buffer.from('not an image at all').toString('base64')});
 await assert.rejects(()=>performanceAction(db,'flyers.frame.commit',{id,sha256:'b'.repeat(64)},noop),/checksum/);
 const response=await discoveryRequest({env:{QDP_DISCOVERY:db,QDP_DISCOVERY_TASK_TOKEN:'secret'},request:new Request('https://queerdancephilly.com/api/discovery',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'flyers.frame.commit',id})})},true);assert.equal(response.status,403);
});
test('Apps Script frame storage uses only the existing flyer folder and original bytes, including retry after a lost receipt',()=>{
 const files=new Map();let created=0;const bytes=Buffer.concat([Buffer.from([255,216,255]),Buffer.from('legible actual original fixture')]);
 const hash=data=>[...createHash('sha256').update(typeof data==='string'?data:Buffer.from(data)).digest()];
 const folder={getFilesByName:name=>{const values=files.has(name)?[files.get(name)]:[];return{hasNext:()=>values.length>0,next:()=>values.shift()};},createFile:blob=>{created++;const file={getBlob:()=>({getBytes:()=>blob.bytes}),getId:()=>String(created),getResourceKey:()=>''};files.set(blob.name,file);return file;}};
 const context=vm.createContext({Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(alg,data)=>hash(data),base64Decode:value=>[...Buffer.from(value,'base64')],newBlob:(bytes,mime,name)=>({bytes,mime,name})},qdpScanFolder_:()=>folder});
 vm.runInContext(fs.readFileSync(new URL('../apps-script/DiscoveryInbox.gs',import.meta.url),'utf8'),context);
 const frame={base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),source:{postUrl:'https://www.instagram.com/reel/FRAME/',verified:true,seconds:2}};
 const one=context.qdpInboxFrameFlyer_('a'.repeat(64),frame),two=context.qdpInboxFrameFlyer_('a'.repeat(64),frame);assert.equal(one.url,two.url);assert.equal(created,1);
 assert.throws(()=>context.qdpInboxFrameFlyer_('a'.repeat(64),{...frame,sha256:'b'.repeat(64)}),/checksum/);
});
test('screened-source lookup covers old numeric IDs and canonical Reel/cross-post URLs',async()=>{
 const db=sqliteD1();await db.prepare('INSERT INTO discovery_posts(id,data,updated_at) VALUES(?,?,?)').bind('old_numeric_owner',JSON.stringify({source_url:'https://www.instagram.com/p/CODE/'}),'2099-01-01').run();
 const result=await op(db,'posts.lookup',{ids:['CODE'],sources:['https://instagram.com/reel/CODE/?utm_source=x']});
 assert.deepEqual(result.screenedIds,['old_numeric_owner']);assert.deepEqual(result.screenedKeys,['ig:CODE']);
});
test('Apps Script conditional snapshot emits unchanged hashes and explicit removals without dropping aliases',()=>{
 const hash=(algorithm,text)=>[...createHash('sha256').update(text).digest()];let rows=[event('ONE','2099-12-19')];
 const lookups={artistById:{},venueById:{ROOM:{id:'ROOM',publicName:'Test room'}},partyById:{},artistAliases:[],venueAliases:[{id:'ROOM',key:'Alias',exactOnly:true}],partyAliases:[],collAliases:[]};
 const c=vm.createContext({Calendar:{Events:{list:()=>({items:[]})}},CONFIG:{CALENDAR_ID:'existing'},qviEventTable_:()=>({rows}),buildLookupMaps_:()=>lookups,
  getWindowBounds:()=>({timeMin:'2099-01-01T00:00:00Z',timeMax:'2100-01-01T00:00:00Z'}),ss_:()=>({getSheetByName:()=>null}),
  qdpDiscoveryTable_:()=>({records:[]}),nowISO:()=>new Date().toISOString(),Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:hash}});
 vm.runInContext(fs.readFileSync(new URL('../apps-script/DiscoveryInbox.gs',import.meta.url),'utf8'),c);c.qdpInboxEvent_=(table,row)=>row;
 const first=c.qdpInboxSnapshot_({mode:'delta',known:{}});assert.equal(first.events.length,1);assert.equal(first.frameUploadVersion,1);assert.ok(first.references.venueAliases.length);
 const known=first.hashes,second=c.qdpInboxSnapshot_({mode:'delta',known});assert.equal(second.events.length,0);assert.equal(second.references,undefined);assert.equal(Object.keys(second.hashes.events).length,1);
 rows=[];const removed=c.qdpInboxSnapshot_({mode:'delta',known});assert.equal(Object.keys(removed.hashes.events).length,0);
});
test('unrelated payload changes and double-click retries cannot overwrite journal versions',async()=>{
 const db=sqliteD1(),body={runId:'run',key:'metrics:1',value:'same',version:0};
 const first=await op(db,'work.save',body),recovered=await op(db,'work.save',body);assert.equal(first.version,recovered.version);assert.equal(recovered.recovered,true);
 await assert.rejects(()=>op(db,'work.save',{...body,value:'different'}),/changed/);
});
