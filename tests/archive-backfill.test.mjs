import nodeTest from 'node:test';
const test=(name,fn)=>nodeTest(name,{skip:!process.env.QDP_CORE_SOURCE&&'Set QDP_CORE_SOURCE to the supplied Core.gs'},fn);
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import vm from 'node:vm';
import {setup,event,eventHeaders} from './helpers/archive-fixture.mjs';
const source=readFileSync(new URL('../apps-script/ArchiveBackfill.gs',import.meta.url),'utf8');
const post=(fields={})=>({pk:'1234567890123',code:'ExamplePost',taken_at:1743465600,scraped_username:'example',post_url:'https://www.instagram.com/p/ExamplePost/',caption:{text:'Night ONE, April 1 at The Room. Featuring New Artist.'},image_url:'https://scontent.cdninstagram.com/flyer.jpg',...fields});
const candidate=(fields={})=>({key:'pilot:one',postKeys:['ig:1234567890123'],fields:{'Title (internal)':'Night ONE',StartDate:'2025-04-01',VenueID:'ROOM',Lineup_Raw:'New Artist',Description:'',...fields},visual:{status:'inspected',mediaIds:['1234567890123']}});
function fixture(events=[event('ONE','Original copy',{VenueID:'ROOM',Flyer_URL:'https://images.example/original.jpg'})]){
  const h=setup({events});
  const files=[];let downloads=0;
  const folder={getId:()=> 'raw-folder',createFile:(...args)=>{files.push(args);return {getId:()=> 'raw-file-'+files.length};}};
  h.c.DriveApp={createFolder:()=>folder,getFolderById:()=>folder};
  h.c.qdpScanFolder_=()=>folder;h.c.qdpScanSaveImage_=()=>{downloads++;return {url:'https://drive.google.com/uc?export=view&id=verified-image'};};
  h.c.qdpScanDescriptionHasLink_=s=>/https?:\/\//.test(s);
  vm.runInContext(source,h.c);
  const call=(action,data={})=>h.c.qdpAdminBackfill_({action:'admin.backfill.'+action,...data});
  const importOne=(item=candidate())=>call('ingest',{runId:'pilot-2025',posts:[post()],candidates:[item]});
  const row=()=>call('bootstrap').items[0];
  const confirm=(selectedFields=['Title (internal)'],more={})=>{const current=row();return call('save',{key:current.key,expectedRevision:current.revision,state:'confirmed',targetSheet:'Events_Archive',targetEventId:'ONE',expectedIndexSignature:current.indexSignature,selectedFields,...more});};
  return {...h,call,importOne,row,confirm,files,get downloads(){return downloads;}};
}
test('source intake preserves original records and leaves archive and Calendar untouched',()=>{
  const h=fixture(),before=h.plain(h.sheets.get('Events_Archive').rows);h.importOne();
  assert.deepEqual(h.plain(h.sheets.get('Events_Archive').rows),before);assert.deepEqual(h.publishes,[]);
  assert.deepEqual(JSON.parse(h.files[0][1]),[post()]);assert.equal(h.row().fields.Description,'');assert.equal(h.row().state,'pending');
});
test('initial collection refuses unsolicited descriptions',()=>{
  const h=fixture();assert.throws(()=>h.importOne(candidate({Description:'Unrequested promotional copy'})),/must leave Description blank/);
  assert.equal(h.sheets.get('Backfill_Review').rows.length,1);
});
test('same post from two accounts deduplicates; reimport preserves rejection and saved media',()=>{
  const h=fixture();h.call('ingest',{runId:'pilot-2025',posts:[post(),post({scraped_username:'coauthor'})],candidates:[candidate()]});
  assert.equal(h.sheets.get('Backfill_Posts').rows.length,2);assert.match(h.sheets.get('Backfill_Posts').rows[1][1],/example,coauthor/);
  h.call('media',{postKey:'ig:1234567890123',mediaId:'1234567890123'});const current=h.row();
  h.call('save',{key:current.key,expectedRevision:current.revision,state:'rejected',selectedFields:[]});h.importOne();
  assert.equal(h.row().state,'rejected');assert.match(h.row().sources[0].media[0].savedUrl,/verified-image/);assert.equal(h.files.length,1);
});
test('same recurring title on a different date cannot be proposed as a match',()=>{
  const h=fixture();h.importOne(candidate({StartDate:'2025-04-02'}));assert.equal(h.row().matches.length,0);
});
test('match proposals explain date and venue evidence without changing event values',()=>{
  const h=fixture();h.importOne();const match=h.row().matches[0];assert.equal(match.eventId,'ONE');
  assert.match(match.reasons.join(';'),/Same event date/);assert.match(match.reasons.join(';'),/Same venue/);
  assert.equal(h.sheets.get('Events_Archive').rows[1][eventHeaders.indexOf('Description')],'Original copy');
});
test('description writing requires a saved confirmed request and retains source evidence',()=>{
  const h=fixture();h.importOne();let current=h.row();assert.throws(()=>h.call('draft',{key:current.key,expectedRevision:current.revision,description:'Draft'}),/no confirmed request/);
  h.confirm(['Description']);const requests=h.call('requests').requests;assert.equal(requests.length,1);assert.equal(requests[0].sources[0].caption,post().caption.text);
  h.call('draft',{key:requests[0].key,expectedRevision:requests[0].expectedRevision,description:'A night of house music with New Artist.'});
  assert.equal(h.call('requests').requests.length,0);assert.equal(h.sheets.get('Events_Archive').rows[1][eventHeaders.indexOf('Description')],'Original copy');
});
test('stale review and archive revisions block changes',()=>{
  const h=fixture();h.importOne();const first=h.row();h.confirm();
  assert.throws(()=>h.call('save',{key:first.key,expectedRevision:first.revision,state:'deferred',selectedFields:[]}),/review changed/);
  const current=h.row();h.sheets.get('Events_Archive').rows[1][eventHeaders.indexOf('Description')]='External edit';
  assert.throws(()=>h.call('apply',{key:current.key,expectedRevision:current.revision,expectedTargetRevision:current.target.revision,fields:{'Title (internal)':'Revised title'}}),/archive event changed/);
});
test('blank proposals and unselected fields cannot overwrite archive values',()=>{
  const h=fixture();h.importOne();h.confirm();const current=h.row(),base={key:current.key,expectedRevision:current.revision,expectedTargetRevision:current.target.revision};
  assert.throws(()=>h.call('apply',{...base,fields:{'Title (internal)':''}}),/blank proposal/);
  assert.throws(()=>h.call('apply',{...base,fields:{'Title (internal)':'Changed',Description:'Extra change'}}),/exactly the fields/);
});
test('selected edits, completion and history commit atomically with a publication hold',()=>{
  const h=fixture();h.importOne();h.confirm();const current=h.row(),prior=h.batchRequests.length;
  const result=h.call('apply',{key:current.key,expectedRevision:current.revision,expectedTargetRevision:current.target.revision,fields:{'Title (internal)':'Revised event title'}});
  assert.ok(result.changedCells>0);assert.equal(h.batchRequests.length,prior+1);const batch=h.batchRequests.at(-1);
  assert.ok(batch.some(r=>r.appendCells?.sheetId===h.sheets.get('Backfill_History').getSheetId()));
  assert.ok(batch.some(r=>r.updateCells?.start.sheetId===h.sheets.get('Events_Archive').getSheetId()));
  assert.ok(batch.some(r=>r.updateCells?.start.sheetId===h.sheets.get('Backfill_Review').getSheetId()));
  assert.equal(h.row().state,'applied');assert.equal(h.call('bootstrap').needsPublish,true);assert.deepEqual(h.publishes,[]);
  const audit=h.sheets.get('Backfill_History').rows[1];assert.equal(JSON.parse(audit[4])['Title (internal)'],'Night ONE');assert.equal(JSON.parse(audit[5])['Title (internal)'],'Revised event title');
});
test('a Sheets failure writes neither event update nor applied decision',()=>{
  const h=fixture();h.importOne();h.confirm();const current=h.row();h.c.Sheets.Spreadsheets.batchUpdate=()=>{throw new Error('Sheets unavailable');};
  assert.throws(()=>h.call('apply',{key:current.key,expectedRevision:current.revision,expectedTargetRevision:current.target.revision,fields:{'Title (internal)':'Changed'}}),/Sheets unavailable/);
  assert.equal(h.row().state,'confirmed');assert.equal(h.sheets.get('Events_Archive').rows[1][eventHeaders.indexOf('Title (internal)')],'Night ONE');
});
test('flyer replacements must reference a verified image belonging to this proposal',()=>{
  const h=fixture();h.importOne();h.confirm(['Flyer_URL']);let current=h.row();
  assert.throws(()=>h.call('apply',{key:current.key,expectedRevision:current.revision,expectedTargetRevision:current.target.revision,fields:{Flyer_URL:'https://images.example/unverified.jpg'}}),/Save and verify/);
  const saved=h.call('media',{postKey:'ig:1234567890123',mediaId:'1234567890123'});h.call('media',{postKey:'ig:1234567890123',mediaId:'1234567890123'});assert.equal(h.downloads,1);
  current=h.row();h.call('apply',{key:current.key,expectedRevision:current.revision,expectedTargetRevision:current.target.revision,fields:{Flyer_URL:saved.url}});
  assert.equal(h.sheets.get('Events_Archive').rows[1][eventHeaders.indexOf('Flyer_URL')],saved.url);
});
test('saving choices preserves edited proposed values without editing the archive',()=>{
  const h=fixture();h.importOne();const current=h.row();h.call('save',{key:current.key,expectedRevision:current.revision,state:'confirmed',targetSheet:'Events_Archive',targetEventId:'ONE',expectedIndexSignature:current.indexSignature,selectedFields:['Title (internal)'],fields:{'Title (internal)':'My edited proposal'}});
  assert.equal(h.row().fields['Title (internal)'],'My edited proposal');assert.equal(h.sheets.get('Events_Archive').rows[1][eventHeaders.indexOf('Title (internal)')],'Night ONE');
});
test('matching queues separate suggested links from unresolved leads without dropping source records',()=>{
  const h=fixture();h.importOne();h.call('ingest',{runId:'pilot-2025',candidates:[{...candidate({StartDate:''}),key:'pilot:unknown'}]});
  assert.equal(h.call('bootstrap',{queue:'matches'}).total,1);assert.equal(h.call('bootstrap',{queue:'unmatched'}).total,1);assert.equal(h.call('bootstrap').sourceCount,1);
});
test('restored images must match their stored original hash and verify their Drive copy',()=>{
  const h=fixture(),bytes=[255,216,255,0,1,2,3],hash='a'.repeat(64),folder={getFilesByName:()=>({hasNext:()=>false}),createFile:blob=>({getId:()=> 'saved',getResourceKey:()=> '',getBlob:()=>({getBytes:()=>blob.bytes})})};
  h.c.Utilities.base64Decode=()=>bytes;h.c.Utilities.newBlob=(bytes,mime,name)=>({bytes,mime,name});h.c.qdpScanHash_=()=>hash;
  assert.throws(()=>h.c.qdpBackfillStoreBytes_(folder,'bytes','source','b'.repeat(64)),/does not match/);
  assert.match(h.c.qdpBackfillStoreBytes_(folder,'bytes','source',hash).url,/id=saved/);
});
test('Index changes invalidate saved approvals before an archive write',()=>{
  const h=fixture();h.importOne();h.confirm();const reviewed=h.row();h.sheets.get('Artists').rows[1][1]='Renamed Artist';
  assert.throws(()=>h.call('apply',{key:reviewed.key,expectedRevision:reviewed.revision,expectedTargetRevision:reviewed.target.revision,fields:{'Title (internal)':'Changed'}}),/Index changed after approval/);
  assert.equal(h.sheets.get('Events_Archive').rows[1][eventHeaders.indexOf('Title (internal)')],'Night ONE');
});
test('review mutations require an explicit current revision',()=>{
  const h=fixture();h.importOne();const current=h.row();assert.throws(()=>h.call('save',{key:current.key,state:'deferred',selectedFields:[]}),/review changed/);assert.equal(h.row().state,'pending');
});
test('opening an empty collection does not scan the archive, read profiles or create tables',()=>{
  const h=fixture();h.reads.length=0;
  const before=h.plain([...h.sheets.keys()]),page=h.call('bootstrap',{queue:'matches'});
  assert.equal(page.total,0);assert.equal(page.sourceCount,0);assert.equal(page.items.length,0);
  assert.deepEqual(h.plain([...h.sheets.keys()]),before);assert.deepEqual(h.reads,[]);
});
test('match scans remain read-only while another execution holds the shared save lock',()=>{
  const h=fixture();h.importOne();
  const archive=h.sheets.get('Events_Archive'),column=archive.rows[0].indexOf('QDP_EditState');
  archive.rows.forEach(row=>row.splice(column,1));
  const before=h.plain(archive.rows),batches=h.batchRequests.length,lock=h.c.LockService.getScriptLock();
  assert.equal(lock.tryLock(),true);
  try{
    const page=h.call('bootstrap',{queue:'matches'});
    assert.equal(page.total,1);assert.equal(page.items[0].matches[0].eventId,'ONE');
    assert.deepEqual(h.plain(archive.rows),before);assert.equal(h.batchRequests.length,batches);
  }finally{lock.releaseLock();}
});

function workspace(h){return h.call('bootstrap',{workspace:true});}
function target(view,id='ONE') {return view.targets[JSON.stringify(['Events_Archive',id])];}
function choice(item,event,fields={},extra={}) {
  return {key:item.key,state:'confirmed',expectedRevision:item.revision,expectedIndexSignature:item.indexSignature,
    targetSheet:event.sheet,targetEventId:event.eventId,expectedTargetRevision:event.revision,
    selectedFields:Object.keys(fields),fields,...extra};
}

test('one compressed import stores hundreds of original posts and replay avoids duplicate writes',()=>{
  const h=fixture();
  h.c.Utilities.base64Decode=value=>[...Buffer.from(value,'base64')];
  h.c.Utilities.newBlob=bytes=>Buffer.from(bytes);
  h.c.Utilities.ungzip=bytes=>({getDataAsString:()=>gunzipSync(bytes).toString('utf8')});
  const posts=Array.from({length:500},(_,i)=>post({pk:String(1234567890123+i)}));
  const data={runId:'compressed-pilot',posts,candidates:[candidate()]};
  const payload={gzip:gzipSync(JSON.stringify(data)).toString('base64')};
  assert.deepEqual(h.plain(h.call('ingest',payload)),{addedPosts:500,addedCandidates:1});
  assert.equal(h.files.length,1);assert.deepEqual(JSON.parse(h.files[0][1]),posts);
  const before=h.batchRequests.length;
  assert.deepEqual(h.plain(h.call('ingest',payload)),{addedPosts:0,addedCandidates:0});
  assert.equal(h.batchRequests.length,before);assert.equal(h.files.length,1);
});

test('one workspace read includes the current records for every suggested match without taking the save lock',()=>{
  const h=fixture([event('ONE','First current description',{VenueID:'ROOM'}),event('TWO','Second current description',{VenueID:'ROOM'})]);
  h.importOne();
  const archive=h.sheets.get('Events_Archive');
  archive.rows.forEach(row=>row.pop()); // older archive layout without QDP_EditState
  h.reads.length=0; h.formulaReads.length=0;
  const lock=h.c.LockService.getScriptLock();assert.equal(lock.tryLock(),true);
  try {
    const view=workspace(h);
    assert.equal(view.nextOffset,null);assert.equal(view.items[0].matches.length,2);
    assert.equal(target(view).fields.find(field=>field.key==='Description').value,'First current description');
    assert.equal(target(view,'TWO').fields.find(field=>field.key==='Description').value,'Second current description');
    assert.equal(h.reads.filter(read=>read.sheet==='Events_Archive').length,1);
    assert.deepEqual(h.formulaReads,['Events_Archive']);
    assert.ok(!archive.rows[0].includes('QDP_EditState'));
  } finally {lock.releaseLock();}
});

test('one save writes multiple archive events, a dismissal and their history in one Sheets update',()=>{
  const h=fixture([event('ONE','First original',{VenueID:'ROOM'}),event('TWO','Second original',{VenueID:'ROOM'})]);
  const two={...candidate({'Title (internal)':'Night TWO'}),key:'pilot:two'};
  const three={...candidate(),key:'pilot:three'};
  h.call('ingest',{runId:'pilot-2025',posts:[post()],candidates:[candidate(),two,three]});
  const archive=h.sheets.get('Events_Archive');
  archive.rows.forEach(row=>row.pop());
  const view=workspace(h),[one,second,third]=view.items;
  const before=h.batchRequests.length;
  const saved=h.call('savebatch',{changes:[choice(one,target(view),{'Title (internal)':'First revised'}),
    choice(second,target(view,'TWO'),{'Title (internal)':'Second revised'}),
    {key:third.key,state:'rejected',expectedRevision:third.revision}]});
  assert.equal(saved.editedEvents,2);
  assert.deepEqual(h.plain(saved.results.map(row=>row.state)),['applied','applied','rejected']);
  assert.equal(h.batchRequests.length,before+1);
  assert.equal(archive.rows[1][2],'First revised');assert.equal(archive.rows[2][2],'Second revised');
  assert.ok(archive.rows[0].includes('QDP_EditState'));
  assert.equal(h.sheets.get('Backfill_History').rows.length,3);assert.equal(saved.needsPublish,true);
  assert.deepEqual(h.publishes,[]);
});

test('rendered snapshot revisions protect the archive and a stale row does not block an unrelated valid row',()=>{
  const h=fixture([event('ONE','Original one',{VenueID:'ROOM'}),event('TWO','Original two',{VenueID:'ROOM'})]);
  h.call('ingest',{runId:'pilot-2025',posts:[post()],candidates:[candidate(),{...candidate(),key:'pilot:two'}]});
  const view=workspace(h),[one,two]=view.items;
  h.sheets.get('Events_Archive').rows[1][eventHeaders.indexOf('Description')]='External edit';
  const saved=h.call('savebatch',{changes:[choice(one,target(view),{'Title (internal)':'One changed'}),
    choice(two,target(view,'TWO'),{'Title (internal)':'Two changed'})]});
  assert.match(saved.results[0].error,/archive event changed/);
  assert.equal(saved.results[1].state,'applied');assert.equal(saved.editedEvents,1);
  assert.equal(h.sheets.get('Events_Archive').rows[1][2],'Night ONE');
  assert.equal(h.sheets.get('Backfill_Review').rows[1][5],'pending');
});

test('selected flyers download together outside the write lock and an expired image leaves only its row pending',()=>{
  const h=fixture([event('ONE','Original one',{VenueID:'ROOM'}),event('TWO','Original two',{VenueID:'ROOM'})]);
  const twoId='1234567890124',second={...candidate(),key:'pilot:two',postKeys:['ig:'+twoId]};
  h.call('ingest',{runId:'pilot-2025',posts:[post(),post({pk:twoId,image_url:'https://scontent.cdninstagram.com/expired.jpg'})],candidates:[candidate(),second]});
  const view=workspace(h),[one,two]=view.items,requests=[];
  const bytes=[255,216,255,0,1,2,3];
  const folder={getFilesByName:()=>({hasNext:()=>false}),createFile:blob=>({getId:()=> 'saved',getResourceKey:()=> '',getBlob:()=>({getBytes:()=>blob.bytes})})};
  h.c.qdpScanFolder_=()=>folder;
  h.c.Utilities.newBlob=(bytes,mime,name)=>({bytes,mime,name});
  h.c.qdpScanHash_=value=>createHash('sha256').update(Buffer.from(value)).digest('hex');
  h.c.UrlFetchApp={fetchAll(items){
    const lock=h.c.LockService.getScriptLock();assert.equal(lock.tryLock(),true);lock.releaseLock();
    requests.push(h.plain(items));return [
      {getResponseCode:()=>200,getBlob:()=>({getBytes:()=>bytes})},{getResponseCode:()=>403}
    ];
  }};
  const approved=(item,archive,id)=>choice(item,archive,{}, {selectedFields:['Flyer_URL'],flyer:{postKey:'ig:'+id,mediaId:id}});
  const before=h.batchRequests.length;
  const saved=h.call('savebatch',{changes:[approved(one,target(view),'1234567890123'),approved(two,target(view,'TWO'),twoId)]});
  assert.equal(requests.length,1);assert.equal(requests[0].length,2);
  assert.equal(h.batchRequests.length,before+1);assert.equal(saved.editedEvents,1);
  assert.match(saved.results[0].fields.Flyer_URL,/id=saved/);
  assert.match(saved.results[1].error,/downloaded original/);
  assert.equal(saved.sources[0].media[0].status,'saved');assert.equal(h.sheets.get('Backfill_Review').rows[2][5],'pending');
  h.c.Utilities.base64Decode=value=>[...Buffer.from(value,'base64')];
  const fallback=approved(two,target(view,'TWO'),twoId);
  fallback.flyer.imageBase64=Buffer.from(bytes).toString('base64');
  const restored=h.call('savebatch',{changes:[fallback]});
  assert.equal(restored.results[0].state,'applied');assert.equal(requests.length,1);
});

test('saving other checked fields keeps a selected description request open for later draft review',()=>{
  const h=fixture();h.importOne();const view=workspace(h),item=view.items[0];
  const saved=h.call('savebatch',{changes:[choice(item,target(view),{'Title (internal)':'Revised title'},
    {selectedFields:['Title (internal)','Description']})]});
  assert.equal(saved.editedEvents,1);assert.equal(saved.results[0].state,'confirmed');
  const request=h.call('requests').requests[0];
  assert.equal(request.key,item.key);assert.equal(request.expectedRevision,saved.results[0].revision);
  const before=h.batchRequests.length;
  const drafts=h.call('draftbatch',{drafts:[{key:request.key,expectedRevision:request.expectedRevision,description:'Reviewed event copy.'}]});
  assert.equal(h.batchRequests.length,before+1);assert.equal(drafts.results[0].draftDescription,'Reviewed event copy.');
  assert.equal(h.sheets.get('Events_Archive').rows[1][eventHeaders.indexOf('Description')],'Original copy');
  const ready=workspace(h);
  const other=h.call('savebatch',{changes:[choice(ready.items[0],target(ready),{'Title (internal)':'Another title'})]});
  assert.equal(other.results[0].state,'confirmed');assert.equal(other.results[0].draftDescription,'Reviewed event copy.');
  assert.equal(h.sheets.get('Events_Archive').rows[1][eventHeaders.indexOf('Description')],'Original copy');
  const updated=workspace(h);
  const applied=h.call('savebatch',{changes:[choice(updated.items[0],target(updated),{},
    {selectedFields:['Description'],draftDescription:drafts.results[0].draftDescription})]});
  assert.equal(applied.results[0].state,'applied');
  assert.equal(h.sheets.get('Events_Archive').rows[1][eventHeaders.indexOf('Description')],'Reviewed event copy.');
});
