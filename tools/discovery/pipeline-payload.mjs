// Reuse the existing import and identity format, including correction proposal IDs.
import fs from 'node:fs/promises';
import {candidateItem,correctionItem} from './inbox-payload.mjs';
import {normalized,digest,discoveryIdentity} from '../../shared/discovery-identity.js';

export function canonicalVenue(location, id, references={}) {
  if(id) return id.toUpperCase();
  const key=normalized(location),matches=new Set();
  for(const venue of references.venues||[]) if(normalized(venue.name)===key || normalized(venue.address)===key)matches.add(venue.id);
  for(const alias of references.venueAliases||[]) if(normalized(alias.key)===key)matches.add(alias.id);
  return matches.size===1?[...matches][0]:key;
}
export async function recoveryPayload(review,snapshot) {
  const items=[],issues=[];
  for(const selection of (review.flyers||[]).filter(s=>s.recoveryId)) {
    const job=(review.flyerRecoveryJobs||[]).find(job=>job.id===selection.recoveryId);
    if(!job||!Array.isArray(selection.targetIds)||!selection.targetIds.length)throw new Error('Choose an existing recovery job and target IDs.');
    for(const id of [...new Set(selection.targetIds)]) {
      if(!job.items.some(item=>item.id===id))throw new Error('Unrelated flyer recovery target.');
      const current=(snapshot.items||[]).find(item=>item.id===id);
      if(!current||current.decision==='EXCLUDE'||current.status==='importing'||current.status==='accepted')continue;
      if(String(current.fields.Flyer_URL||'').trim())continue;
      let eventId=current.result?.eventId||current.eventId||'';
      let baseline=(snapshot.events||[]).find(event=>event.eventId.toUpperCase()===eventId.toUpperCase());
      if(!baseline) {
        const venue=canonicalVenue(current.fields.Location,current.fields.VenueID,snapshot.references);
        const matches=(snapshot.events||[]).filter(event=>event.fields?.start &&
          new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(event.fields.start))===(current.fields.StartDate||current.date) &&
          normalized(event.title)===normalized(current.fields['Title (internal)']) && venue===canonicalVenue(event.location,event.venueId,snapshot.references));
        if(matches.length>1){issues.push({id,error:'Multiple existing editions match this recovery; retain the lead for interpretation.'});continue;}
        baseline=matches[0];eventId=baseline?.eventId||eventId;
      }
      if(baseline?.fields.flyer)continue;
      const common={fields:{...current.fields},date:current.fields.StartDate||current.date,title:current.title,
        sourceUrl:current.sourceUrl||job.sourceUrl,note:current.note,readiness:current.readiness,
        _review:{kind:'recovery',recoveryId:job.id,index:id}};
      if(eventId) {
        if(!baseline){issues.push({id,error:'An imported event needs its current EventID baseline before proposing recovered artwork.'});continue;}
        if(!common.date)common.date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(baseline.fields.start));
        const fields={...common.fields,StartDate:common.date,Instagram_URL:job.sourceUrl};
        const discovery=await discoveryIdentity(fields,'correction','flyer-recovery|'+eventId+'|'+selection.visualId);
        items.push({...common,fields,kind:'correction',eventId,baseline,changes:{flyer:''},discovery,listingUrl:current.listingUrl||'https://queerdancephilly.com/?event='+encodeURIComponent(eventId)});
      } else if(!['ready','imported','existing'].includes(current.status)) {
        items.push({...common,kind:'event',...(common.date?{discovery:{...current.discovery,date:common.date}}:{_preservationId:current.id}),changes:current.changes||{}});
      }
    }
  }
  return {items,issues};
}

export async function pipelinePayload(review,snapshot) {
  const payload={items:[]};
  for(const [index,candidate] of (review.candidates||[]).entries()) {
    const item=await candidateItem(candidate);if(!item)continue;
    item._review={kind:'candidate',index};
    if(!item.discovery)item._preservationId=await digest('undated|'+JSON.stringify([item.fields['Title (internal)'],item.fields.Location,item.fields.Event_URL]));
    payload.items.push(item);
  }
  for(const [index,correction] of (review.corrections||[]).entries())payload.items.push({...await correctionItem(correction,snapshot),_review:{kind:'correction',index}});
  for(const item of payload.items) {
    if(item.kind==='correction') {
      if(!item.baseline) throw new Error('Correction needs a fresh existing EventID baseline.');
      continue;
    }
    const venue=canonicalVenue(item.fields.Location,item.fields.VenueID,snapshot.references);
    const known=(snapshot.events||[]).filter(existing=>existing.eventId && item.date &&
      existing.fields?.start && new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(existing.fields.start))===item.date &&
      normalized(existing.title)===normalized(item.fields['Title (internal)']) && venue===canonicalVenue(existing.location,existing.venueId,snapshot.references));
    if(known.length)throw new Error('This edition already has an EventID. Keep only a supported correction for '+known.map(e=>e.eventId).join(', ')+'.');
    const matches=(snapshot.items||[]).filter(existing=>existing.kind==='event' && existing.date===item.date && (
      existing.discovery.aliases.some(alias=>item.discovery?.aliases.includes(alias)) ||
      (normalized(existing.fields['Title (internal)'])===normalized(item.fields['Title (internal)']) &&
       venue===canonicalVenue(existing.fields.Location,existing.fields.VenueID,snapshot.references))));
    if(matches.length>1) throw new Error('Multiple pending editions match. Resolve the identity before delivery.');
    if(matches.length===1) {
      const prior=matches[0].discovery;
      item.discovery={...prior,aliases:[...new Set([...prior.aliases,...(item.discovery?.aliases||[])])].slice(0,8)};
    }
  }
  const recovery=await recoveryPayload(review,snapshot);payload.items.push(...recovery.items);payload.recoveryIssues=recovery.issues;
  return payload;
}
if(process.argv[1] && new URL(import.meta.url).pathname===process.argv[1]) {
  const [reviewFile,snapshotFile,output]=process.argv.slice(2);
  const payload=await pipelinePayload(JSON.parse(await fs.readFile(reviewFile,'utf8')),JSON.parse(await fs.readFile(snapshotFile,'utf8')));
  await fs.writeFile(output,JSON.stringify(payload));
}
