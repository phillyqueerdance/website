import {flyerRecoveryAction} from './discovery-flyer-recovery.js';
// Restricted discovery operations. All durable state uses the existing D1 binding.
import {meta, setMeta, now, record} from './discovery-store.js';
import {digest, normalized, sourceReference} from '../shared/discovery-identity.js';

export const PERFORMANCE_ACTIONS = new Set(['pipeline.bootstrap','posts.lookup','posts.delta','snapshot.sync','match',
  'work.read','work.save','checkpoint.patch','venues.read','venues.save','flyers.frame.part','flyers.frame.commit','flyers.image.part','flyers.image.commit','flyer-retries.claim','flyer-retries.complete']);
const validRun = id => typeof id === 'string' && /^[-a-zA-Z0-9_:]{1,128}$/.test(id);
const validHash = value => /^[a-f0-9]{64}$/.test(value || '');
function strings(values, limit, length = 300) {
  if (!Array.isArray(values) || values.length > limit || values.some(v => typeof v !== 'string' || !v || v.length > length)) throw new Error('Invalid bounded lookup.');
  return [...new Set(values)];
}
function checkpointPatch(value) {
  const allowed = ['last_completed_collection_at','last_completed_review_at','last_review_status','coverage','profileResults','deferredGaps','activeRun'];
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Invalid checkpoint patch.');
  return value;
}
async function cached(db, keys) {
  if (!keys.length) return [];
  const rows = await db.prepare('SELECT key,value FROM discovery_meta WHERE key IN (SELECT value FROM json_each(?))').bind(JSON.stringify(keys)).all();
  return rows.results.map(row => ({key:row.key, value:JSON.parse(row.value)}));
}
const stampRow = (key, value) => ({key, value:JSON.stringify(value), updated_at:now()});
async function putRows(db, rows) {
  // A JSON parameter uses one SQL statement per bounded group, well below Free subrequest limits.
  let batch = [], bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    await db.prepare(`INSERT INTO discovery_meta(key,value,updated_at)
      SELECT json_extract(value,'$.key'),json_extract(value,'$.value'),json_extract(value,'$.updated_at') FROM json_each(?) WHERE 1
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,version=discovery_meta.version+1,updated_at=excluded.updated_at`)
      .bind(JSON.stringify(batch)).run(); batch=[]; bytes=0;
  };
  for (const row of rows) { const size=JSON.stringify(row).length; if(bytes+size>400000) await flush(); batch.push(row);bytes+=size; }
  await flush();
}
function dateOf(value) {
  const raw = value.date || value.fields?.start || value.start?.dateTime || value.start?.date || '';
  const time = Date.parse(raw);
  return raw.length === 10 ? raw : Number.isFinite(time) ? new Intl.DateTimeFormat('en-CA', {
    timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time)) : '';
}
function indexEntry(kind, id, hash, value) {
  return {kind,id,hash,key:'snapshot:'+kind+':'+hash,date:dateOf(value),title:value.title||'',
    location:value.location||'',venueId:value.venueId||'',sourceKey:value.sourceKey||'',
    sources:[value.sourceUrl,value.instagramUrl,value.url].filter(Boolean).map(sourceReference)};
}
export async function syncSnapshot(db, apps) {
  const previous = await meta(db,'snapshot-head'), head=previous?.value;
  const known = Object.fromEntries(['events','calendar','intake'].map(kind => [kind,
    Object.fromEntries((head?.index||[]).filter(r=>r.kind===kind).map(r=>[r.id,r.hash]))]));
  known.references=head?.referencesHash || '';
  const upstream=await apps({action:'admin.discovery.snapshot',mode:'delta',known});
  if(upstream.inboxVersion!==1) throw new Error('A complete inboxVersion=1 snapshot is required before collection.');
  if(upstream.deltaVersion && upstream.deltaVersion!==1) throw new Error('Unsupported snapshot delta.');
  const rows=[], index=upstream.deltaVersion ? [...(head?.index||[])] : [];
  for(const kind of ['events','calendar','intake']) {
    for(const value of upstream[kind]||[]) {
      const id=kind==='events'?value.eventId:kind==='calendar'?value.id:value.snapshotId || await digest(JSON.stringify([value.title,value.date,value.location,value.sourceKey]));
      const hash=upstream.hashes?.[kind]?.[id] || await digest(JSON.stringify(value));
      const old=index.findIndex(r=>r.kind===kind&&r.id===id);
      if(old>=0) index.splice(old,1);
      index.push(indexEntry(kind,id,hash,value));
      if(!head?.index?.some(r=>r.kind===kind&&r.id===id&&r.hash===hash)) rows.push(stampRow('snapshot:'+kind+':'+hash,value));
    }
    if(upstream.deltaVersion) {
      const live=new Set(Object.keys(upstream.hashes?.[kind]||{}));
      for(let i=index.length-1;i>=0;i--) if(index[i].kind===kind&&!live.has(index[i].id)) index.splice(i,1);
    }
  }
  let referencesHash=head?.referencesHash;
  if(upstream.references) {referencesHash=upstream.hashes?.references || await digest(JSON.stringify(upstream.references));
    if(referencesHash!==head?.referencesHash) rows.push(stampRow('snapshot:references:'+referencesHash,upstream.references));}
  if(!referencesHash) throw new Error('Snapshot aliases are missing; absence cannot be established.');
  // Reconcile legacy owner decisions exactly as the original snapshot path does.
  if(upstream.legacyDecisions?.length) await db.prepare(`INSERT INTO discovery_decisions(alias,item_id,kind,date,decision,updated_at)
    SELECT json_extract(value,'$.alias'),json_extract(value,'$.id'),json_extract(value,'$.kind'),json_extract(value,'$.date'),json_extract(value,'$.decision'),json_extract(value,'$.updatedAt')
    FROM json_each(?) WHERE 1 ON CONFLICT(alias) DO UPDATE SET item_id=excluded.item_id,kind=excluded.kind,date=excluded.date,decision=excluded.decision,updated_at=excluded.updated_at
    WHERE excluded.updated_at>discovery_decisions.updated_at`).bind(JSON.stringify(upstream.legacyDecisions)).run();
  await putRows(db,rows);
  const next={inboxVersion:1,readAt:upstream.readAt,window:upstream.window,index,referencesHash,
    capabilities:{frameUpload:upstream.frameUploadVersion===1?1:0,snapshotDelta:upstream.deltaVersion===1?1:0,imageUpload:upstream.imageUploadVersion===1?1:0,appsScriptVersion:upstream.discoveryVersion||null}};
  // Content-addressed records make interrupted syncs harmless. Publish the head last with CAS.
  const saved=await setMeta(db,'snapshot-head',next,previous?.version||0);
  return {inboxVersion:1,readAt:next.readAt,window:next.window,snapshotVersion:saved.version,
    counts:Object.fromEntries(['events','calendar','intake'].map(kind=>[kind,index.filter(r=>r.kind===kind).length])),
    changedRecords:rows.length,upstreamDelta:upstream.deltaVersion===1,capabilities:next.capabilities};
}
export async function matchFacts(db, body) {
  if(!Array.isArray(body.facts)||body.facts.length>50) throw new Error('Compare up to fifty facts at a time.');
  const saved=await meta(db,'snapshot-head');
  if(!saved) throw new Error('Synchronize the authoritative snapshot before matching.');
  const head=saved.value;
  const refs=(await meta(db,'snapshot:references:'+head.referencesHash))?.value;
  if(!refs) throw new Error('Snapshot aliases are unavailable.');
  const dates=new Set(), sources=new Set(), aliases=new Set(), eventIds=new Set();
  for(const fact of body.facts) {
    if(!fact || JSON.stringify(fact).length>20000) throw new Error('Invalid event facts.');
    if(fact.date && !/^\d{4}-\d{2}-\d{2}$/.test(fact.date)) throw new Error('Use an ISO event date.');
    if(fact.date) dates.add(fact.date);
    for(const url of fact.sources||[]) {const source=sourceReference(url);if(source)sources.add(source);}
    for(const id of fact.aliases||[]) {if(!validHash(id))throw new Error('Invalid edition alias.');aliases.add(id);}
    if(fact.eventId) eventIds.add(String(fact.eventId).toUpperCase());
  }
  const wanted=head.index.filter(entry=>dates.has(entry.date)||eventIds.has(entry.id.toUpperCase())||aliases.has(entry.sourceKey.replace(/^qdp-discovery:v1:/,''))||entry.sources.some(s=>sources.has(s)));
  const items=await db.prepare(`SELECT DISTINCT i.* FROM discovery_items i LEFT JOIN discovery_aliases a ON a.item_id=i.id
    WHERE (i.date IN (SELECT value FROM json_each(?)) OR json_extract(i.edits,'$.fields.StartDate') IN (SELECT value FROM json_each(?))) OR a.alias IN (SELECT value FROM json_each(?))
    OR upper(json_extract(i.data,'$.eventId')) IN (SELECT value FROM json_each(?))
    OR EXISTS(SELECT 1 FROM json_each(json_array(json_extract(i.data,'$.sourceUrl'),json_extract(i.data,'$.fields.Instagram_URL'),json_extract(i.data,'$.fields.Event_URL'))) s
      JOIN json_each(?) urls ON rtrim(s.value,'/')=rtrim(urls.value,'/'))`)
    .bind(JSON.stringify([...dates]),JSON.stringify([...dates]),JSON.stringify([...aliases]),JSON.stringify([...eventIds]),JSON.stringify(body.facts.flatMap(f=>f.sources||[]))).all();
  // Source aliases are canonicalized in JS so www/reel/p links and query strings match too.
  // Only the narrow source projection is scanned; full unrelated proposals never leave D1.
  if(sources.size) {
    const sourceRows=await db.prepare(`SELECT id,json_extract(data,'$.sourceUrl') AS source,json_extract(data,'$.fields.Instagram_URL') AS instagram,json_extract(data,'$.fields.Event_URL') AS eventUrl,json_extract(edits,'$.fields.Instagram_URL') AS editedInstagram,json_extract(edits,'$.fields.Event_URL') AS editedEventUrl FROM discovery_items`).all();
    const ids=sourceRows.results.filter(r=>[r.source,r.instagram,r.eventUrl,r.editedInstagram,r.editedEventUrl].some(u=>sources.has(sourceReference(u)))).map(r=>r.id);
    if(ids.length) {const extra=await db.prepare('SELECT * FROM discovery_items WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all();
      for(const row of extra.results) if(!items.results.some(r=>r.id===row.id)) items.results.push(row);}
  }
  const values=await cached(db,wanted.map(r=>r.key)),byKey=new Map(values.map(v=>[v.key,v.value]));
  if(wanted.some(r=>!byKey.has(r.key))) throw new Error('The matching cache is incomplete. Synchronize it before claiming absence.');
  const selected={events:[],calendar:[],intake:[]};for(const entry of wanted)selected[entry.kind].push(byKey.get(entry.key));
  const venueKey=(location,id)=>{
    if(id)return String(id).toUpperCase();const key=normalized(location);
    const matches=new Set((refs.venues||[]).filter(v=>[v.name,v.address].some(n=>normalized(n)===key)).map(v=>v.id));
    for(const alias of refs.venueAliases||[])if(normalized(alias.key)===key)matches.add(alias.id);
    return matches.size===1?[...matches][0]:key;
  };
  const comparisons=body.facts.map((fact,factIndex)=>({factIndex,datedComparisonComplete:Boolean(fact.date||fact.eventId),
    potentialMatches:wanted.filter(entry=>eventIds.has(entry.id.toUpperCase())||
      entry.sources.some(source=>(fact.sources||[]).some(url=>sourceReference(url)===source))||
      (fact.date===entry.date && normalized(fact.title)===normalized(entry.title) &&
       venueKey(fact.location,fact.venueId)===venueKey(entry.location,entry.venueId)))
      .map(entry=>({kind:entry.kind,id:entry.id,reason:entry.date===fact.date?'same edition or stable source':'stable source with changed date',potentialCorrection:entry.kind!=='intake'}))}));
  return {inboxVersion:1,readAt:head.readAt,window:head.window,...selected,references:refs,items:items.results.map(record),comparisons,
    matchingComplete:body.facts.every(f=>Boolean(f.date||f.eventId)),
    note:'All records on supplied edition dates plus stable-source/ID matches. Resolve uncertain dates, rooms and aliases before claiming absence.'};
}
function frameIdentity(body) {
  if(!validHash(body.id)||!validHash(body.sha256)) throw new Error('A proposal and exact image SHA-256 are required.');
  return (body.kind==='image'?'image:':'frame:')+body.id+':'+body.sha256;
}
function frameSource(source) {
  if(!source || source.verified!==true || !String(source.postUrl||'').startsWith('https://') || !/^ig:/.test(sourceReference(source.postUrl)) ||
    (source.kind!=='image'&&(!Number.isFinite(source.seconds)||source.seconds<0||source.seconds>10800))) throw new Error('A visually verified Instagram video frame and timestamp are required.');
  const postUrl='https://www.instagram.com/p/'+sourceReference(source.postUrl).slice(3)+'/';
  return source.kind==='image'?{postUrl,kind:'image',verified:true}:{postUrl,seconds:source.seconds,verified:true};
}
export async function performanceAction(db, action, body, apps) {
  if(action.startsWith('flyers.image.')){body={...body,kind:'image',...(body.source?{source:{...body.source,kind:'image'}}:{})};action=action.replace('flyers.image.','flyers.frame.');}
  if(action.startsWith('flyer-retries.'))return flyerRecoveryAction(db,action,body);
  if(action==='pipeline.bootstrap') {
    const [config,checkpoint]=await Promise.all([meta(db,'config'),meta(db,'checkpoint')]);
    const budget=await db.prepare('SELECT id,day,status,reserved_usd,actual_usd FROM discovery_runs WHERE day=?').bind(body.day||new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())).all();
    const value=checkpoint?.value||{};
    return {pipelineVersion:1,config:config?.value||{},checkpoint:{version:checkpoint?.version||0,value:Object.fromEntries(Object.entries(value).filter(([k])=>!['coverage','profileResults','deferredGaps'].includes(k)))},budget:budget.results,
      capabilities:{frameUpload:(await meta(db,'snapshot-head'))?.value?.capabilities?.frameUpload||0,snapshotDelta:1},snapshot:(await meta(db,'snapshot-head'))?.value?.readAt||null};
  }
  if(action==='checkpoint.patch') {
    const prior=await meta(db,'checkpoint');
    if(body.version!==(prior?.version||0)) throw new Error('This checkpoint changed. Reload before applying a patch.');
    return setMeta(db,'checkpoint',{...(prior?.value||{}),...checkpointPatch(body.value)},body.version);
  }
  if(action==='posts.lookup') {
    const ids=strings(body.ids||[],300), sources=strings(body.sources||[],300,3000), urls=new Set(sources);
    for(const source of sources){const ref=sourceReference(source);if(!ref.startsWith('ig:'))continue;
      for(const host of ['www.instagram.com','instagram.com','m.instagram.com','instagr.am'])for(const path of ['p','reel','reels','tv'])for(const tail of ['/',''])urls.add('https://'+host+'/'+path+'/'+ref.slice(3)+tail);}
    await db.prepare("CREATE INDEX IF NOT EXISTS discovery_posts_source ON discovery_posts(json_extract(data,'$.source_url'))").run();
    const rows=ids.length||urls.size ? await db.prepare("SELECT id,json_extract(data,'$.source_url') AS source FROM discovery_posts WHERE id IN (SELECT value FROM json_each(?)) OR json_extract(data,'$.source_url') IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids),JSON.stringify([...urls])).all():{results:[]};
    return {screenedIds:rows.results.map(r=>r.id),screenedKeys:[...new Set(rows.results.map(r=>sourceReference(r.source)).filter(Boolean))],queried:ids.length};
  }
  if(action==='posts.delta') {
    const cursor=body.cursor||{updatedAt:'',id:''},limit=Math.min(300,Math.max(1,Number(body.limit)||300));
    if(typeof cursor.updatedAt!=='string'||typeof cursor.id!=='string')throw new Error('Invalid screening cursor.');
    await db.prepare('CREATE INDEX IF NOT EXISTS discovery_posts_delta ON discovery_posts(updated_at,id)').run();
    const rows=await db.prepare('SELECT id,updated_at FROM discovery_posts WHERE (updated_at,id)>(?,?) ORDER BY updated_at,id LIMIT ?').bind(cursor.updatedAt,cursor.id,limit+1).all();
    const page=rows.results.slice(0,limit),last=page.at(-1);
    return {posts:page,cursor:last?{updatedAt:last.updated_at,id:last.id}:cursor,hasMore:rows.results.length>limit};
  }
  if(action==='snapshot.sync') return syncSnapshot(db,apps);
  if(action==='match') return matchFacts(db,body);
  if(action==='work.read'||action==='work.save') {
    if(!validRun(body.runId)) throw new Error('Invalid pipeline run.');
    const prefix='pipeline:'+body.runId+':';
    if(action==='work.read') {
      const root=await meta(db,prefix+'state:0');
      if(body.sections&&(!Array.isArray(body.sections)||body.sections.some(s=>!['inputs','media','review','venues','metrics'].includes(s))))throw new Error('Invalid pipeline section filter.');
      const keys=root?Object.entries(root.value.manifest||{}).filter(([section])=>!body.sections||body.sections.includes(section)).flatMap(([,section])=>section.parts).map(key=>prefix+key):[];
      const rows=keys.length?await db.prepare('SELECT key,value,version FROM discovery_meta WHERE key IN (SELECT value FROM json_each(?))').bind(JSON.stringify(keys)).all():{results:[]};
      const allKeys=await db.prepare('SELECT key FROM discovery_meta WHERE key>=? AND key<?').bind(prefix,prefix+'\uffff').all();
      const nextIndexes={};for(const row of allKeys.results){const [section,index]=row.key.slice(prefix.length).split(':');nextIndexes[section]=Math.max(nextIndexes[section]||0,Number(index)+1);}
      const records=rows.results.map(r=>({key:r.key.slice(prefix.length),value:JSON.parse(r.value),version:r.version}));
      if(root)records.push({key:'state:0',...root});
      return {records,nextIndexes};
    }
    if(!/^(state|inputs|media|review|venues|metrics):\d{1,3}$/.test(body.key||'')) throw new Error('Invalid pipeline section.');
    const previous=await meta(db,prefix+body.key);
    if(previous && previous.version===body.version+1 && JSON.stringify(previous.value)===JSON.stringify(body.value))return {version:previous.version,recovered:true};
    return setMeta(db,prefix+body.key,body.value,body.version);
  }
  if(action==='venues.read'||action==='venues.save') {
    if(!['vals','dolphin','wow','searches'].includes(body.source)) throw new Error('Choose an authorized free discovery source.');
    if(action==='venues.read') return {state:await meta(db,'venue:'+body.source)};
    return setMeta(db,'venue:'+body.source,body.value,body.version);
  }
  if(action==='flyers.frame.part') {
    const key=frameIdentity(body),source=frameSource(body.source);
    await db.prepare("DELETE FROM discovery_meta WHERE ((key>='frame:' AND key<'frame;') OR (key>='image:' AND key<'image;')) AND updated_at<?").bind(new Date(Date.now()-2*86400000).toISOString()).run();
    if(!Number.isInteger(body.index)||!Number.isInteger(body.total)||body.total<1||body.total>64||body.index<0||body.index>=body.total||
      typeof body.base64!=='string'||!body.base64.length||body.base64.length>131072||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.base64)) throw new Error('Invalid bounded frame chunk.');
    const value={base64:body.base64,total:body.total,source},part=key+':'+body.index;
    const previous=await meta(db,part);
    if(previous) {if(JSON.stringify(previous.value)!==JSON.stringify(value))throw new Error('This upload chunk changed.');return {saved:true};}
    await setMeta(db,part,value,0);return {saved:true};
  }
  if(action==='flyers.frame.commit') {
    const key=frameIdentity(body),receipt=await meta(db,'receipt:'+key);
    if(receipt) return {...receipt.value,alreadySaved:true};
    const rows=await db.prepare('SELECT key,value FROM discovery_meta WHERE key>=? AND key<?').bind(key+':',key+':\uffff').all();
    const chunks=rows.results.map(r=>({index:Number(r.key.slice(key.length+1)),...JSON.parse(r.value)})).sort((a,b)=>a.index-b.index);
    if(!chunks.length||chunks.length!==chunks[0].total||chunks.some((c,i)=>c.index!==i||c.total!==chunks.length||JSON.stringify(c.source)!==JSON.stringify(chunks[0].source)))throw new Error('The frame upload is incomplete. Resume its missing chunks.');
    const binary=chunks.map(c=>atob(c.base64)).join('');
    if(binary.length>6*1024*1024||binary.length<12)throw new Error('Use an original image up to 6 MB.');
    const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0)),hash=await crypto.subtle.digest('SHA-256',bytes);
    if(Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')!==body.sha256)throw new Error('The frame checksum does not match.');
    const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255,png=bytes.slice(0,8).join(',')==='137,80,78,71,13,10,26,10';
    const gif=String.fromCharCode(...bytes.slice(0,6)).match(/^GIF8[79]a$/),webp=String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
    if(!jpeg&&!png&&!(body.kind==='image'&&(gif||webp)))throw new Error('Use original JPEG/PNG frames or JPEG/PNG/GIF/WebP post images.');
    // btoa cannot take a six-megabyte spread argument. Each binary chunk is encoded independently above.
    const base64=btoa(binary),result=await apps({action:'admin.discovery.flyers',items:[{id:body.id,frame:{base64,sha256:body.sha256,source:chunks[0].source}}]});
    const saved=result.flyers?.find(f=>f.id===body.id);
    if(!saved?.url||saved.error)throw new Error(saved?.error||'Frame preservation was not confirmed.');
    await putRows(db,[stampRow('receipt:'+key,{id:body.id,url:saved.url,sha256:body.sha256,fromVideo:body.kind!=='image'})]);
    await db.prepare('DELETE FROM discovery_meta WHERE key>=? AND key<?').bind(key+':',key+':\uffff').run();
    return {id:body.id,url:saved.url,sha256:body.sha256,fromVideo:body.kind!=='image'};
  }
  throw new Error('Unknown performance operation.');
}
