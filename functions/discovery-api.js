import { verifyAccess, requestAppsScriptAdmin } from './admin/api.js';
import {database,record,meta,setMeta,stage,listItems,saveItem,reserveBudget,today,now,TASK_ACTIONS} from './discovery-store.js';

const response=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'}});
async function bodyJSON(request) {
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')||''))throw new Error('Expected JSON.');
  if(Number(request.headers.get('Content-Length'))>512*1024)throw new Error('Request is too large.');
  const reader=request.body?.getReader();if(!reader)throw new Error('Request body is required.');
  const chunks=[];let length=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>512*1024)throw new Error('Request is too large.');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function taskAuth(request,env) {
  const expected=String(env.QDP_DISCOVERY_TASK_TOKEN||''),provided=request.headers.get('Authorization')?.replace(/^Bearer /,'')||'';
  if(!expected||provided.length>256)return false;
  const enc=new TextEncoder();
  // HMAC verify is constant-time in both Workers and the local Web Crypto implementation.
  const key=await crypto.subtle.importKey('raw',enc.encode(expected),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
  const signature=await crypto.subtle.sign('HMAC',key,enc.encode(expected));
  return crypto.subtle.verify('HMAC',key,signature,enc.encode(provided));
}
async function apps(env,body) {
  const data=await requestAppsScriptAdmin(env,body);
  if(data.ok!=='yes')throw new Error(data.error==='Unknown admin action.'
    ?'Install Core.gs v7.4.31 and DiscoveryInbox.gs, then update the existing Apps Script deployment.'
    :data.error||'Google did not confirm this operation.');
  return data;
}
async function bootstrap(db) {
  const [config,checkpoint,runs,counts]=await Promise.all([
    meta(db,'config'),meta(db,'checkpoint'),db.prepare(`SELECT id,day,status,reserved_usd,actual_usd,
      json_object('coverage',json_extract(data,'$.coverage'),'counts',json_extract(data,'$.counts')) AS data,
      updated_at FROM discovery_runs ORDER BY updated_at DESC LIMIT 5`).all(),
    db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN decision='INCLUDE' THEN 1 ELSE 0 END) AS selected,
      SUM(CASE WHEN status='failed' OR error<>'' THEN 1 ELSE 0 END) AS failed FROM discovery_items
      WHERE (date='' OR date>=?) AND decision<>'EXCLUDE' AND status NOT IN ('imported','existing')`).bind(today()).first()
  ]);
  return {config:config?.value||{},checkpoint,runs:runs.results.map(r=>({...r,data:JSON.parse(r.data)})),counts};
}
async function importSelected(context,db,body) {
  if(!Array.isArray(body.items)||!body.items.length||body.items.length>5)throw new Error('Import up to five selected proposals per request.');
  const claimed=[],results=[],token=crypto.randomUUID(),stamp=now(),lease=Date.now()+7*60000;
  for(const requested of body.items) {
    const row=await db.prepare('SELECT * FROM discovery_items WHERE id=?').bind(String(requested.id)).first();
    if(!row||row.version!==requested.version) {results.push({id:requested.id,error:'This proposal changed. Reload it before importing.'});continue;}
    if(['ready','imported','existing'].includes(row.status)){results.push({id:row.id,...JSON.parse(row.result),needsPublish:row.status==='ready'});continue;}
    if(row.decision!=='INCLUDE'){results.push({id:row.id,error:'Choose Include and save the proposal first.'});continue;}
    const result=await db.prepare(`UPDATE discovery_items SET status='importing',lease=?,lease_until=?,error='',updated_at=?
      WHERE id=? AND version=? AND decision='INCLUDE' AND (status IN ('pending','failed','accepted') OR (status='importing' AND lease_until<?))`)
      .bind(token,lease,stamp,row.id,row.version,Date.now()).run();
    if(!result.meta.changes){results.push({id:row.id,error:'This proposal is already processing. Refresh to check its result.'});continue;}
    claimed.push(record(row));
  }
  if(!claimed.length)return {results};
  let upstream;
  try {upstream=await apps(context.env,{action:'admin.discovery.import',items:claimed.map(item=>({id:item.id,kind:item.kind,fields:item.fields,
    eventId:item.eventId,changes:Object.fromEntries(item.selectedFields.map(key=>[key,item.changes[key]])),baseline:item.baseline,
    discovery:item.discovery,sourceUrl:item.sourceUrl,listingUrl:item.listingUrl}))});}
  catch(error){upstream={results:claimed.map(item=>({id:item.id,error:error.message}))};}
  for(const item of claimed) {
    const result=upstream.results?.find(r=>r.id===item.id)||{id:item.id,error:'The import response was incomplete. Retry safely to recover its saved progress.'};
    const status=result.error?'failed':result.alreadyPublished?'existing':'ready';
    await db.prepare(`UPDATE discovery_items SET status=?,result=?,error=?,lease=NULL,lease_until=0,version=version+1,updated_at=?
      WHERE id=? AND lease=?`).bind(status,JSON.stringify(result),result.error||'',now(),item.id,token).run();
    results.push({...result,needsPublish:status==='ready'});
  }
  return {results};
}
async function publish(context,db,body) {
  if(!Array.isArray(body.ids)||body.ids.length>100||!body.ids.length)throw new Error('Choose completed imports to publish.');
  const ids=[...new Set(body.ids)].filter(id=>/^[a-f0-9]{64}$/.test(id));
  const pending=await db.prepare(`SELECT id,result FROM discovery_items WHERE status='ready' AND id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all();
  if(!pending.results.length)return {published:0};
  try {
    const publication=await apps(context.env,{action:'admin.discovery.publish'});
    const stamp=now();await db.prepare(`UPDATE discovery_items SET status='imported',
      result=json_set(result,'$.publishedAt',?,'$.publication',json(?)),error='',version=version+1,updated_at=?
      WHERE status='ready' AND id IN (SELECT value FROM json_each(?))`)
      .bind(stamp,JSON.stringify(publication),stamp,JSON.stringify(pending.results.map(r=>r.id))).run();
    return {published:pending.results.length,publication};
  }catch(error){await db.prepare("UPDATE discovery_items SET error=? WHERE status='ready' AND id IN (SELECT value FROM json_each(?))").bind('Website refresh: '+error.message,JSON.stringify(ids)).run();throw error;}
}
export async function discoveryRequest(context,isTask=false) {
  try {
    if(isTask){if(!await taskAuth(context.request,context.env))return response({error:'Discovery task authorization required.'},403);}
    else {
      if(context.request.headers.get('Origin')!==new URL(context.request.url).origin)return response({error:'Cross-origin requests are not allowed.'},403);
      try{await verifyAccess(context);}catch{return response({error:'Sign in to QDP Admin.'},403);}
    }
    const body=await bodyJSON(context.request),action=String(body.action||'');
    if(isTask&&!TASK_ACTIONS.has(action))return response({error:'This credential can handle review data only.'},403);
    const db=database(context.env);let result;
    if(action==='bootstrap') result=await bootstrap(db);
    else if(action==='items') result=await listItems(db,body);
    else if(action==='stage') result=await stage(db,body.items);
    else if(action==='save'&&!isTask)result=await saveItem(db,body);
    else if(action==='selected'&&!isTask)result={items:(await db.prepare(`SELECT id,version FROM discovery_items WHERE decision='INCLUDE'
      AND (date='' OR date>=?) AND status NOT IN ('imported','existing') ORDER BY date LIMIT 100`).bind(today()).all()).results};
    else if(action==='import'&&!isTask)result=await importSelected(context,db,body);
    else if(action==='publish'&&!isTask)result=await publish(context,db,body);
    else if(action==='snapshot') {
      result=await apps(context.env,{action:'admin.discovery.snapshot'});
      const records=result.legacyDecisions;
      if(Array.isArray(records)&&records.length) {
        // Older workbook choices remain valid after the inbox migration.
        await db.prepare(`INSERT INTO discovery_decisions(alias,item_id,kind,date,decision,updated_at)
          SELECT json_extract(value,'$.alias'),json_extract(value,'$.id'),json_extract(value,'$.kind'),
          json_extract(value,'$.date'),json_extract(value,'$.decision'),json_extract(value,'$.updatedAt') FROM json_each(?) WHERE 1
          ON CONFLICT(alias) DO UPDATE SET item_id=excluded.item_id,kind=excluded.kind,date=excluded.date,
          decision=excluded.decision,updated_at=excluded.updated_at WHERE excluded.updated_at>discovery_decisions.updated_at`)
          .bind(JSON.stringify(records)).run();
        await db.prepare(`UPDATE discovery_items SET decision=(SELECT d.decision FROM discovery_decisions d
          JOIN discovery_aliases a ON a.alias=d.alias WHERE a.item_id=discovery_items.id
          AND (d.kind=discovery_items.kind OR d.decision IN ('WAIT','EXCLUDE'))
          AND (discovery_items.kind='event' OR d.item_id=discovery_items.id OR d.decision IN ('WAIT','EXCLUDE'))
          ORDER BY d.updated_at DESC LIMIT 1),version=version+1,updated_at=? WHERE status IN ('pending','failed','accepted')
          AND EXISTS(SELECT 1 FROM discovery_decisions d JOIN discovery_aliases a ON a.alias=d.alias
            WHERE a.item_id=discovery_items.id AND d.updated_at>discovery_items.updated_at)` ).bind(now()).run();
      }
    }
    else if(action==='flyers') {
      if(!Array.isArray(body.items)||body.items.length>3)throw new Error('Preserve up to three proposal flyers at a time.');
      // No arbitrary Google operation is accepted through the task route.
      result=await apps(context.env,{action:'admin.discovery.flyers',items:body.items});
    }
    else if(action==='checkpoint') {
      if(!body.value||typeof body.value!=='object'||!Number.isInteger(body.version))throw new Error('A versioned checkpoint is required.');
      const allowed=['last_completed_collection_at','last_completed_review_at','last_review_status','coverage','profileResults','deferredGaps','activeRun'];
      const value=Object.fromEntries(Object.entries(body.value).filter(([key])=>allowed.includes(key)));
      result=await setMeta(db,'checkpoint',value,body.version);
    }
    else if(action==='posts.read') {
      const after=String(body.after||''),limit=Math.min(500,Math.max(1,Number(body.limit)||500));
      const rows=await db.prepare('SELECT id,data FROM discovery_posts WHERE id>? ORDER BY id LIMIT ?').bind(after,limit+1).all();
      result={posts:rows.results.slice(0,limit).map(row=>{const data=JSON.parse(row.data);return body.full?{...data,id:row.id}:
        {id:row.id,source_url:data.source_url,review_method:data.review_method,taken_at:data.taken_at,unavailable_images:data.unavailable_images};}),cursor:rows.results.length>limit?rows.results[limit-1].id:null};
    }
    else if(action==='posts.save') {
      if(!Array.isArray(body.posts)||body.posts.length>30)throw new Error('Save up to thirty screened post records.');
      const statements=body.posts.map(post=>{
        if(typeof post.id!=='string'||!post.id||post.id.length>300||JSON.stringify(post).length>60000)throw new Error('Invalid post checkpoint.');
        return db.prepare('INSERT INTO discovery_posts(id,data,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').bind(post.id,JSON.stringify(post),now());
      });if(statements.length)await db.batch(statements);result={saved:statements.length};
    }
    else if(action==='budget.reserve')result=await reserveBudget(db,body);
    else if(action==='run.read') {
      const row=await db.prepare('SELECT * FROM discovery_runs WHERE id=?').bind(String(body.id||'')).first();
      result={run:row?{...row,data:JSON.parse(row.data)}:null};
    }
    else if(action==='run.save') {
      if(!/^[-a-zA-Z0-9_:]{1,128}$/.test(body.id||''))throw new Error('Invalid run ID.');
      if(JSON.stringify(body.data||{}).length>100000)throw new Error('Run checkpoint is too large.');
      if(body.actualUsd!=null&&(!Number.isFinite(body.actualUsd)||body.actualUsd<0))throw new Error('Invalid actual actor charge.');
      const prior=await db.prepare('SELECT actual_usd FROM discovery_runs WHERE id=?').bind(body.id).first();
      // Only the scraper's confirmed charge can settle a reservation. Unknown charges stay reserved.
      const actual=body.actualUsd==null?prior?.actual_usd:body.actualUsd;
      await db.prepare(`INSERT INTO discovery_runs(id,day,status,data,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,actual_usd=?,updated_at=excluded.updated_at`)
        .bind(body.id,today(),String(body.status||'reviewing').slice(0,100),JSON.stringify(body.data||{}),now(),actual??null).run();result={saved:true};
    }
    else throw new Error('Unknown discovery operation.');
    return response({ok:'yes',...result});
  } catch(error) {
    console.error(JSON.stringify({operation:'discovery',error:error.message}));
    return response({error:error.message||'Discovery Review is unavailable.'},400);
  }
}
