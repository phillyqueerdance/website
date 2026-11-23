// Recovery is limited to upcoming/undated inbox editions still missing artwork.
// This queue never imports, publishes, removes screening history or changes decisions.
import {meta,setMeta,record,now,today} from './discovery-store.js';
import {digest,sourceReference} from '../shared/discovery-identity.js';
const validRun=id=>typeof id==='string'&&/^[-a-zA-Z0-9_:]{1,128}$/.test(id);
const blocked=new Set(['importing','accepted']);
const missingFlyer=item=>!String(item.fields.Flyer_URL||'').trim();

async function targets(db) {
  const rows=await db.prepare(`SELECT * FROM discovery_items WHERE kind='event' AND decision<>'EXCLUDE'
    AND (COALESCE(NULLIF(json_extract(edits,'$.fields.StartDate'),''),date)='' OR COALESCE(NULLIF(json_extract(edits,'$.fields.StartDate'),''),date)>=?)
    AND trim(COALESCE(json_extract(edits,'$.fields.Flyer_URL'),json_extract(data,'$.fields.Flyer_URL'),''))=''`).bind(today()).all();
  const items=rows.results.map(record).filter(item=>!blocked.has(item.status)&&missingFlyer(item));
  const head=(await meta(db,'snapshot-head'))?.value;
  const ids=new Set(items.map(item=>String(item.result?.eventId||item.eventId||'').toUpperCase()).filter(Boolean));
  const entries=(head?.index||[]).filter(entry=>entry.kind==='events'&&ids.has(entry.id.toUpperCase()));
  const saved=entries.length?await db.prepare("SELECT key,json_extract(value,'$.fields.flyer') AS flyer FROM discovery_meta WHERE key IN (SELECT value FROM json_each(?))").bind(JSON.stringify(entries.map(entry=>entry.key))).all():{results:[]};
  const captured=new Set(saved.results.filter(row=>row.flyer).map(row=>entries.find(entry=>entry.key===row.key).id.toUpperCase()));
  return items.filter(item=>!captured.has(String(item.result?.eventId||item.eventId||'').toUpperCase()));
}
async function groupsFor(db) {
  const groups=new Map();
  for(const item of await targets(db)) {
    const urls=[item.fields.Instagram_URL,item.sourceUrl,item.fields.Event_URL].filter(Boolean);
    // Use one source per edition. Cross-posted editions retain their existing identity.
    const source=urls.find(url=>sourceReference(url).startsWith('ig:'));if(!source)continue;
    const ref=sourceReference(source);
    if(!groups.has(ref))groups.set(ref,{sourceRef:ref,sourceUrl:'https://www.instagram.com/'+(/^\/(?:reels?|tv)\//.test(new URL(source).pathname)?'reel':'p')+'/'+ref.slice(3)+'/',items:[]});
    groups.get(ref).items.push(item);
  }
  return [...groups.values()].sort((a,b)=>{
    const earliest=g=>g.items.map(i=>i.fields.StartDate||i.date||'9999').sort()[0];
    return earliest(a).localeCompare(earliest(b))||a.sourceRef.localeCompare(b.sourceRef);
  });
}
export async function flyerRecoveryAction(db,action,body) {
  if(!validRun(body.runId))throw new Error('A valid discovery run is required.');
  if(action==='flyer-retries.claim') {
    const limit=Math.min(10,Math.max(1,Math.floor(Number(body.limit)||10))),jobs=[];
    const groups=await groupsFor(db);let deferred=0;
    for(const group of groups) {
      if(jobs.length>=limit){deferred++;continue;}
      const id=await digest(group.sourceRef),key='flyer-retry:'+id,previous=await meta(db,key),state=previous?.value||{};
      const resolved=new Set(state.resolvedTargets||[]);
      group.items=group.items.filter(item=>!resolved.has(item.id));
      if(!group.items.length)continue;
      const resume=state.status==='running'&&state.runId===body.runId;
      if(!resume && ((state.status==='running'&&state.leaseUntil>Date.now()) || state.lastRunId===body.runId || Date.parse(state.nextAttemptAt||'')>Date.now())){deferred++;continue;}
      const value=resume?state:{...state,sourceRef:group.sourceRef,sourceUrl:group.sourceUrl,status:'running',runId:body.runId,
        lease:crypto.randomUUID(),leaseUntil:Date.now()+6*3600000,targetIds:group.items.map(i=>i.id),attempts:state.attempts||0,claimedAt:now()};
      let version=previous?.version||0;
      if(!resume){try{version=(await setMeta(db,key,value,version)).version;}catch(error){if(/checkpoint changed/.test(error.message)){deferred++;continue;}throw error;}}
      jobs.push({id,version,lease:value.lease,sourceRef:group.sourceRef,sourceUrl:group.sourceUrl,items:group.items,attempts:value.attempts});
    }
    return {jobs,eligibleSources:groups.length,deferred,limit};
  }
  if(action==='flyer-retries.complete') {
    if(!/^[a-f0-9]{64}$/.test(body.id||'')||!Number.isInteger(body.version)||!['saved','not_found','unavailable','superseded'].includes(body.outcome))throw new Error('Invalid flyer recovery outcome.');
    const key='flyer-retry:'+body.id,previous=await meta(db,key),state=previous?.value;
    if(state?.status!=='running'&&state?.lastReceipt===body.lease&&state.lastRunId===body.runId)return {saved:true,alreadySaved:true,status:state.status};
    if(!state||state.runId!==body.runId||state.lease!==body.lease||previous.version!==body.version)throw new Error('This flyer recovery claim changed. Resume its current version.');
    if(!Array.isArray(body.saved||[])||(body.saved||[]).length>30)throw new Error('Invalid recovery receipts.');
    const resolved=new Set(state.resolvedTargets||[]);
    for(const receipt of body.saved||[]) {
      if(!state.targetIds.includes(receipt.targetId)||!/^[a-f0-9]{64}$/.test(receipt.proposalId||'')||typeof receipt.url!=='string')throw new Error('Invalid recovered proposal.');
      const row=await db.prepare('SELECT * FROM discovery_items WHERE id=?').bind(receipt.proposalId).first();
      const item=row&&record(row);
      // A real staged flyer must exist. Imported/frozen proposal updates can be ignored
      // by the normal stage guard, so a file-save receipt alone cannot close this job.
      if(item && (item.fields.Flyer_URL===receipt.url || (item.kind==='correction'&&item.changes.flyer===receipt.url)))resolved.add(receipt.targetId);
    }
    const attempts=(state.attempts||0)+1,done=state.targetIds.every(id=>resolved.has(id));
    const hours=body.outcome==='not_found'?48:attempts>=3?72:24;
    const value={...state,status:done?'saved':'waiting',resolvedTargets:[...resolved],attempts,lastRunId:body.runId,lastReceipt:body.lease,
      lastOutcome:done?'saved':body.outcome,lastError:String(body.error||'').slice(0,1500),lastAttemptAt:now(),
      nextAttemptAt:new Date(Date.now()+hours*3600000).toISOString(),leaseUntil:0};
    await setMeta(db,key,value,body.version);return {saved:true,status:value.status,resolvedTargets:value.resolvedTargets,nextAttemptAt:value.nextAttemptAt};
  }
  throw new Error('Unknown flyer recovery operation.');
}
