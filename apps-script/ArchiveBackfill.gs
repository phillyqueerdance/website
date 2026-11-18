/**
 * QDP archive backfill v1.0.1. Requires Core v7.4.26, ArchiveReview v7.4.25,
 * PublicData v7.4.22+, and the existing QDP_Apify_Import / scraper helpers.
 * Source collection never writes an event. Apply is an explicit Admin action.
 */
const QDP_BACKFILL_ = Object.freeze({
  posts: ['PostKey','Accounts','PostedAt','Instagram_URL','Caption','MediaJSON','RawFileId','FirstSeen','LastSeen'],
  review: ['CandidateKey','RunID','PostKeysJSON','FactsJSON','EvidenceJSON','ReviewState','TargetSheet','TargetEventID','SelectedFieldsJSON','DraftDescription','VisualJSON','UpdatedAt','Result','IndexSignature'],
  history: ['UpdateKey','CandidateKey','EventID','Sheet','BeforeJSON','AfterJSON','PreviousRevision','At'],
  runs: ['RunID','CoverageJSON','UpdatedAt'],
  names: {posts:'Backfill_Posts',review:'Backfill_Review',history:'Backfill_History',runs:'Backfill_Runs'},
  folder: 'QDP_BACKFILL_SOURCE_FOLDER_ID', year: 2025,
  editable: ['Title (internal)','StartDate','EndDate','StartTime','EndTime','Timezone','ExplicitQueer (Yes/No)',
    'VenueID','ArtistIDs (comma-separated)','PartyID','HostCollectiveIDs (comma-separated)',
    'Description','Event_URL','Instagram_URL','RawFlyerURL','Flyer_URL']
});

function qdpBackfillTable_(kind,create=true) {
  const ss=ss_(), headers=QDP_BACKFILL_[kind], name=QDP_BACKFILL_.names[kind];
  let sheet=ss.getSheetByName(name);
  if(!sheet&&!create)return {ss,sheet:null,headers,rows:[]};
  if(!sheet) {sheet=ss.insertSheet(name);sheet.getRange(1,1,1,headers.length).setValues([headers]);sheet.setFrozenRows(1);}
  const values=sheet.getDataRange().getValues();
  if(headers.some((h,i)=>values[0][i]!==h)) throw new Error(name+' headers changed. Restore the named backfill headers before continuing.');
  return {ss,sheet,headers,rows:values.slice(1)};
}
function qdpBackfillString_(value,max=40000) {
  if(typeof value!=='string'||value.length>max) throw new Error('Invalid or excessive backfill text.');
  return value;
}
function qdpBackfillJSON_(value,max=45000) {
  const text=JSON.stringify(value);qdpBackfillString_(text,max);return text;
}
function qdpBackfillParse_(text,fallback) {try{return JSON.parse(text);}catch(e){return fallback;}}
function qdpBackfillRevision_(row) {return qdpArchiveDigest_(JSON.stringify(row));}
function qdpBackfillAppend_(table,rows) {
  if(!rows.length)return null;
  return {appendCells:{sheetId:table.sheet.getSheetId(),rows:rows.map(row=>({values:row.map(v=>({userEnteredValue:{stringValue:String(v==null?'':v)}}))})),fields:'userEnteredValue'}};
}
function qdpBackfillCommit_(ss,cells,requests=[]) {
  if(typeof Sheets==='undefined')throw new Error('Enable Google Sheets API in Apps Script Services.');
  const all=qdpCellRequests_(cells).concat(requests.filter(Boolean));
  if(all.length)Sheets.Spreadsheets.batchUpdate({requests:all},ss.getId());
}
function qdpBackfillRowCells_(table,index,row) {return row.map((value,column)=>({sheet:table.sheet,row:index+2,column:column+1,value}));}
function qdpBackfillFolder_() {
  const props=PropertiesService.getScriptProperties(),id=props.getProperty(QDP_BACKFILL_.folder);
  if(id)return DriveApp.getFolderById(id);
  const folder=DriveApp.createFolder('QDP Instagram backfill source records');
  props.setProperty(QDP_BACKFILL_.folder,folder.getId());return folder;
}
function qdpBackfillPostKey_(post) {
  const id=String(post.pk||post.id||'').split('_')[0];
  if(!/^\d{5,30}$/.test(id))throw new Error('A source post needs its stable Instagram media ID.');
  return 'ig:'+id;
}
function qdpBackfillMedia_(post) {
  return (post.carousel_media&&post.carousel_media.length?post.carousel_media:[post]).map((m,i)=>({
    id:String(m.pk||m.id||post.pk).split('_')[0],order:i+1,url:String(m.image_url||''),
    type:Number(m.media_type||1),videoUrl:String(m.video_url||''),savedUrl:'',status:'pending'
  })).filter(m=>m.url);
}

// Idempotent batches; repeat imports keep saved decisions and downloaded media.
function qdpBackfillIngest_(body) {
  const runId=qdpBackfillString_(body.runId,150),now=new Date().toISOString();
  if(!runId)throw new Error('A backfill run ID is required.');
  const posts=body.posts||[],candidates=body.candidates||[];
  if(!Array.isArray(posts)||posts.length>20||!Array.isArray(candidates)||candidates.length>50)throw new Error('Import up to 20 source posts or 50 candidates per batch.');
  const source=qdpBackfillTable_('posts'),review=qdpBackfillTable_('review'),runs=qdpBackfillTable_('runs');
  const known=new Map(source.rows.map((r,i)=>[r[0],i])),seen=new Set(review.rows.map(r=>r[0]));
  const additions=[],updates=[],newPosts=[],newReviews=[];
  for(const post of posts) {
    const key=qdpBackfillPostKey_(post),account=String(post.scraped_username||post.user&&post.user.username||'');
    qdpBackfillJSON_(post,250000);
    if(known.has(key)) {
      const index=known.get(key),existing=index<source.rows.length,original=existing?source.rows[index]:additions[index-source.rows.length],row=original.slice(),accounts=new Set(String(row[1]).split(',').filter(Boolean));
      accounts.add(account);row[1]=[...accounts].join(',');row[8]=now;
      if(existing)updates.push(...qdpBackfillRowCells_(source,index,row));else additions[index-source.rows.length]=row;continue;
    }
    const caption=post.caption&&post.caption.text||'';qdpBackfillString_(caption);
    const postedAt=new Date(Number(post.taken_at)*1000).toISOString();
    const media=qdpBackfillMedia_(post);
    media.forEach(asset=>{
      const metadata=body.assetMetadata&&body.assetMetadata[key+':'+asset.id];
      if(metadata&&/^[a-f0-9]{64}$/.test(String(metadata.sha256||''))){asset.sha256=metadata.sha256;asset.originalFile=String(metadata.file||'').slice(0,200);}
    });
    const row=[key,account,postedAt,String(post.post_url||''),caption,qdpBackfillJSON_(media),'',now,now];
    known.set(key,source.rows.length+additions.length);additions.push(row);newPosts.push(post);
  }
  // Preserve the exact scraper records outside Sheets' per-cell text limit.
  if(newPosts.length) {
    const file=qdpBackfillFolder_().createFile('instagram-'+runId+'-'+Utilities.getUuid()+'.json',JSON.stringify(newPosts),'application/json');
    additions.forEach(row=>row[6]=file.getId());
  }
  for(const candidate of candidates) {
    const key=qdpBackfillString_(candidate.key,180);
    if(!/^[a-zA-Z0-9:_-]{3,180}$/.test(key))throw new Error('Invalid candidate identity.');
    if(seen.has(key))continue;
    const postKeys=candidate.postKeys;
    if(!Array.isArray(postKeys)||!postKeys.length||postKeys.length>100||postKeys.some(k=>!known.has(k)))throw new Error('Import the supporting source posts before their event candidates.');
    const facts=candidate.fields||{};
    if(!facts||typeof facts!=='object'||Array.isArray(facts))throw new Error('Candidate fields must be named values.');
    for(const [name,value] of Object.entries(facts))qdpBackfillString_(value);
    if(String(facts.Description||'').trim())throw new Error('Initial backfill candidates must leave Description blank. Request a description after selecting the event.');
    const date=facts.StartDate||'';
    if(date&&(!/^2025-\d{2}-\d{2}$/.test(date)||isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date))throw new Error('This pilot accepts event dates in 2025; uncertain dates can stay blank.');
    seen.add(key);newReviews.push([key,runId,qdpBackfillJSON_(postKeys),qdpBackfillJSON_(facts),qdpBackfillJSON_(candidate.evidence||{}),
      'pending','','','[]','',qdpBackfillJSON_(candidate.visual||{status:'pending'}),now,'','']);
  }
  const requests=[qdpBackfillAppend_(source,additions),qdpBackfillAppend_(review,newReviews)];
  if(body.coverage) {
    const json=qdpBackfillJSON_(body.coverage),index=runs.rows.findIndex(r=>r[0]===runId),row=[runId,json,now];
    if(index<0)requests.push(qdpBackfillAppend_(runs,[row]));else updates.push(...qdpBackfillRowCells_(runs,index,row));
  }
  qdpBackfillCommit_(source.ss,updates,requests);
  return {addedPosts:additions.length,addedCandidates:newReviews.length};
}

function qdpBackfillCatalog_(ss) {
  const out=[];out.byDate=new Map();out.bySource=new Map();
  for(const name of qdpArchiveSheets_(ss,false)) {
    // Matching is read-only. The event editor's source loader initializes
    // QDP_EditState and can need the shared save lock even during a page load.
    const sheet=ss.getSheetByName(name),rows=sheet.getDataRange().getValues();
    const layout=qdpArchiveLayout_(sheet,rows[0]),c=layout.columns;
    rows.slice(1).forEach((row,index)=>{
      const date=qdpArchiveAdminDate_(row[c.start-1]);if(!date.startsWith('2025-'))return;
      const id=String(row[c.eventId-1]||'').trim();if(!id)return;
      const item={sheet:name,eventId:id,date,title:String(row[c.title-1]||''),venueId:String(row[c.venue-1]||''),
        artistIds:qdpArchiveIds_(row[c.artists-1]),partyId:String(row[c.party-1]||''),
        text:row.map(v=>String(v==null?'':v)).join('\n'),row,index:index+2,layout};
      out.push(item);if(!out.byDate.has(date))out.byDate.set(date,[]);out.byDate.get(date).push(item);
      for(const match of item.text.matchAll(/https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/([A-Za-z0-9_-]+)/g)) {
        if(!out.bySource.has(match[1]))out.bySource.set(match[1],[]);out.bySource.get(match[1]).push(item);
      }
    });
  }
  return out;
}
function qdpBackfillMatches_(facts,sources,catalog,lookups) {
  const norm=qdpArchiveNormalize_,title=norm(facts['Title (internal)']||''),date=facts.StartDate||'';
  const text=[facts['Title (internal)'],facts.Lineup_Raw,facts.Location].filter(Boolean).join('\n');
  const venues=facts.VenueID?[facts.VenueID]:qdpArchiveMatches_(facts.Location||text,lookups.venue).map(m=>m.id);
  const artists=qdpArchiveIds_(facts['ArtistIDs (comma-separated)']||'').concat(qdpArchiveMatches_(facts.Lineup_Raw||'',lookups.artists).map(m=>m.id));
  const urls=sources.map(p=>p[3]).filter(Boolean),linked=new Set();
  urls.forEach(url=>{const code=String(url).match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);if(code)(catalog.bySource.get(code[1])||[]).forEach(event=>linked.add(event));});
  const pool=[...new Set([...(catalog.byDate.get(date)||[]),...linked])];
  return pool.map(event=>{
    let score=0;const reasons=[],conflicts=[];
    const sourceMatch=linked.has(event);
    if(sourceMatch){score+=120;reasons.push('Same Instagram source link');}
    if(date===event.date){score+=40;reasons.push('Same event date');}
    else if(date){if(!sourceMatch)return null;conflicts.push('Event dates differ');score-=30;}
    if(venues.includes(event.venueId)){score+=30;reasons.push('Same venue');}
    else if(venues.length&&event.venueId){conflicts.push('Venues differ');score-=25;}
    const overlap=[...new Set(artists.filter(id=>event.artistIds.includes(id)))];
    if(overlap.length){score+=Math.min(30,overlap.length*10);reasons.push(overlap.length+' lineup name'+(overlap.length===1?'':'s')+' overlap');}
    if(title&&title===norm(event.title)){score+=35;reasons.push('Same event title');}
    else if(title&&title.length>5&&norm(event.title).includes(title)){score+=15;reasons.push('Similar event title');}
    if(!sourceMatch&&(!date||date!==event.date||score<65))return null;
    return {sheet:event.sheet,eventId:event.eventId,title:event.title,date:event.date,venueId:event.venueId,score,reasons,conflicts};
  }).filter(Boolean).sort((a,b)=>b.score-a.score||a.eventId.localeCompare(b.eventId)).slice(0,5);
}
function qdpBackfillReview_(body) {
  const table=qdpBackfillTable_('review'),index=table.rows.findIndex(r=>r[0]===body.key);
  if(index<0)throw new Error('This backfill candidate is no longer available.');
  const row=table.rows[index];
  if(body.expectedRevision!==qdpBackfillRevision_(row))throw new Error('This review changed. Reload it before saving.');
  return {table,index,row};
}
function qdpBackfillPublicReview_(row,sourceByKey,catalog,lookups) {
  const fields=qdpBackfillParse_(row[3],{}),postKeys=qdpBackfillParse_(row[2],[]);
  const sources=postKeys.map(key=>sourceByKey.get(key)).filter(Boolean);
  const result={key:row[0],runId:row[1],indexSignature:lookups.signature,fields,evidence:qdpBackfillParse_(row[4],{}),state:row[5],
    targetSheet:row[6],targetEventId:row[7],selectedFields:qdpBackfillParse_(row[8],[]),draftDescription:row[9],
    visual:qdpBackfillParse_(row[10],{}),revision:qdpBackfillRevision_(row),result:row[12],
    sources:sources.map(p=>({key:p[0],account:p[1],postedAt:p[2],url:p[3],caption:p[4],media:qdpBackfillParse_(p[5],[])}))};
  result.matches=qdpBackfillMatches_(fields,sources,catalog,lookups);
  if(row[6]&&row[7]) {
    try {result.target=qdpArchiveAdminEventRecord_(qdpArchiveAdminCachedTarget_(ss_(),row[6],row[7]));}
    catch(error){result.targetIssue=String(error.message||error);}
  }
  return result;
}
function qdpBackfillPage_(body) {
  const review=qdpBackfillTable_('review',false),posts=qdpBackfillTable_('posts',false),runs=qdpBackfillTable_('runs',false);
  const sourceByKey=new Map(posts.rows.map(row=>[row[0],row]));
  const query=qdpArchiveAdminSearchNormalize_(String(body.query||'')),state=String(body.state||'');
  let rows=review.rows.filter(row=>(!state||row[5]===state)&&(!query||qdpArchiveAdminSearchNormalize_(row.slice(0,11).join('\n')+'\n'+qdpBackfillParse_(row[2],[]).map(k=>sourceByKey.get(k)||[]).join('\n')).includes(query)));
  const catalog=rows.length?qdpBackfillCatalog_(review.ss):null,lookups=rows.length?qdpArchiveLookups_(review.ss):null;
  const queue=String(body.queue||'');
  if(queue==='matches'||queue==='unmatched')rows=rows.filter(row=>{
    const matched=!!row[7]||qdpBackfillMatches_(qdpBackfillParse_(row[3],{}),qdpBackfillParse_(row[2],[]).map(k=>sourceByKey.get(k)).filter(Boolean),catalog,lookups).length>0;
    return queue==='matches'?matched:!matched;
  });
  const pageSize=10,requestedOffset=Math.max(0,Math.floor(Number(body.offset)||0)),offset=Math.min(requestedOffset,Math.max(0,Math.floor((rows.length-1)/pageSize)*pageSize));
  const items=rows.slice(offset,offset+pageSize).map(row=>qdpBackfillPublicReview_(row,sourceByKey,catalog,lookups));
  const summary={};review.rows.forEach(row=>summary[row[5]]=(summary[row[5]]||0)+1);
  return {items,total:rows.length,offset,pageSize,summary,sourceCount:posts.rows.length,
    runs:runs.rows.map(row=>({id:row[0],coverage:qdpBackfillParse_(row[1],{})})),
    needsPublish:!!qdpArchiveAdminRead_(QDP_ARCHIVE_ADMIN_.dirtyKey),descriptionRequests:review.rows.filter(r=>r[5]==='confirmed'&&qdpBackfillParse_(r[8],[]).includes('Description')&&!r[9]).length};
}
function qdpBackfillSave_(body) {
  const current=qdpBackfillReview_(body),row=current.row.slice();
  if(row[5]==='applied')throw new Error('This candidate has already been applied. Keep its audit record and make further edits in Archive Updates.');
  if(!['pending','confirmed','deferred','rejected'].includes(body.state))throw new Error('Choose a review decision.');
  const selected=body.selectedFields||[];
  if(!Array.isArray(selected)||selected.some(k=>!QDP_BACKFILL_.editable.includes(k)))throw new Error('Choose supported event fields.');
  if(body.state==='confirmed') {
    const lookups=qdpArchiveLookups_(current.table.ss);
    if(body.expectedIndexSignature!==lookups.signature)throw new Error('The Index changed since this review opened. Reload it and check the match and selected fields again.');
    row[13]=lookups.signature;
    const target=qdpArchiveAdminEventTarget_({sheet:body.targetSheet,eventId:body.targetEventId});
    if(target.layout.name===CONFIG.SHEET_EVENTS||!qdpArchiveAdminDate_(target.row[target.layout.columns.start-1]).startsWith('2025-'))throw new Error('Choose an archived 2025 event.');
    row[6]=target.layout.name;row[7]=target.eventId;
  }
  const draft=qdpBackfillString_(body.draftDescription||'');
  if(draft&&!selected.includes('Description'))throw new Error('Select Update description before storing a draft.');
  if(draft&&typeof qdpScanDescriptionHasLink_==='function'&&qdpScanDescriptionHasLink_(draft))throw new Error('Keep source links outside the event description.');
  const proposed=body.fields||{},facts=qdpBackfillParse_(row[3],{});
  if(typeof proposed!=='object'||Array.isArray(proposed)||Object.keys(proposed).some(key=>!QDP_BACKFILL_.editable.includes(key)))throw new Error('Save supported proposal fields only.');
  for(const [key,value] of Object.entries(proposed)){qdpBackfillString_(value);if(key!=='Description')facts[key]=value;}
  row[3]=qdpBackfillJSON_(facts);
  row[5]=body.state;row[8]=JSON.stringify([...new Set(selected)]);row[9]=draft;row[11]=new Date().toISOString();row[12]='';
  qdpBackfillCommit_(current.table.ss,qdpBackfillRowCells_(current.table,current.index,row));
  return {key:row[0],revision:qdpBackfillRevision_(row)};
}

function qdpBackfillMediaSave_(body) {
  const table=qdpBackfillTable_('posts'),index=table.rows.findIndex(r=>r[0]===body.postKey);
  if(index<0)throw new Error('Choose an imported source post.');
  const row=table.rows[index].slice(),media=qdpBackfillParse_(row[5],[]),asset=media.find(m=>m.id===String(body.mediaId));
  if(!asset)throw new Error('Choose an image from this source post.');
  if(asset.savedUrl)return {url:asset.savedUrl,alreadySaved:true};
  if(typeof qdpScanSaveImage_!=='function'||typeof qdpScanFolder_!=='function')throw new Error('Install the existing Apify flyer downloader first.');
  try {
    const label='QDP backfill '+String(body.postKey).replace(':','-')+' '+asset.id;
    const file=body.imageBase64?qdpBackfillStoreBytes_(qdpScanFolder_(),body.imageBase64,label,asset.sha256):qdpScanSaveImage_(qdpScanFolder_(),asset.url,label);
    asset.savedUrl=file.url;asset.status='saved';asset.savedAt=new Date().toISOString();delete asset.error;
    row[5]=JSON.stringify(media);qdpBackfillCommit_(table.ss,qdpBackfillRowCells_(table,index,row));return {url:file.url};
  } catch(error) {
    asset.status='failed';asset.error=String(error.message||error).slice(0,500);row[5]=JSON.stringify(media);
    qdpBackfillCommit_(table.ss,qdpBackfillRowCells_(table,index,row));throw error;
  }
}
function qdpBackfillApply_(body) {
  qdpArchiveAdminReady_();qdpArchiveAdminCheckEventSave_();
  if(typeof qdpPublicPublishSaved_!=='function')throw new Error('Install the current PublicData.gs before saving held archive changes.');
  const current=qdpBackfillReview_(body),reviewRow=current.row.slice();
  if(reviewRow[5]!=='confirmed')throw new Error('Confirm the archive match before applying selected changes.');
  if(reviewRow[13]!==qdpArchiveLookups_(current.table.ss).signature)throw new Error('The Index changed after approval. Reload this review and confirm the choices again.');
  const selected=qdpBackfillParse_(reviewRow[8],[]);
  if(!selected.length)throw new Error('Choose and save the fields to update first.');
  const target=qdpArchiveAdminEventTarget_({sheet:reviewRow[6],eventId:reviewRow[7]});
  if(body.expectedTargetRevision!==target.revision)throw new Error('The archive event changed since review. Reload it before applying changes.');
  const fields=body.fields||{},keys=Object.keys(fields);
  if(keys.length!==selected.length||keys.some(k=>!selected.includes(k)))throw new Error('Apply exactly the fields selected in this saved review.');
  for(const key of selected) {
    qdpBackfillString_(fields[key]);
    if(!fields[key].trim())throw new Error('A blank proposal cannot clear an existing archive field: '+key);
    if(key==='Description'&&(!reviewRow[9]||fields[key]!==reviewRow[9]))throw new Error('Save the requested description draft before applying it.');
  }
  if(selected.includes('Flyer_URL')) {
    const posts=qdpBackfillTable_('posts'),allowed=new Set(qdpBackfillParse_(reviewRow[2],[]));
    const saved=posts.rows.filter(r=>allowed.has(r[0])).flatMap(r=>qdpBackfillParse_(r[5],[])).filter(m=>m.status==='saved').map(m=>m.savedUrl);
    if(!saved.includes(fields.Flyer_URL))throw new Error('Save and verify the selected source flyer before applying it.');
  }
  const plan=qdpArchiveAdminPrepareEvent_({expectedRevision:target.revision,fields},target);
  const latest=qdpArchiveAdminEventTarget_({sheet:reviewRow[6],eventId:reviewRow[7]});
  if(latest.revision!==target.revision)throw new Error('This archive event changed while saving. Reload and review it again.');
  const before={},after={};plan.updates.forEach((v,c)=>{before[target.layout.headers[c-1]]=target.row[c-1];after[target.layout.headers[c-1]]=v;});
  const history=qdpBackfillTable_('history'),now=new Date().toISOString();
  reviewRow[5]='applied';reviewRow[11]=now;reviewRow[12]='Saved '+plan.updates.size+' changed cells; publication is separate.';
  const cells=qdpBackfillRowCells_(current.table,current.index,reviewRow).concat([...plan.updates].map(([column,value])=>({sheet:target.sheet,row:latest.number,column,value})));
  if(plan.updates.size)qdpArchiveAdminMarkDirty_();
  qdpBackfillCommit_(target.ss,cells,[qdpBackfillAppend_(history,[[Utilities.getUuid(),reviewRow[0],target.eventId,target.layout.name,
    qdpBackfillJSON_(before),qdpBackfillJSON_(after),target.revision,now]])]);
  return {key:reviewRow[0],changedCells:plan.updates.size,needsPublish:!!plan.updates.size};
}
function qdpBackfillStoreBytes_(folder,base64,label,expectedHash) {
  qdpBackfillString_(base64,9*1024*1024);
  const bytes=Utilities.base64Decode(base64),b=bytes.slice(0,12).map(n=>n&255);
  if(!bytes.length||bytes.length>6*1024*1024)throw new Error('Choose a source image no larger than 6 MB.');
  let mime='',extension='';
  if(b[0]===255&&b[1]===216&&b[2]===255){mime='image/jpeg';extension='jpg';}
  else if(b.slice(0,8).join(',')==='137,80,78,71,13,10,26,10'){mime='image/png';extension='png';}
  else if(/^GIF8[79]a$/.test(String.fromCharCode.apply(null,b.slice(0,6)))){mime='image/gif';extension='gif';}
  else if(String.fromCharCode.apply(null,b.slice(0,4))==='RIFF'&&String.fromCharCode.apply(null,b.slice(8,12))==='WEBP'){mime='image/webp';extension='webp';}
  if(!mime)throw new Error('Choose an original JPEG, PNG, GIF or WebP source image.');
  const hash=qdpScanHash_(bytes);if(expectedHash&&hash!==expectedHash)throw new Error('This file does not match the downloaded original for this slide.');
  const name=label+'.'+extension,matches=folder.getFilesByName(name);let file;
  while(matches.hasNext()){const old=matches.next();if(qdpScanHash_(old.getBlob().getBytes())===hash){file=old;break;}}
  if(!file)file=folder.createFile(Utilities.newBlob(bytes,mime,name));
  if(qdpScanHash_(file.getBlob().getBytes())!==hash)throw new Error('Saved image verification failed. No flyer was selected.');
  const resourceKey=file.getResourceKey();return {url:'https://drive.google.com/uc?export=view&id='+file.getId()+(resourceKey?'&resourcekey='+encodeURIComponent(resourceKey):'')};
}
function qdpBackfillDescriptionRequests_() {
  const review=qdpBackfillTable_('review'),posts=qdpBackfillTable_('posts'),source=new Map(posts.rows.map(r=>[r[0],r]));
  return {requests:review.rows.filter(r=>r[5]==='confirmed'&&qdpBackfillParse_(r[8],[]).includes('Description')&&!r[9]).map(r=>({
    key:r[0],expectedRevision:qdpBackfillRevision_(r),targetSheet:r[6],targetEventId:r[7],fields:qdpBackfillParse_(r[3],{}),
    evidence:qdpBackfillParse_(r[4],{}),visual:qdpBackfillParse_(r[10],{}),
    sources:qdpBackfillParse_(r[2],[]).map(k=>source.get(k)).filter(Boolean).map(p=>({key:p[0],url:p[3],caption:p[4],media:qdpBackfillParse_(p[5],[])}))
  }))};
}
function qdpBackfillDraft_(body) {
  const current=qdpBackfillReview_(body),row=current.row.slice();
  if(row[5]!=='confirmed'||!qdpBackfillParse_(row[8],[]).includes('Description'))throw new Error('This event has no confirmed request to update its description.');
  const draft=qdpBackfillString_(body.description||'');if(!draft.trim())throw new Error('Supply a description draft.');
  if(typeof qdpScanDescriptionHasLink_==='function'&&qdpScanDescriptionHasLink_(draft))throw new Error('Keep links outside the public description.');
  row[9]=draft;row[11]=new Date().toISOString();qdpBackfillCommit_(current.table.ss,qdpBackfillRowCells_(current.table,current.index,row));
  return {key:row[0],revision:qdpBackfillRevision_(row)};
}
function qdpAdminBackfill_(body) {
  QDP_ARCHIVE_REQUEST_=null;
  const action=String(body.action||'').toLowerCase();
  if(action==='admin.backfill.bootstrap')return qdpBackfillPage_(body);
  if(action==='admin.backfill.requests')return qdpBackfillDescriptionRequests_();
  return qdpArchiveWithLock_(()=>{
    if(action==='admin.backfill.ingest')return qdpBackfillIngest_(body);
    if(action==='admin.backfill.save')return qdpBackfillSave_(body);
    if(action==='admin.backfill.media')return qdpBackfillMediaSave_(body);
    if(action==='admin.backfill.apply')return qdpBackfillApply_(body);
    if(action==='admin.backfill.draft')return qdpBackfillDraft_(body);
    throw new Error('Unknown archive backfill action.');
  });
}
