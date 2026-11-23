import { discoveryIdentity, validateIdentity, digest } from '../shared/discovery-identity.js';

export const TASK_ACTIONS = new Set(['bootstrap','items','stage','posts.read','posts.save','checkpoint','run.read','run.save','budget.reserve','snapshot','flyers']);
export const DAY_LIMIT = 0.59;
const parse = (s, fallback = {}) => { try { return JSON.parse(s); } catch { return fallback; } };
export const now = () => new Date().toISOString();
export const today = () => new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export function database(env) {
  if (!env.QDP_DISCOVERY) throw new Error('Discovery Review is not configured.');
  return env.QDP_DISCOVERY;
}
export function record(row) {
  const source = parse(row.data), edits = parse(row.edits);
  return {...source, id:row.id, kind:row.kind, date:row.date,
    fields:{...source.fields,...edits.fields}, changes:{...source.changes,...edits.changes},
    selectedFields:edits.selectedFields || source.selectedFields || [],baseline:edits.baseline || source.baseline,
    decision:row.decision,status:row.status,version:row.version,
    isNew:!!row.is_new,isUpdated:!!row.is_updated,result:parse(row.result),error:row.error,
    createdAt:row.created_at,updatedAt:row.updated_at,seenAt:row.seen_at};
}
export async function meta(db, key) {
  const row=await db.prepare('SELECT value,version FROM discovery_meta WHERE key=?').bind(key).first();
  return row?{value:parse(row.value,null),version:row.version}:null;
}
export async function setMeta(db,key,value,expectedVersion) {
  const stamp=now(),text=JSON.stringify(value);
  if (text.length>150000) throw new Error('Checkpoint section is too large. Save records in smaller sections.');
  const result=expectedVersion===0
    ? await db.prepare('INSERT OR IGNORE INTO discovery_meta(key,value,updated_at) VALUES(?,?,?)').bind(key,text,stamp).run()
    : await db.prepare('UPDATE discovery_meta SET value=?,version=version+1,updated_at=? WHERE key=? AND version=?').bind(text,stamp,key,expectedVersion).run();
  if (!result.meta.changes) throw new Error('This checkpoint changed. Reload its current version before retrying.');
  return {version:expectedVersion+1};
}
export function cleanFields(raw) {
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new Error('Event fields are required.');
  const allowed=['Title (internal)','StartDate','EndDate','StartTime','EndTime','Timezone','ExplicitQueer (Yes/No)',
    'Location','Description','Lineup_Raw','RawFlyerURL','Flyer_URL','Event_URL','Instagram_URL','Review_notes',
    'VenueID','ArtistIDs (comma-separated)','PartyID','HostCollectiveIDs (comma-separated)'];
  const out={};
  for(const key of allowed) if(raw[key]!=null) {
    if(typeof raw[key]!=='string'||raw[key].length>50000) throw new Error('Invalid '+key+'.');
    out[key]=raw[key];
  }
  return out;
}
export async function normalizeItem(raw) {
  const kind=raw.kind==='correction'?'correction':'event';
  const fields=cleanFields(raw.fields || {}),date=String(raw.date || fields.StartDate || raw.Date || '');
  if(date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Use an ISO event date.');
  const changes={};
  for(const [key,value] of Object.entries(raw.changes||{})) {
    if(!['description','lineup','start','end','flyer'].includes(key)||typeof value!=='string'||value.length>50000) throw new Error('Invalid correction field.');
    changes[key]=value;
  }
  let identity;
  if(raw.discovery) identity=validateIdentity(raw.discovery);
  else if(date) identity=await discoveryIdentity({...fields,StartDate:date},kind,JSON.stringify(changes));
  else {
    // Undated leads stay visible, but can never be imported until dated.
    const id=await digest('undated|'+JSON.stringify([fields['Title (internal)'],fields.Location,fields.Event_URL]));
    identity={id,kind,date:'',aliases:[id]};
  }
  if(identity.kind!==kind || identity.date!==date) throw new Error('The discovery identity does not match this proposal.');
  const text=(key,max=6000)=>String(raw[key]||'').slice(0,max);
  const out={fields,changes,discovery:identity,eventId:text('eventId',128),title:text('title',1000)||fields['Title (internal)']||'',
    note:text('note'),readiness:text('readiness',500),sourceUrl:text('sourceUrl',3000)||fields.Instagram_URL||fields.Event_URL||'',
    listingUrl:text('listingUrl',3000),baseline:raw.baseline&&typeof raw.baseline==='object'?raw.baseline:null,
    selectedFields:[],runId:text('runId',128)};
  if(JSON.stringify(out).length>200000) throw new Error('Proposal is too large.');
  const content={...out};delete content.runId;
  return {id:identity.id,kind,date,data:out,digest:await digest(JSON.stringify(content))};
}
export async function stage(db, items) {
  if(!Array.isArray(items)||items.length>10) throw new Error('Submit up to ten proposals per request.');
  const values=await Promise.all(items.map(normalizeItem)),stamp=now(),statements=[];
  for(const item of values) {
    statements.push(db.prepare(`INSERT INTO discovery_items(id,kind,date,data,digest,created_at,updated_at,seen_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,digest=excluded.digest,
      date=excluded.date,version=discovery_items.version+CASE WHEN discovery_items.digest<>excluded.digest THEN 1 ELSE 0 END,
      is_updated=CASE WHEN discovery_items.digest<>excluded.digest THEN 1 ELSE discovery_items.is_updated END,
      updated_at=CASE WHEN discovery_items.digest<>excluded.digest THEN excluded.updated_at ELSE discovery_items.updated_at END,
      seen_at=excluded.seen_at WHERE discovery_items.status NOT IN ('imported','existing')`)
      .bind(item.id,item.kind,item.date,JSON.stringify(item.data),item.digest,stamp,stamp,stamp));
    statements.push(db.prepare('INSERT OR IGNORE INTO discovery_aliases(alias,item_id) SELECT value,? FROM json_each(?)')
      .bind(item.id,JSON.stringify(item.data.discovery.aliases)));
    statements.push(db.prepare(`UPDATE discovery_items SET decision=COALESCE((SELECT decision FROM discovery_decisions
      WHERE alias IN (SELECT value FROM json_each(?)) AND (kind=? OR decision IN ('WAIT','EXCLUDE'))
      AND (?='event' OR item_id=? OR decision IN ('WAIT','EXCLUDE')) ORDER BY updated_at DESC LIMIT 1),decision)
      WHERE id=? AND status NOT IN ('importing','ready','imported','existing')`)
      .bind(JSON.stringify(item.data.discovery.aliases),item.kind,item.kind,item.id,item.id));
  }
  // At most ten proposals with eight aliases; split transaction groups to fit Free request limits.
  for(let i=0;i<statements.length;i+=35) await db.batch(statements.slice(i,i+35));
  return {staged:values.length,ids:values.map(v=>v.id)};
}
export async function listItems(db,body={}) {
  const view=String(body.view||'all'),limit=Math.min(50,Math.max(1,Number(body.limit)||25)),offset=Math.max(0,Number(body.offset)||0);
  const day=today(); let where="(date='' OR date>=?)",params=[day];
  if(view==='excluded') where+=" AND decision='EXCLUDE'";
  else if(view==='imported') where+=" AND status IN ('imported','existing')";
  else {
    where+=" AND decision<>'EXCLUDE' AND status NOT IN ('imported','existing')";
    if(view==='new') where+=' AND is_new=1';
    if(view==='updated') where+=' AND is_updated=1';
    if(view==='waiting') where+=" AND decision='WAIT'";
    if(view==='failed') where+=" AND (status='failed' OR error<>'')";
  }
  if(body.query) {where+=" AND (data LIKE ? OR edits LIKE ?)";params.push('%'+String(body.query).slice(0,150)+'%','%'+String(body.query).slice(0,150)+'%');}
  const [rows,count]=await db.batch([
    db.prepare(`SELECT * FROM discovery_items WHERE ${where} ORDER BY CASE WHEN date='' THEN 1 ELSE 0 END,date,created_at LIMIT ? OFFSET ?`).bind(...params,limit,offset),
    db.prepare(`SELECT COUNT(*) AS count FROM discovery_items WHERE ${where}`).bind(...params)
  ]);
  return {items:rows.results.map(record),total:count.results[0].count,offset,limit};
}
export async function saveItem(db,body) {
  if(!/^[a-f0-9]{64}$/.test(body.id||'')) throw new Error('Choose a proposal.');
  const row=await db.prepare('SELECT * FROM discovery_items WHERE id=?').bind(body.id).first();
  if(!row) throw new Error('Proposal not found.');
  if(row.version!==body.version) throw new Error('This proposal changed. Reload it before saving. Your edits have been retained in this page.');
  if(['imported','existing','importing','ready'].includes(row.status)) throw new Error('This proposal is already imported or being processed.');
  const fields=cleanFields(body.fields||{}),current=record(row),changes={...current.changes};
  for(const [key,value] of Object.entries(body.changes||{})) {
    if(!['description','lineup','start','end','flyer'].includes(key)||typeof value!=='string'||value.length>50000)throw new Error('Invalid correction field.');
    changes[key]=value;
  }
  const decision=body.decision||current.decision;
  if(!['WAIT','INCLUDE','EXCLUDE'].includes(decision))throw new Error('Choose Include, Wait or Exclude.');
  const selected=body.selectedFields||current.selectedFields;
  if(!Array.isArray(selected)||selected.some(k=>!Object.hasOwn(changes,k)))throw new Error('Select available correction fields.');
  const nonce=crypto.randomUUID();
  const baseline=body.baseline || current.baseline;
  if(baseline && (baseline.eventId!==current.eventId || JSON.stringify(baseline).length>180000))throw new Error('Invalid listing comparison.');
  const edits={fields:{...parse(row.edits).fields,...fields},changes,selectedFields:selected,baseline,_nonce:nonce};
  const stamp=now(),aliases=current.discovery.aliases,statements=[db.prepare(`UPDATE discovery_items SET edits=?,decision=?,
    version=version+1,is_new=0,is_updated=0,error='',status='pending',updated_at=? WHERE id=? AND version=? AND status<>'importing'`)
    .bind(JSON.stringify(edits),decision,stamp,row.id,row.version)];
  // Include is intent here; a separate status records completed imports.
  const savedAliases=current.kind==='correction'&&decision!=='EXCLUDE'?[row.id]:aliases;
  for(const alias of savedAliases)statements.push(db.prepare(`INSERT INTO discovery_decisions(alias,item_id,kind,date,decision,updated_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM discovery_items WHERE id=? AND json_extract(edits,'$._nonce')=?)
    ON CONFLICT(alias) DO UPDATE SET item_id=excluded.item_id,kind=excluded.kind,date=excluded.date,
    decision=excluded.decision,updated_at=excluded.updated_at`).bind(alias,row.id,row.kind,row.date,decision,stamp,row.id,nonce));
  if(decision!=='INCLUDE') statements.push(db.prepare(`UPDATE discovery_items SET decision=?,version=version+1,
    updated_at=? WHERE id<>? AND status NOT IN ('importing','ready','imported','existing')
    AND id IN (SELECT item_id FROM discovery_aliases WHERE alias IN (SELECT value FROM json_each(?)))
    AND EXISTS(SELECT 1 FROM discovery_items WHERE id=? AND json_extract(edits,'$._nonce')=?)`)
    .bind(decision,stamp,row.id,JSON.stringify(aliases),row.id,nonce));
  const results=await db.batch(statements);
  if(!results[0].meta.changes)throw new Error('This proposal changed during saving. Reload before retrying.');
  return {item:record({...row,edits:JSON.stringify(edits),decision,version:row.version+1,is_new:0,is_updated:0,status:'pending',error:'',updated_at:stamp})};
}
export async function reserveBudget(db,body) {
  if(typeof body.id!=='string'||!/^[-a-zA-Z0-9_:]{1,128}$/.test(body.id))throw new Error('A unique reservation ID is required.');
  const day=today(),amount=Number(body.amount);
  if(!Number.isFinite(amount)||amount<=0||amount>DAY_LIMIT)throw new Error('The daily actor budget is $0.59.');
  const stamp=now();
  const result=await db.prepare(`INSERT OR IGNORE INTO discovery_runs(id,day,status,reserved_usd,data,updated_at)
    SELECT ?,?,'reserved',?,'{}',? WHERE (SELECT COALESCE(SUM(COALESCE(actual_usd,reserved_usd)),0) FROM discovery_runs WHERE day=?) + ? <= 0.59000001`)
    .bind(body.id,day,amount,stamp,day,amount).run();
  const row=await db.prepare('SELECT * FROM discovery_runs WHERE id=?').bind(body.id).first();
  if(!row||row.day!==day||row.reserved_usd!==amount)throw new Error('The available daily actor budget is insufficient. Reuse saved runs.');
  return {reservation:row,created:!!result.meta.changes};
}
