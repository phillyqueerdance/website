// Reuse the existing import and identity format, including correction proposal IDs.
import fs from 'node:fs/promises';
import {candidateItem,correctionItem} from './inbox-payload.mjs';
import {normalized,digest} from '../../shared/discovery-identity.js';

export function canonicalVenue(location, id, references={}) {
  if(id) return id.toUpperCase();
  const key=normalized(location),matches=new Set();
  for(const venue of references.venues||[]) if(normalized(venue.name)===key || normalized(venue.address)===key)matches.add(venue.id);
  for(const alias of references.venueAliases||[]) if(normalized(alias.key)===key)matches.add(alias.id);
  return matches.size===1?[...matches][0]:key;
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
  return payload;
}
if(process.argv[1] && new URL(import.meta.url).pathname===process.argv[1]) {
  const [reviewFile,snapshotFile,output]=process.argv.slice(2);
  const payload=await pipelinePayload(JSON.parse(await fs.readFile(reviewFile,'utf8')),JSON.parse(await fs.readFile(snapshotFile,'utf8')));
  await fs.writeFile(output,JSON.stringify(payload));
}
