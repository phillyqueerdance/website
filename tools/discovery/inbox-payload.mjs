import {fieldsFor} from './daily-review.mjs';
import {discoveryIdentity} from '../../shared/discovery-identity.js';
import {suggestedCorrectionTimes} from '../../admin/apify-correction-times.js';
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export async function candidateItem(candidate){
  const fields=fieldsFor(candidate);
  if(/\b(?:NOTO|The Ave(?: Live)?)\b/i.test(fields.Location||''))return null;
  const date=fields.StartDate||'';
  const discovery=candidate.discovery || (date?await discoveryIdentity(fields):undefined);
  return {kind:'event',date,fields,discovery,title:fields['Title (internal)'],note:candidate.notes||fields.Review_notes||'',
    readiness:candidate.readiness||candidate['Import readiness']||'',sourceUrl:fields.Instagram_URL||fields.Event_URL||''};
}
export async function correctionItem(original,snapshot={events:[]}){
  const row={...original};row.Date||=row.date||'';row['Current title']||=row.title||'';row.Venue||=row.venue||'';
  row.Correction||=row.correction||'';row['Instagram source']||=row.source_url||'';row['Public listing']||=row.public_url||row.eventUrl||'';
  row['Suggested Description']||=row.suggestedDescription||'';row.RawFlyerURL||=row.flyer_url||'';
  let eventId=row.eventId||'';try{eventId||=new URL(row['Public listing']).searchParams.get('event')||'';}catch{}
  const current=snapshot.events?.find(e=>e.eventId.toUpperCase()===eventId.toUpperCase());
  const changes={...row.changes};
  if(row['Suggested Description'])changes.description=row['Suggested Description'];
  const lineup=row['Suggested Lineup_Raw'] || /(?:^|\n)Proposed lineup:\s*([^\n]+)/i.exec(row.Correction)?.[1];
  if(lineup)changes.lineup=lineup;
  if(row.RawFlyerURL&&/flyer|poster|artwork|image/i.test(row.Correction))changes.flyer=row.RawFlyerURL;
  Object.assign(changes,suggestedCorrectionTimes(row,{start:current?.fields.start||row.Date+'T00:00',end:current?.fields.end||row.Date+'T00:00'}));
  const fields={'Title (internal)':row['Current title'],StartDate:row.Date,Location:row.Venue,Instagram_URL:row['Instagram source']};
  // Preserve the proposal identity used by previous workbooks and receipts.
  const proposal=JSON.stringify([row.Correction,row['Suggested Description'],row['Suggested StartDate']||'',row['Suggested StartTime']||'',row['Suggested EndDate']||'',row['Suggested EndTime']||'','']);
  const discovery=row.discovery || await discoveryIdentity(fields,'correction',proposal);
  return {kind:'correction',date:row.Date,fields,changes,discovery,eventId,title:row['Current title'],note:row.Correction,
    sourceUrl:row['Instagram source'],listingUrl:row['Public listing'],baseline:current||null};
}
export async function inboxPayload(review,snapshot){
  const items=[];for(const candidate of review.candidates||[]){const item=await candidateItem(candidate);if(item)items.push(item);}
  for(const correction of review.corrections||[])items.push(await correctionItem(correction,snapshot));
  return {items};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,arg,i,all)=>arg.startsWith('--')?[...pairs,[arg.slice(2),all[i+1]]]:pairs,[]));
  const review=JSON.parse(await fs.readFile(args.review,'utf8')),snapshot=args.snapshot?JSON.parse(await fs.readFile(args.snapshot,'utf8')):undefined;
  await fs.writeFile(args.output,JSON.stringify(await inboxPayload(review,snapshot)));
}
