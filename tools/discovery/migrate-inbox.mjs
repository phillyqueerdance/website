// One-time owner-run migration. Generated SQL and private input stay outside Git.
import fs from 'node:fs/promises';import {DatabaseSync} from 'node:sqlite';
import {normalizeItem} from '../../functions/discovery-store.js';
import {candidateItem,correctionItem} from './inbox-payload.mjs';
import {createHash} from 'node:crypto';
const [input,output]=process.argv.slice(2);if(!input||!output)throw new Error('Supply a private legacy state and private output directory.');
const state=JSON.parse(await fs.readFile(input,'utf8')),sql=new DatabaseSync(':memory:');sql.exec(await fs.readFile(new URL('../../migrations/discovery/0001.sql',import.meta.url),'utf8'));
const stamp=new Date().toISOString(),secrets=new Set();
function collect(value,key=''){if(value&&typeof value==='object')for(const [k,v] of Object.entries(value))collect(v,k);else if(typeof value==='string'&&/token|secret|password|credential/i.test(key)&&value.length>15)secrets.add(value);}
collect(state);
function redact(value,key=''){if(/token|secret|password|credential/i.test(key))return '[retired credential retained only in the private legacy backup]';if(Array.isArray(value))return value.map(v=>redact(v));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redact(v,k)]));if(typeof value==='string'){for(const secret of secrets)value=value.split(secret).join('[retired credential]');}return value;}
const insertMeta=sql.prepare('INSERT INTO discovery_meta(key,value,updated_at) VALUES(?,?,?)');
insertMeta.run('config',JSON.stringify({actor:state.actor,usernames:state.usernames,intakeHeaders:state.intake_headers,
  settings:{postsPerProfile:3,overlapHours:6,maxDailyActorChargeUsd:.59,timezone:'America/New_York'},
  migratedFrom:{libraryFileId:'libfile_9e81ca4b42488191a688ff0435ff6079',version:60,at:stamp}}),stamp);
insertMeta.run('checkpoint',JSON.stringify({last_completed_collection_at:state.last_completed_collection_at,last_completed_review_at:state.last_completed_review_at,
  last_review_status:state.last_review_status,coverage:state.daily_discovery?.lastCoverage||{},activeRun:null,
  deferredGaps:state.daily_discovery?.deferredCollectionGaps||[]}),stamp);
const putPost=sql.prepare('INSERT OR IGNORE INTO discovery_posts(id,data,updated_at) VALUES(?,?,?)');
for(const post of state.reviewed_or_screened_posts||[]){const id=post.id||post.post_id||post.source_url||createHash('sha256').update(JSON.stringify(post)).digest('hex');
  const marker=Object.fromEntries(['source_url','account','source_accounts','taken_at','review_method','unavailable_images','caption_sha256'].filter(k=>k in post).map(k=>[k,post[k]]));
  putPost.run(String(id),JSON.stringify(redact(marker)),stamp);}
const decisions=state.daily_discovery?.decisions||[];
const putDecision=sql.prepare('INSERT OR REPLACE INTO discovery_decisions(alias,item_id,kind,date,decision,updated_at) VALUES(?,?,?,?,?,?)');
for(const d of decisions)putDecision.run(d.alias||d.id,d.id,d.kind,d.date,d.decision,d.updatedAt);
let candidates=0,corrections=0,excluded=0;
for(const [kind,original,isExcluded] of [...(state.pending_candidates||[]).map(c=>['event',c,false]),...(state.daily_discovery?.excludedCandidates||[]).map(c=>['event',c,true]),
  ...(state.daily_discovery?.pendingCorrections||[]).map(c=>['correction',c,false]),...(state.daily_discovery?.excludedCorrections||[]).map(c=>['correction',c,true])]){
  const raw=kind==='event'?await candidateItem(original):await correctionItem(original);if(!raw)continue;
  const item=await normalizeItem(raw),decision=isExcluded?'EXCLUDE':'WAIT';
  sql.prepare('INSERT OR IGNORE INTO discovery_items(id,kind,date,data,digest,decision,created_at,updated_at,seen_at) VALUES(?,?,?,?,?,?,?,?,?)').run(item.id,kind,item.date,JSON.stringify(item.data),item.digest,decision,stamp,stamp,stamp);
  for(const alias of item.data.discovery.aliases){sql.prepare('INSERT OR IGNORE INTO discovery_aliases(alias,item_id) VALUES(?,?)').run(alias,item.id);if(isExcluded)putDecision.run(alias,item.id,kind,item.date,'EXCLUDE',stamp);}
  if(isExcluded)excluded++;else if(kind==='event')candidates++;else corrections++;
}
const reservations=state.daily_discovery?.actorBudgetReservations||[];
for(const [index,run] of (state.run_history||[]).entries()){
  const id=String(run.cycle_id||run.review_asof||run.started_at||'legacy-'+index),budget=run.budget||{},reservation=reservations.find(r=>r.cycle_id===id),day=budget.philadelphia_date||reservation?.date||String(run.started_at||run.review_asof||stamp).slice(0,10);
  const summary=Object.fromEntries(['run_ids','dataset_id','kv_id','started_at','collection_finished_at','review_completed_at','counts','coverage','media_coverage','collection_summary','budget','delivery_reference'].filter(k=>k in run).map(k=>[k,run[k]]));
  sql.prepare('INSERT OR REPLACE INTO discovery_runs(id,day,status,reserved_usd,actual_usd,data,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,day,run.status||'legacy',Number(budget.reserved_usd||reservation?.reserved_usd||0),run.actual_actor_charge_usd??reservation?.actual_charge_usd??null,JSON.stringify(redact(summary)),run.review_completed_at||run.review_asof||run.started_at||stamp);
}
for(const r of reservations){if(sql.prepare('SELECT id FROM discovery_runs WHERE id=?').get(r.cycle_id))continue;sql.prepare('INSERT INTO discovery_runs(id,day,status,reserved_usd,actual_usd,data,updated_at) VALUES(?,?,?,?,?,?,?)').run(r.cycle_id,r.date,r.status,r.reserved_usd,r.actual_charge_usd??null,JSON.stringify(redact(r)),r.completed_at||r.reserved_at||stamp);}
// Retain supplementary audit metadata in bounded records, off the hot read path.
insertMeta.run('legacy-backup',JSON.stringify({libraryFileId:'libfile_9e81ca4b42488191a688ff0435ff6079',version:60,
  note:'Full historical captions, previous deliveries, per-profile history, and original credentials remain in the private legacy checkpoint. Live screening markers and unresolved proposals are migrated individually.'}),stamp);
await fs.mkdir(output,{recursive:true});const tables=['discovery_meta','discovery_posts','discovery_runs','discovery_items','discovery_aliases','discovery_decisions'];
let chunks=[],chunk=[],size=0,rows=0;
for(const table of tables){for(const row of sql.prepare('SELECT * FROM '+table).all()){
  const entry={sql:'INSERT OR IGNORE INTO '+table+'('+Object.keys(row).join(',')+') VALUES('+Object.keys(row).map(()=>'?').join(',')+')',params:Object.values(row)};
  const bytes=JSON.stringify(entry).length;
  if((size+bytes>180000||chunk.length>=300)&&chunk.length){chunks.push(chunk);chunk=[];size=0;}chunk.push(entry);size+=bytes;rows++;
}}if(chunk.length)chunks.push(chunk);
for(let i=0;i<chunks.length;i++)await fs.writeFile(output+'/'+String(i).padStart(3,'0')+'.json',JSON.stringify({batch:chunks[i]}));
const summary={chunks:chunks.length,rows,screenedPosts:sql.prepare('SELECT COUNT(*) AS count FROM discovery_posts').get().count,candidates,corrections,excluded};
await fs.writeFile(output+'/summary.json',JSON.stringify(summary));console.log(JSON.stringify(summary));
