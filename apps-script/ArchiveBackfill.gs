/**
 * QDP archive backfill v1.1.0. Requires Core v7.4.26, ArchiveReview v7.4.25,
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
  importRows: 500, importBytes: 6 * 1024 * 1024, saveRows: 24, saveFlyers: 8, workspaceRows: 500,
  editable: ['Title (internal)','StartDate','EndDate','StartTime','EndTime','Timezone','ExplicitQueer (Yes/No)',
    'VenueID','ArtistIDs (comma-separated)','PartyID','HostCollectiveIDs (comma-separated)',
    'Description','Event_URL','Instagram_URL','RawFlyerURL','Flyer_URL']
});

let QDP_BACKFILL_INDEX_;
function qdpBackfillTable_(kind,create=true,bodyColumns) {
  const ss=QDP_BACKFILL_INDEX_||(QDP_BACKFILL_INDEX_=ss_());
  const headers=QDP_BACKFILL_[kind], name=QDP_BACKFILL_.names[kind];
  let sheet=ss.getSheetByName(name);
  if(!sheet&&!create)return {ss,sheet:null,headers,rows:[]};
  if(!sheet) {sheet=ss.insertSheet(name);sheet.getRange(1,1,1,headers.length).setValues([headers]);sheet.setFrozenRows(1);}
  if(bodyColumns) {
    const header=sheet.getRange(1,1,1,headers.length).getValues()[0],count=sheet.getLastRow()-1;
    if(headers.some((h,i)=>header[i]!==h))throw new Error(name+' headers changed. Restore the named backfill headers before continuing.');
    return {ss,sheet,headers,rows:count>0?sheet.getRange(2,1,count,bodyColumns).getValues():[]};
  }
  const values=sheet.getDataRange().getValues();
  if(headers.some((h,i)=>values[0][i]!==h))throw new Error(name+' headers changed. Restore the named backfill headers before continuing.');
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
function qdpBackfillUpdateRow_(table,index,row) {
  return {updateCells:{start:{sheetId:table.sheet.getSheetId(),rowIndex:index+1,columnIndex:0},
    rows:[{values:row.map(value=>({userEnteredValue:{stringValue:String(value==null?'':value)}}))}],fields:'userEnteredValue'}};
}
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
  const limit=QDP_BACKFILL_.importRows;
  if(!Array.isArray(posts)||posts.length>limit||!Array.isArray(candidates)||candidates.length>limit)throw new Error('Import up to '+limit+' source posts or review proposals per batch.');
  const source=qdpBackfillTable_('posts',true,2);
  const review=candidates.length?qdpBackfillTable_('review',true,1):null;
  const runs=body.coverage?qdpBackfillTable_('runs'):null;
  const known=new Map(source.rows.map((r,i)=>[r[0],i])),seen=new Set((review?.rows||[]).map(r=>r[0]));
  const additions=[],updates=[],newPosts=[],newReviews=[];
  for(const post of posts) {
    const key=qdpBackfillPostKey_(post),account=String(post.scraped_username||post.user&&post.user.username||'');
    qdpBackfillJSON_(post,250000);
    if(known.has(key)) {
      const index=known.get(key),existing=index<source.rows.length;
      const row=existing?source.rows[index]:additions[index-source.rows.length];
      const accounts=new Set(String(row[1]).split(',').filter(Boolean));
      if(!account||accounts.has(account))continue;
      accounts.add(account);row[1]=[...accounts].join(',');
      if(existing)updates.push({sheet:source.sheet,row:index+2,column:2,value:row[1]},
        {sheet:source.sheet,row:index+2,column:9,value:now});
      else row[8]=now;
      continue;
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
  // Preserve the exact scraper records outside Sheets' per-cell text limit.
  if(newPosts.length) {
    const file=qdpBackfillFolder_().createFile('instagram-'+runId+'-'+Utilities.getUuid()+'.json',JSON.stringify(newPosts),'application/json');
    const fileId=file.getId();
    additions.forEach(row=>row[6]=fileId);
  }
  const requests=[qdpBackfillAppend_(source,additions),review&&qdpBackfillAppend_(review,newReviews)];
  if(runs) {
    const json=qdpBackfillJSON_(body.coverage),index=runs.rows.findIndex(r=>r[0]===runId),row=[runId,json,now];
    if(index<0)requests.push(qdpBackfillAppend_(runs,[row]));
    else if(runs.rows[index][1]!==json)requests.push(qdpBackfillUpdateRow_(runs,index,row));
  }
  qdpBackfillCommit_(source.ss,updates,requests);
  return {addedPosts:additions.length,addedCandidates:newReviews.length};
}

function qdpBackfillUnpackImport_(body) {
  if(body.gzip===undefined)return body;
  const payload=qdpBackfillString_(body.gzip,2*1024*1024);
  const bytes=Utilities.base64Decode(payload),end=bytes.length;
  if(end<18||(bytes[0]&255)!==31||(bytes[1]&255)!==139)throw new Error('Invalid compressed backfill batch.');
  const size=bytes.slice(-4).reduce((total,byte,i)=>total+(byte&255)*256**i,0);
  if(size>QDP_BACKFILL_.importBytes)throw new Error('The uncompressed backfill batch is too large.');
  const json=Utilities.ungzip(Utilities.newBlob(bytes,'application/gzip')).getDataAsString('UTF-8');
  if(json.length>QDP_BACKFILL_.importBytes)throw new Error('The uncompressed backfill batch is too large.');
  return JSON.parse(json);
}

function qdpBackfillCatalog_(ss,sourceNames=null) {
  const out=[];
  out.byDate=new Map();out.bySource=new Map();out.byKey=new Map();
  for(const name of qdpArchiveSheets_(ss,false)) {
    if(sourceNames&&!sourceNames.has(name))continue;
    // Matching is read-only. The event editor's source loader initializes
    // QDP_EditState and can need the shared save lock even during a page load.
    const sheet=ss.getSheetByName(name),range=sheet.getDataRange(),rows=range.getValues();
    const layout=qdpArchiveLayout_(sheet,rows[0]),c=layout.columns,source={ss,sheet,range,layout};
    rows.slice(1).forEach((row,index)=>{
      const id=String(row[c.eventId-1]||'').trim();if(!id)return;
      const date=qdpArchiveAdminDate_(row[c.start-1]),key=qdpArchiveAdminEventKey_(name,id);
      const item={sheet:name,eventId:id,date,title:String(row[c.title-1]||''),venueId:String(row[c.venue-1]||''),
        artistIds:qdpArchiveIds_(row[c.artists-1]),row,number:index+2,source};
      out.byKey.set(key,out.byKey.has(key)?null:item);
      if(!date.startsWith('2025-')||sourceNames)return;
      item.text=row.map(v=>String(v==null?'':v)).join('\n');
      out.push(item);if(!out.byDate.has(date))out.byDate.set(date,[]);out.byDate.get(date).push(item);
      for(const match of item.text.matchAll(/https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/([A-Za-z0-9_-]+)/g)) {
        if(!out.bySource.has(match[1]))out.bySource.set(match[1],[]);out.bySource.get(match[1]).push(item);
      }
    });
  }
  return out;
}

function qdpBackfillTarget_(catalog,sheet,eventId) {
  const event=catalog.byKey.get(qdpArchiveAdminEventKey_(sheet,eventId));
  if(!event||!event.date.startsWith('2025-'))throw new Error('Choose a unique archived 2025 event. The selected match may have moved or changed.');
  const {source,number}=event;
  if(!source.formulas)source.formulas=source.range.getFormulas();
  const target={ss:source.ss,sheet:source.sheet,layout:source.layout,eventId,number,
    row:event.row.slice(),formulas:source.formulas[number-1].slice()};
  // Preview a missing edit-state column without touching the spreadsheet. If
  // saved, Core creates the same column under its normal write lock.
  if(!target.layout.headers.includes('QDP_EditState')) {
    target.addEditState=true;
    target.layout={...target.layout,width:target.layout.width+1,headers:[...target.layout.headers,'QDP_EditState']};
    target.row.push('');target.formulas.push('');
  }
  target.revision=qdpArchiveAdminEventRevision_(target);
  return target;
}

const QDP_BACKFILL_FIELD_LABELS_ = Object.freeze({
  'Title (internal)':'Title',StartDate:'Start date',EndDate:'End date',StartTime:'Start time',EndTime:'End time',
  Timezone:'Time zone','ExplicitQueer (Yes/No)':'Explicitly queer event',VenueID:'Venue',
  'ArtistIDs (comma-separated)':'Artists','HostCollectiveIDs (comma-separated)':'Collectives',PartyID:'Party',
  Description:'Description',Event_URL:'Event link',Instagram_URL:'Instagram link',
  RawFlyerURL:'Original flyer link',Flyer_URL:'Flyer image URL'
});
function qdpBackfillTargetRecord_(target) {
  const record=qdpArchiveAdminEventRecord_(target);
  const fields=new Map(record.fields.map(field=>[field.label,field]));
  record.fields=Object.entries(QDP_BACKFILL_FIELD_LABELS_).flatMap(([key,label])=>{
    const field=fields.get(label);
    return field?[{key,value:field.value,type:field.type,maxLength:field.maxLength,readOnly:field.readOnly}]:[];
  });
  return record;
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
function qdpBackfillReview_(body,table=qdpBackfillTable_('review'),indexes=null) {
  const index=indexes?indexes.get(body.key):table.rows.findIndex(r=>r[0]===body.key);
  if(index===undefined||index<0)throw new Error('This backfill candidate is no longer available.');
  const row=table.rows[index];
  if(body.expectedRevision!==qdpBackfillRevision_(row))throw new Error('This review changed. Reload it before saving.');
  return {table,index,row};
}
function qdpBackfillPublicPost_(row) {
  return {key:row[0],account:row[1],postedAt:row[2],url:row[3],caption:row[4],media:qdpBackfillParse_(row[5],[])};
}
function qdpBackfillPublicReview_(row,sourceByKey,catalog,lookups,workspace=false) {
  const fields=qdpBackfillParse_(row[3],{}),postKeys=qdpBackfillParse_(row[2],[]);
  const sources=postKeys.map(key=>sourceByKey.get(key)).filter(Boolean);
  const result={key:row[0],runId:row[1],indexSignature:lookups.signature,fields,evidence:qdpBackfillParse_(row[4],{}),state:row[5],
    targetSheet:row[6],targetEventId:row[7],selectedFields:qdpBackfillParse_(row[8],[]),draftDescription:row[9],approvedIndexSignature:row[13],
    visual:qdpBackfillParse_(row[10],{}),revision:qdpBackfillRevision_(row),result:row[12],
    ...(workspace?{postKeys}:{sources:sources.map(qdpBackfillPublicPost_)})};
  result.matches=qdpBackfillMatches_(fields,sources,catalog,lookups);
  if(!workspace&&row[6]&&row[7]) {
    try {result.target=qdpArchiveAdminEventRecord_(qdpBackfillTarget_(catalog,row[6],row[7]));}
    catch(error){result.targetIssue=String(error.message||error);}
  }
  return result;
}
function qdpBackfillPage_(body) {
  const review=qdpBackfillTable_('review',false),posts=qdpBackfillTable_('posts',false),runs=qdpBackfillTable_('runs',false);
  const sourceByKey=new Map(posts.rows.map(row=>[row[0],row]));
  if(body.workspace)return qdpBackfillWorkspace_(body,review,posts,runs,sourceByKey);
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

function qdpBackfillWorkspace_(body,review,posts,runs,sourceByKey) {
  const offset=Math.max(0,Math.floor(Number(body.offset)||0));
  const rows=review.rows.slice(offset,offset+QDP_BACKFILL_.workspaceRows);
  const catalog=rows.length?qdpBackfillCatalog_(review.ss):null;
  const lookups=rows.length?qdpArchiveLookups_(review.ss):null;
  const items=rows.map(row=>qdpBackfillPublicReview_(row,sourceByKey,catalog,lookups,true));
  const sources={},targets={};
  for(const item of items) {
    for(const key of item.postKeys)if(!sources[key]&&sourceByKey.has(key))sources[key]=qdpBackfillPublicPost_(sourceByKey.get(key));
    const matches=item.matches.slice();
    if(item.targetEventId)matches.push({sheet:item.targetSheet,eventId:item.targetEventId});
    for(const match of matches) {
      const key=qdpArchiveAdminEventKey_(match.sheet,match.eventId);
      if(Object.prototype.hasOwnProperty.call(targets,key))continue;
      try {targets[key]=qdpBackfillTargetRecord_(qdpBackfillTarget_(catalog,match.sheet,match.eventId));}
      catch(error){targets[key]=null;}
    }
  }
  const nextOffset=offset+rows.length;
  return {workflowVersion:2,items,sources,targets,total:review.rows.length,nextOffset:nextOffset<review.rows.length?nextOffset:null,
    indexSignature:lookups?.signature||'',sourceCount:posts.rows.length,
    runs:runs.rows.map(row=>({id:row[0],coverage:qdpBackfillParse_(row[1],{})})),
    needsPublish:!!qdpArchiveAdminRead_(QDP_ARCHIVE_ADMIN_.dirtyKey)};
}

function qdpBackfillFind_(body) {
  const query=qdpArchiveAdminSearchNormalize_(qdpBackfillString_(body.query||'',250));
  if(!query)return {events:[]};
  const catalog=qdpBackfillCatalog_(QDP_BACKFILL_INDEX_||(QDP_BACKFILL_INDEX_=ss_()));
  const events=catalog.filter(event=>qdpArchiveAdminSearchNormalize_(event.date+' '+event.text).includes(query))
    .filter(event=>catalog.byKey.get(qdpArchiveAdminEventKey_(event.sheet,event.eventId)))
    .slice(0,16).map(event=>qdpBackfillTargetRecord_(qdpBackfillTarget_(catalog,event.sheet,event.eventId)));
  return {events};
}
function qdpBackfillPlanReview_(body,original,target,indexSignature) {
  const row=original.slice();
  if(row[5]==='applied')throw new Error('This candidate has already been applied. Keep its audit record and make further edits in Archive Updates.');
  if(!['pending','confirmed','deferred','rejected'].includes(body.state))throw new Error('Choose a review decision.');
  const selected=body.selectedFields||[];
  if(!Array.isArray(selected)||selected.some(k=>!QDP_BACKFILL_.editable.includes(k)))throw new Error('Choose supported event fields.');
  if(body.state==='confirmed') {
    if(body.expectedIndexSignature!==indexSignature)throw new Error('The Index changed since this review opened. Reload it and check the match and selected fields again.');
    row[13]=indexSignature;
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
  return row;
}

function qdpBackfillSave_(body) {
  const current=qdpBackfillReview_(body),confirmed=body.state==='confirmed';
  const target=confirmed?qdpArchiveAdminEventTarget_({sheet:body.targetSheet,eventId:body.targetEventId}):null;
  const signature=confirmed?qdpArchiveLookups_(current.table.ss).signature:'';
  const row=qdpBackfillPlanReview_(body,current.row,target,signature);
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
function qdpBackfillMediaIndex_(table) {
  return new Map(table.rows.map((row,index)=>[row[0],{index,row,media:null}]));
}

function qdpBackfillChosenMedia_(review,selection,posts) {
  const {postKey,mediaId}=selection;
  if(!/^ig:\d{5,30}$/.test(postKey||'')||!/^\d{5,30}$/.test(mediaId||'')||
      !qdpBackfillParse_(review[2],[]).includes(postKey))throw new Error('Choose a flyer from this proposal’s source posts.');
  const post=posts.get(postKey);
  if(!post)throw new Error('The selected source post is unavailable.');
  if(!post.media)post.media=qdpBackfillParse_(post.row[5],[]);
  const asset=post.media.find(item=>item.id===mediaId);
  if(!asset)throw new Error('The selected source image is unavailable.');
  return {key:postKey+':'+mediaId,post,asset};
}

function qdpBackfillFlyerChanges_(changes) {
  return changes.filter(change=>change.state==='confirmed'&&Array.isArray(change.selectedFields)&&
    change.selectedFields.includes('Flyer_URL'));
}

function qdpBackfillPrepareFlyers_(changes) {
  const choices=qdpBackfillFlyerChanges_(changes).filter(change=>change.flyer);
  const staged=new Map();
  if(!choices.length)return staged;
  const review=qdpBackfillTable_('review',false),indexes=new Map(review.rows.map((row,i)=>[row[0],i]));
  const posts=qdpBackfillMediaIndex_(qdpBackfillTable_('posts',false)),loads=new Map();
  for(const change of choices) {
    try {
      const {row}=qdpBackfillReview_(change,review,indexes);
      if(row[5]==='applied')continue;
      const {key,asset}=qdpBackfillChosenMedia_(row,change.flyer,posts);
      if(asset.savedUrl&&asset.status==='saved')continue;
      const upload=change.flyer.imageBase64;
      if(!loads.has(key)||upload)loads.set(key,{key,asset,upload});
    }catch(error){staged.set(change.key,{error:String(error.message||error)});}
  }
  if(loads.size>QDP_BACKFILL_.saveFlyers)throw new Error('Save up to '+QDP_BACKFILL_.saveFlyers+' new flyers per batch.');
  if(!loads.size)return staged;
  let folder;
  try {
    if(typeof qdpScanFolder_!=='function'||typeof qdpScanHash_!=='function')throw new Error('Install the existing Apify flyer downloader first.');
    folder=qdpScanFolder_();
  }catch(error) {
    for(const key of loads.keys())staged.set(key,{error:String(error.message||error)});
    return staged;
  }
  const requests=[];
  for(const load of loads.values()) {
    const {key,asset,upload}=load;
    if(upload)continue;
    // Source URLs come from the imported Instagram media and are constrained to
    // the CDN. A redirect or expired link can be resolved with the original file.
    if(!/^https:\/\/(?:[a-z0-9-]+\.)*(?:cdninstagram\.com|fbcdn\.net)\/[^\s]+$/i.test(asset.url)) {
      staged.set(key,{error:'Choose the downloaded original for this source image.'});continue;
    }
    requests.push(load);
  }
  if(requests.length) {
    try {
      const responses=UrlFetchApp.fetchAll(requests.map(({asset})=>({
        url:asset.url,followRedirects:false,muteHttpExceptions:true
      })));
      requests.forEach((load,i)=>{load.response=responses[i];});
    }catch(error) {
      requests.forEach(({key})=>staged.set(key,{error:'Could not download the source image. Retry or choose the downloaded original.'}));
    }
  }
  for(const {key,asset,upload,response} of loads.values()) {
    if(staged.has(key))continue;
    try {
      const label='QDP backfill '+key.replace(/:/g,'-').replace(/-(\d+)$/, ' $1');
      if(!upload&&response?.getResponseCode()!==200)throw new Error('Source image unavailable. Choose its downloaded original.');
      const saved=upload?qdpBackfillStoreBytes_(folder,upload,label,asset.sha256):
        qdpBackfillStoreImageBytes_(folder,response.getBlob().getBytes(),label);
      staged.set(key,{url:asset.url,sha256:asset.sha256,savedUrl:saved.url});
    }catch(error){staged.set(key,{error:String(error.message||error)});}
  }
  return staged;
}

function qdpBackfillBatchFields_(change,row,posts,staged) {
  const applied={},pending=[],selected=qdpBackfillParse_(row[8],[]);
  const proposed=qdpBackfillParse_(row[3],{});
  let flyer=null;
  for(const key of selected) {
    if(key==='Description'&&!row[9].trim()) {pending.push(key);continue;}
    if(key==='Flyer_URL'&&change.flyer) {
      const failed=staged.get(change.key);
      if(failed?.error)throw new Error(failed.error);
      flyer=qdpBackfillChosenMedia_(row,change.flyer,posts);
      const asset=flyer.asset,prepared=staged.get(flyer.key);
      if(asset.savedUrl&&asset.status==='saved')applied[key]=asset.savedUrl;
      else {
        if(prepared?.error)throw new Error(prepared.error);
        if(!prepared?.savedUrl||prepared.url!==asset.url||prepared.sha256!==asset.sha256) {
          throw new Error('The source flyer changed while saving. Reload before trying again.');
        }
        flyer.savedUrl=applied[key]=prepared.savedUrl;
      }
      proposed[key]=applied[key];
      continue;
    }
    const value=key==='Description'?row[9]:proposed[key];
    if(typeof value!=='string'||!value.trim())throw new Error('Enter a value for the selected field '+key+'.');
    if(key==='Flyer_URL') {
      const saved=qdpBackfillParse_(row[2],[]).some(postKey=>{
        const post=posts.get(postKey);
        if(!post)return false;
        if(!post.media)post.media=qdpBackfillParse_(post.row[5],[]);
        return post.media.some(asset=>asset.status==='saved'&&asset.savedUrl===value);
      });
      if(!saved)throw new Error('Choose a source flyer for this event.');
    }
    applied[key]=value;
  }
  row[3]=qdpBackfillJSON_(proposed);
  return {applied,pending,flyer};
}

function qdpBackfillRecheckTargets_(plans) {
  const spans=new Map(),invalid=new Set();
  for(const {target,updates} of plans)if(updates.size) {
    const name=target.layout.name;
    let span=spans.get(name);
    if(!span) {
      span={target,first:target.number,last:target.number};spans.set(name,span);
    }
    span.first=Math.min(span.first,target.number);span.last=Math.max(span.last,target.number);
  }
  for(const span of spans.values()) {
    const {target}=span;
    if(target.addEditState)qdpEnsureEventEditState_(target.sheet);
    const header=target.sheet.getRange(1,1,1,target.sheet.getLastColumn()).getValues()[0].map(value=>String(value||'').trim());
    if(JSON.stringify(header)!==JSON.stringify(target.layout.headers))continue;
    const range=target.sheet.getRange(span.first,1,span.last-span.first+1,target.layout.width);
    span.rows=range.getValues();span.formulas=range.getFormulas();
  }
  for(const {target,updates} of plans)if(updates.size) {
    const span=spans.get(target.layout.name),index=target.number-span.first;
    if(!span.rows||qdpArchiveAdminEventRevision_({...target,row:span.rows[index],formulas:span.formulas[index]})!==target.revision)invalid.add(target);
  }
  return invalid;
}

function qdpBackfillSaveBatch_(changes,staged) {
  const review=qdpBackfillTable_('review',false),ss=review.ss;
  const indexes=new Map(review.rows.map((row,i)=>[row[0],i]));
  const confirmed=changes.filter(change=>change.state==='confirmed');
  const catalog=confirmed.length?qdpBackfillCatalog_(ss,new Set(confirmed.map(change=>change.targetSheet))):null;
  const signature=confirmed.length?qdpArchiveLookups_(ss).signature:'';
  const posts=qdpBackfillFlyerChanges_(changes).length?qdpBackfillTable_('posts',false):null;
  const media=posts?qdpBackfillMediaIndex_(posts):null;
  const counts=new Map(),planned=[],results=[],eventPlans=[];
  for(const change of confirmed) {
    if(!Array.isArray(change.selectedFields)||!change.selectedFields.length)continue;
    const key=qdpArchiveAdminEventKey_(change.targetSheet,change.targetEventId);
    counts.set(key,(counts.get(key)||0)+1);
  }
  let archiveBusy='';
  if(confirmed.some(change=>change.selectedFields?.length)) {
    try {
      qdpArchiveAdminReady_();qdpArchiveAdminCheckEventSave_();
      if(typeof qdpPublicPublishSaved_!=='function')throw new Error('Install the current PublicData.gs before saving held archive changes.');
    }catch(error){archiveBusy=String(error.message||error);}
  }
  for(const change of changes) {
    const outcome={key:change.key};
    results.push(outcome);
    try {
      const current=qdpBackfillReview_(change,review,indexes);
      const target=change.state==='confirmed'?qdpBackfillTarget_(catalog,change.targetSheet,change.targetEventId):null;
      if(target&&change.expectedTargetRevision!==target.revision)throw new Error('The archive event changed since review. Reload and check this match again.');
      const row=qdpBackfillPlanReview_(change,current.row,target,signature);
      const item={current,row,target,outcome,plan:null,flyer:null};
      const preserveDraft=Boolean(current.row[9])&&!qdpBackfillParse_(row[8],[]).includes('Description')&&
        (!target||(row[6]===current.row[6]&&row[7]===current.row[7]));
      if(target) {
        const {applied,pending,flyer}=qdpBackfillBatchFields_(change,row,media,staged);
        if(preserveDraft)pending.push('Description');
        if(Object.keys(applied).length) {
          if(archiveBusy)throw new Error(archiveBusy);
          const targetKey=qdpArchiveAdminEventKey_(target.layout.name,target.eventId);
          if(counts.get(targetKey)>1)throw new Error('More than one proposal targets this event. Keep one update queued for this event.');
          const byLabel=new Map(qdpArchiveAdminEventFields_(target).map(field=>[field.label,field]));
          const fields={};
          for(const [key,value] of Object.entries(applied)) {
            const field=byLabel.get(QDP_BACKFILL_FIELD_LABELS_[key]);
            if(!field||field.readOnly)throw new Error('The selected archive field cannot be edited: '+key);
            fields[field.key]=value;
          }
          item.plan=qdpArchiveAdminPrepareEvent_({expectedRevision:target.revision,fields},target);
          item.flyer=flyer;
          eventPlans.push(item.plan);
          row[5]=pending.length?'confirmed':'applied';
          row[8]=JSON.stringify(pending);
          row[12]='Saved '+item.plan.updates.size+' changed cells.';
          if(pending.length)row[12]+=preserveDraft?' Description draft kept for review.':' Description draft requested.';
        }
      }
      if(preserveDraft) {
        row[8]=JSON.stringify([...new Set([...qdpBackfillParse_(row[8],[]),'Description'])]);
        row[9]=current.row[9];
      }
      planned.push(item);
    }catch(error){outcome.error=String(error.message||error);}
  }

  const invalid=qdpBackfillRecheckTargets_(eventPlans);
  const requests=[],cells=[],audit=[],updatedPosts=new Set();
  let editedEvents=0;
  for(const item of planned) {
    const {current,row,target,outcome,plan,flyer}=item;
    if(plan&&invalid.has(target)) {
      outcome.error='The archive event changed while saving. Reload and check this match again.';continue;
    }
    if(flyer?.savedUrl) {
      Object.assign(flyer.asset,{savedUrl:flyer.savedUrl,status:'saved',savedAt:row[11]});
      delete flyer.asset.error;updatedPosts.add(flyer.post);
    }
    if(plan) {
      const before={},after={};
      for(const [column,value] of plan.updates) {
        const key=target.layout.headers[column-1];before[key]=target.row[column-1];after[key]=value;
        cells.push({sheet:target.sheet,row:target.number,column,value});
      }
      audit.push([Utilities.getUuid(),row[0],target.eventId,target.layout.name,qdpBackfillJSON_(before),qdpBackfillJSON_(after),target.revision,row[11]]);
      if(plan.updates.size)editedEvents++;
    }
    requests.push(qdpBackfillUpdateRow_(review,current.index,row));
    Object.assign(outcome,{revision:qdpBackfillRevision_(row),state:row[5],selectedFields:qdpBackfillParse_(row[8],[]),
      fields:qdpBackfillParse_(row[3],{}),draftDescription:row[9],result:row[12],approvedIndexSignature:row[13]});
    if(target) {
      const saved={...target,row:plan?plan.row:target.row};
      saved.revision=qdpArchiveAdminEventRevision_(saved);
      outcome.target=qdpBackfillTargetRecord_(saved);
    }
  }
  for(const post of updatedPosts) {
    post.row[5]=qdpBackfillJSON_(post.media);
    cells.push({sheet:posts.sheet,row:post.index+2,column:6,value:post.row[5]});
  }
  if(audit.length)requests.push(qdpBackfillAppend_(qdpBackfillTable_('history'),audit));
  if(editedEvents)qdpArchiveAdminMarkDirty_();
  qdpBackfillCommit_(ss,cells,requests);
  return {results,editedEvents,needsPublish:!!qdpArchiveAdminRead_(QDP_ARCHIVE_ADMIN_.dirtyKey),
    sources:[...updatedPosts].map(post=>qdpBackfillPublicPost_(post.row))};
}

function qdpBackfillBatchList_(items,max) {
  if(!Array.isArray(items)||!items.length||items.length>max)throw new Error('Send between 1 and '+max+' backfill rows per batch.');
  if(items.some(item=>!item||typeof item.key!=='string')||new Set(items.map(item=>item.key)).size!==items.length) {
    throw new Error('Choose each backfill proposal only once.');
  }
  return items;
}

function qdpBackfillStoreBytes_(folder,base64,label,expectedHash) {
  qdpBackfillString_(base64,9*1024*1024);
  return qdpBackfillStoreImageBytes_(folder,Utilities.base64Decode(base64),label,expectedHash);
}
function qdpBackfillStoreImageBytes_(folder,bytes,label,expectedHash) {
  const b=bytes.slice(0,12).map(n=>n&255);
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
function qdpBackfillPlanDraft_(body,original) {
  const row=original.slice();
  if(row[5]!=='confirmed'||!qdpBackfillParse_(row[8],[]).includes('Description'))throw new Error('This event has no confirmed request to update its description.');
  const draft=qdpBackfillString_(body.description||'');if(!draft.trim())throw new Error('Supply a description draft.');
  if(typeof qdpScanDescriptionHasLink_==='function'&&qdpScanDescriptionHasLink_(draft))throw new Error('Keep links outside the public description.');
  row[9]=draft;row[11]=new Date().toISOString();
  return row;
}
function qdpBackfillDraft_(body) {
  const current=qdpBackfillReview_(body),row=qdpBackfillPlanDraft_(body,current.row);
  qdpBackfillCommit_(current.table.ss,qdpBackfillRowCells_(current.table,current.index,row));
  return {key:row[0],revision:qdpBackfillRevision_(row)};
}
function qdpBackfillDraftBatch_(items) {
  const table=qdpBackfillTable_('review',false),indexes=new Map(table.rows.map((row,i)=>[row[0],i]));
  const updates=[],results=[];
  for(const item of items) {
    try {
      const current=qdpBackfillReview_(item,table,indexes),row=qdpBackfillPlanDraft_(item,current.row);
      updates.push(qdpBackfillUpdateRow_(table,current.index,row));
      results.push({key:item.key,revision:qdpBackfillRevision_(row),draftDescription:row[9]});
    }catch(error){results.push({key:item.key,error:String(error.message||error)});}
  }
  qdpBackfillCommit_(table.ss,[],updates);
  return {results};
}
function qdpAdminBackfill_(body) {
  QDP_ARCHIVE_REQUEST_=null;
  QDP_BACKFILL_INDEX_=null;
  const action=String(body.action||'').toLowerCase();
  if(action==='admin.backfill.bootstrap')return qdpBackfillPage_(body);
  if(action==='admin.backfill.find')return qdpBackfillFind_(body);
  if(action==='admin.backfill.requests')return qdpBackfillDescriptionRequests_();
  if(action==='admin.backfill.ingest') {
    const payload=qdpBackfillUnpackImport_(body);
    return qdpArchiveWithLock_(()=>qdpBackfillIngest_(payload));
  }
  if(action==='admin.backfill.savebatch') {
    const changes=qdpBackfillBatchList_(body.changes,QDP_BACKFILL_.saveRows);
    const staged=qdpBackfillPrepareFlyers_(changes);
    return qdpArchiveWithLock_(()=>qdpBackfillSaveBatch_(changes,staged));
  }
  return qdpArchiveWithLock_(()=>{
    if(action==='admin.backfill.save')return qdpBackfillSave_(body);
    if(action==='admin.backfill.media')return qdpBackfillMediaSave_(body);
    if(action==='admin.backfill.apply')return qdpBackfillApply_(body);
    if(action==='admin.backfill.draft')return qdpBackfillDraft_(body);
    if(action==='admin.backfill.draftbatch')return qdpBackfillDraftBatch_(qdpBackfillBatchList_(body.drafts,100));
    throw new Error('Unknown archive backfill action.');
  });
}
