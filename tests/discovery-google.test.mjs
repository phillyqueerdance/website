import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';import {createHash} from 'node:crypto';
const gs=fs.readFileSync(new URL('../apps-script/DiscoveryInbox.gs',import.meta.url),'utf8');
const headers=['EventID','Title (internal)','StartDate','StartTime','EndDate','EndTime','Timezone','Description','VenueID','ArtistIDs (comma-separated)','HostCollectiveIDs (comma-separated)','PartyID','ExplicitQueer (Yes/No)','Flyer_URL','Event_URL','Location','Publish_To_Web','LastEditedAt','CalendarEventId','LastSyncedAt','CalendarUpdatedAt','SyncNotes','ImportSourceKey','ImportSourceSnapshot','CalendarCreateId','Lineup_Raw'];
const aliases={eventId:'EventID',title:'Title (internal)',startDate:'StartDate',startTime:'StartTime',endDate:'EndDate',endTime:'EndTime',timezone:'Timezone',description:'Description',venue:'VenueID',artists:'ArtistIDs (comma-separated)',colls:'HostCollectiveIDs (comma-separated)',party:'PartyID',explicit:'ExplicitQueer (Yes/No)',flyer:'Flyer_URL',url:'Event_URL',location:'Location',publish:'Publish_To_Web',edited:'LastEditedAt',calId:'CalendarEventId',synced:'LastSyncedAt',calUpdated:'CalendarUpdatedAt',notes:'SyncNotes',sourceKey:'ImportSourceKey',snapshot:'ImportSourceSnapshot',createId:'CalendarCreateId'};
function fixture(){
  const rows=[],calendar=new Map(),receipts=new Map(),calls={inserts:0,patches:0,writes:0,downloads:0,calendarBatches:0,appends:0,lists:0};let loseResponse=false;
  const c=Object.fromEntries(Object.entries(aliases).map(([k,v])=>[k,headers.indexOf(v)]));
  const sheet={getName:()=> 'Events',getParent:()=>ss,getLastRow:()=>rows.length+1,getLastColumn:()=>headers.length,getSheetId:()=>1,
    getRange(row,col,height=1,width=1){return {getValues(){return row===1?[headers.slice(col-1,col-1+width)]:rows.slice(row-2,row-2+height).map(r=>r.slice(col-1,col-1+width));},getFormulas:()=>Array.from({length:height},()=>Array(width).fill(''))};}};
  const receiptSheet={getLastRow:()=>receipts.size+1,getRange(row){return{setValues(values){receipts.set(values[0][0],{number:row,value:JSON.parse(values[0][1])});}};}};
  const ss={getSpreadsheetTimeZone:()=> 'America/New_York',getSheets:()=>[sheet],getId:()=> 'fixture',getSheetByName:()=>null};
  const table=()=>({sheet,headers,col:c,rows:rows.map(r=>r.slice())});
  const read=(row,col,key)=>col[key]>=0?row[col[key]]:'';
  const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const context=vm.createContext({Date,Map,Set,JSON,Object,String,Array,Number,Math,RegExp,console,FLAGS:{PUSH_ENABLED:true},CONFIG:{CALENDAR_ID:'fixture',SHEET_EVENTS:'Events'},
    QDP_APIFY_CORRECTION_LABELS_:{description:'Description',lineup:'Lineup',start:'Start',end:'End',flyer:'Flyer'},QDP_APIFY_CALENDAR_FIELDS_:['description','start','end'],
    ss_:()=>ss,nowISO:()=>new Date().toISOString(),qdpWithWriteLock_:fn=>fn(),qviEventTable_:table,qviRead_:read,qviS_:v=>v==null?'':String(v).trim(),qviYes_:v=>v==='Yes',
    qviPut_:(row,col,key,value)=>{if(col[key]>=0)row[col[key]]=value;},buildLookupMaps_:()=>({}),
    qdpScanDescriptionHasLink_:value=>/https?:\/\//.test(value||''),
    qdpScanDates_:fields=>({start:new Date(fields.StartDate+'T'+fields.StartTime+':00Z'),end:new Date(fields.EndDate+'T'+fields.EndTime+':00Z')}),
    qdpInboxFlyer_:()=>({url:'https://drive.google.com/uc?id=owned-flyer'}),
    qdpResolveEventIds_:()=>({venue:'V-001',artists:['A-001'],colls:[],party:''}),detectIdsByKeywords_:()=>({venue:'V-001'}),parseIdsFromDescription_:()=>({}),
    qviDraft_:v=>{const stamp=(day,time)=>new Date((day instanceof Date?day.toISOString().slice(0,10):day)+'T'+(time instanceof Date?time.toISOString().slice(11,19):time.length===5?time+':00':time)+'Z');return {...v,start:stamp(v.startDate,v.startTime),end:stamp(v.endDate,v.endTime),artists:Array.isArray(v.artists)?v.artists:[v.artists],colls:Array.isArray(v.colls)?v.colls:[]};},
    qviValidateIds_:()=>{},qviEventId_:(draft,existing)=>{let id='EVENT-121999',n=0;while(existing.ids.has(id))id='EVENT-'+(++n);existing.ids.add(id);return id;},
    qviHash_:hash,qviApplyDerived_:()=>{},qdpAdminRevision_:hash,normalizeKey_:s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,''),stripIdentityEmojis_:s=>s,stripAllQdpMetadata_:s=>s,
    qviDate_:v=>v instanceof Date?v.toISOString().slice(0,10):v,qviTime_:v=>v instanceof Date?v.toISOString().slice(11,19):v,qviWall_:(d,t)=>new Date(d+'T'+t+(t.length===5?':00':'')+'Z'),
    eventIdForApi_:s=>s,Utilities:{formatDate:(d,z,p)=>p==='yyyy-MM-dd'?d.toISOString().slice(0,10):d.toISOString()},
    qdpApifyCorrectionTime_:s=>s,qdpApifyCorrectionReadCalendar_:id=>structuredClone(calendar.get(id)),qdpApifyCorrectionCheckRange_:(start,end)=>{if(Date.parse(end)<=Date.parse(start))throw new Error('Invalid range');},
    sheetValuesEqual_:(a,b)=>a instanceof Date&&b instanceof Date?+a===+b:a===b,qdpApplyEventSaveRules_:row=>({row}),
    qviSetRow_:(sh,n,row,original)=>{if(JSON.stringify(rows[n-2])!==JSON.stringify(original))throw new Error('The row changed');rows[n-2]=row.slice();calls.writes++;},
    qviCalendarBody_:(draft,row,col,lookups,id)=>({id,summary:draft.title,description:draft.description,start:{dateTime:draft.start.toISOString()},end:{dateTime:draft.end.toISOString()},extendedProperties:{private:{qdpEventId:read(row,col,'eventId'),qdpSpreadsheet:ss.getId()}}}),
    qviOwnCalendarEvent_:(event,body)=>{assert.equal(event.extendedProperties?.private.qdpEventId,body.extendedProperties.private.qdpEventId);assert.equal(event.extendedProperties?.private.qdpSpreadsheet,body.extendedProperties.private.qdpSpreadsheet);return event;},
    qviCreateCalendar_:body=>{if(calendar.has(body.id))return{event:calendar.get(body.id),recovered:true};calls.inserts++;calendar.set(body.id,{...body,etag:'etag'});if(loseResponse){loseResponse=false;throw new Error('Lost response after Calendar insert');}return{event:calendar.get(body.id),recovered:false};},
    Calendar:{Events:{list:()=>{calls.lists++;return{items:[]};},get:(cal,id)=>{if(!calendar.has(id))throw new Error('404 not found');return structuredClone(calendar.get(id));},patch:(patch,cal,id,options,conditions)=>{calls.patches++;const event=calendar.get(id);if(event.etag!==conditions['If-Match'])throw new Error('412');Object.assign(event,patch);}}},
    ScriptApp:{getOAuthToken:()=> 'fixture-only'},
    UrlFetchApp:{fetchAll:requests=>{calls.calendarBatches++;return requests.map(request=>{const body=JSON.parse(request.payload);assert.match(request.url,/^https:\/\/www.googleapis.com\/calendar\/v3\/calendars\/fixture\/events\?sendUpdates=none$/);assert.equal(request.followRedirects,false);if(calendar.has(body.id))return{getResponseCode:()=>409,getContentText:()=>JSON.stringify({error:{message:'exists'}})};calls.inserts++;calendar.set(body.id,{...body,etag:'etag'});if(loseResponse){loseResponse=false;throw new Error('Lost response after Calendar insert');}return{getResponseCode:()=>200,getContentText:()=>JSON.stringify(calendar.get(body.id))};});}},
    Sheets:{Spreadsheets:{batchUpdate:body=>{calls.writes++;for(const r of body.requests){if(r.appendCells){calls.appends++;for(const row of r.appendCells.rows)rows.push(row.values.map(v=>v.raw));}if(r.updateCells){const start=r.updateCells.start;r.updateCells.rows.forEach((row,i)=>row.values.forEach((value,j)=>{rows[start.rowIndex-1+i][start.columnIndex+j]=value.raw;}));}}}}}
  });
  vm.runInContext(gs,context);
  context.qdpInboxFlyer_=()=>{calls.downloads++;return{url:'https://drive.google.com/uc?id=owned-flyer'};};
  context.qdpInboxCell_=(header,value)=>({raw:value});context.qdpInboxReceipts_=()=>({sheet:receiptSheet,rows:receipts});
  return {context,rows,c,calendar,calls,table,loseNextResponse(){loseResponse=true;}};
}
const proposal=id=>({id:id.repeat(64),kind:'event',fields:{'Title (internal)':'Fixture party',StartDate:'2099-12-19',StartTime:'21:00',EndDate:'2099-12-20',EndTime:'02:00',Timezone:'America/New_York',Description:'Copy',Location:'Fixture venue',Lineup_Raw:'Named artist',RawFlyerURL:'https://images.example/flyer.jpg'}});
test('an interrupted Google import reuses its saved Events row and Calendar retry identity',()=>{
  const f=fixture();f.loseNextResponse();const first=f.context.qdpInboxImport_([proposal('a')]);assert.match(first.results[0].error,/response was not confirmed/);assert.equal(f.rows.length,1);assert.equal(f.rows[0][f.c.publish],'No');
  const retry=f.context.qdpInboxImport_([proposal('a')]);assert.equal(retry.results[0].error,undefined);assert.equal(f.rows.length,1);assert.equal(f.calls.inserts,1);assert.equal(f.rows[0][f.c.publish],'Yes');
});
test('different proposal IDs for the same event in a batch cannot create duplicate Calendar entries',()=>{
  const f=fixture(),r=f.context.qdpInboxImport_([proposal('a'),proposal('b')]);assert.equal(f.rows.length,1);assert.equal(f.calls.inserts,1);assert.equal(r.results.filter(x=>x.error).length,1);
});
test('a retry cannot silently discard edited proposal fields after the Events draft was saved',()=>{
  const f=fixture();f.loseNextResponse();f.context.qdpInboxImport_([proposal('a')]);const changed=proposal('a');changed.fields.Description='Changed after partial import';
  const result=f.context.qdpInboxImport_([changed]);assert.match(result.results[0].error,/different saved fields/);assert.equal(result.results[0].sheetSaved,true);assert.equal(f.calls.inserts,1);assert.equal(f.rows[0][f.c.description],'Copy');
});
test('a correction refuses stale evidence before changing Sheets or Calendar',()=>{
  const f=fixture();f.context.qdpInboxImport_([proposal('a')]);const row=f.rows[0],before=f.context.qdpInboxEvent_(f.table(),row),saved=row[f.c.description];
  const item={id:'b'.repeat(64),kind:'correction',eventId:before.eventId,changes:{description:'New'},baseline:{...before,fields:{...before.fields,description:'Stale'}}};
  assert.throws(()=>f.context.qdpInboxCorrect_(item,f.table()),/changed since review/);assert.equal(f.rows[0][f.c.description],saved);assert.equal(f.calls.patches,0);
});
test('lineup-only corrections update the sheet without Calendar reads or writes and retry safely',()=>{
  const f=fixture();f.context.qdpInboxImport_([proposal('a')]);const before=f.context.qdpInboxEvent_(f.table(),f.rows[0]);f.context.qdpApifyCorrectionReadCalendar_=()=>{throw new Error('Lineup must not access Calendar');};
  const item={id:'c'.repeat(64),kind:'correction',eventId:before.eventId,changes:{lineup:'New named artist'},baseline:before};
  f.context.qdpInboxCorrect_(item,f.table());f.context.qdpInboxCorrect_(item,f.table());assert.equal(f.rows[0][headers.indexOf('Lineup_Raw')],'New named artist');assert.equal(f.calls.patches,0);
});
test('a Calendar correction failure retains the confirmed sheet receipt and recovers on retry',()=>{
  const f=fixture();f.context.qdpInboxImport_([proposal('a')]);const before=f.context.qdpInboxEvent_(f.table(),f.rows[0],f.calendar);
  const item={id:'d'.repeat(64),kind:'correction',eventId:before.eventId,changes:{description:'Revised copy'},baseline:before};
  const patch=f.context.Calendar.Events.patch;f.context.Calendar.Events.patch=()=>{throw new Error('Calendar unavailable');};
  const result=f.context.qdpInboxCorrect_(item,f.table());assert.equal(result.sheetSaved,true);assert.match(result.error,/Calendar unavailable/);assert.equal(f.rows[0][f.c.description],'Revised copy');
  f.context.Calendar.Events.patch=patch;const retry=f.context.qdpInboxCorrect_(item,f.table());assert.equal(retry.error,undefined);assert.equal(f.calendar.get(before.calendarId).description,'Revised copy');
});

test('all event rows are appended before Calendar creation, with twenty rows and two parallel groups',()=>{
  const f=fixture(),items=Array.from({length:20},(_,i)=>({...proposal('a'),id:(i+1).toString(16).padStart(64,'0'),fields:{...proposal('a').fields,'Title (internal)':'Party '+i}}));
  const sheet=f.context.qdpInboxImport_(items,'sheet');
  assert.equal(sheet.results.length,20);assert.equal(f.rows.length,20);assert.equal(f.calls.appends,1);assert.equal(f.calls.calendarBatches,0);assert.equal(f.calls.inserts,0);assert.equal(f.calls.lists,1);
  assert.ok(sheet.results.every(result=>result.sheetSaved&&result.needsCalendar));assert.ok(f.rows.every(row=>row[f.c.publish]==='No'));
  const calendar=f.context.qdpInboxImport_(items,'calendar');
  assert.ok(calendar.results.every(result=>result.calendarCreated&&!result.needsCalendar&&!result.error));
  assert.equal(f.calls.calendarBatches,2);assert.equal(f.calls.inserts,20);assert.equal(f.calls.writes,2);assert.ok(f.rows.every(row=>row[f.c.calUpdated]===''&&row[f.c.publish]==='Yes'));
});
test('events without flyers bypass Drive and keep their essential validation',()=>{
  const f=fixture(),item=proposal('a');item.fields.RawFlyerURL='';item.fields.Flyer_URL='';
  f.context.qdpInboxFlyer_=()=>{throw new Error('A missing flyer must not access Drive');};
  const saved=f.context.qdpInboxImport_([item]);assert.equal(saved.results[0].error,undefined);assert.equal(f.rows[0][f.c.flyer],'');assert.equal(f.calls.inserts,1);
  const incomplete=proposal('b');incomplete.fields['Title (internal)']='Another party';incomplete.fields.Lineup_Raw='TBA';assert.equal(f.context.qdpInboxImport_([incomplete]).results[0].error,undefined);
});
test('an unavailable supplied flyer becomes an explicit warning and does not block the event',()=>{
  const f=fixture();f.context.qdpInboxFlyer_=()=>{throw new Error('Image download returned HTTP 403');};
  const saved=f.context.qdpInboxImport_([proposal('a')]);assert.equal(saved.results[0].error,undefined);assert.match(saved.results[0].warning,/without a flyer.*403/);assert.equal(f.rows[0][f.c.flyer],'');assert.equal(f.calls.inserts,1);
});
test('lost Calendar acknowledgements are linked to the original draft before the final Pull',()=>{
  const f=fixture();f.loseNextResponse();f.context.qdpInboxImport_([proposal('a')]);assert.equal(f.rows[0][f.c.calId],'');assert.equal(f.calendar.size,1);
  const order=[];f.context.pullCalendarToSheet_Full=()=>{order.push('pull');assert.equal(f.rows[0][f.c.calId],[...f.calendar.keys()][0]);assert.equal(f.rows[0][f.c.publish],'No');};
  f.context.qdpLivePublish=()=>{order.push('live');};f.context.qdpArchivePublish=()=>{order.push('archive');};
  f.context.qdpInboxAdmin_({action:'admin.discovery.publish'});assert.deepEqual(order,['pull','live','archive']);assert.equal(f.rows.length,1);assert.equal(f.calls.inserts,1);
  const retry=f.context.qdpInboxImport_([proposal('a')],'calendar');assert.equal(retry.results[0].error,undefined);assert.equal(f.calls.inserts,1);assert.equal(f.rows[0][f.c.publish],'Yes');
});
test('a Calendar-only phase cannot create a new Events row and capabilities perform no writes',()=>{
  const f=fixture();const capability=f.context.qdpInboxAdmin_({action:'admin.discovery.import',phase:'capabilities',items:[]});assert.equal(capability.importVersion,2);assert.equal(f.calls.writes,0);
  const result=f.context.qdpInboxImport_([proposal('a')],'calendar');assert.match(result.results[0].error,/draft is missing/);assert.equal(f.rows.length,0);assert.equal(f.calls.inserts,0);
});
test('owner-approved Title and date/times import with every optional event field blank',()=>{
 const f=fixture(),item=proposal('a');
 for(const field of ['Location','Lineup_Raw','Description','RawFlyerURL','Flyer_URL'])item.fields[field]='';
 f.context.qdpResolveEventIds_=()=>({venue:'',artists:[],colls:[],party:''});
 const result=f.context.qdpInboxImport_([item]);assert.equal(result.results[0].error,undefined);assert.equal(f.calls.inserts,1);
 assert.equal(f.rows[0][f.c.location],'');assert.equal(f.rows[0][f.c.description],'');assert.equal(f.rows[0][f.c.artists],'');
 assert.equal(f.rows[0][f.c.venue],'');assert.equal(f.rows[0][headers.indexOf('Lineup_Raw')],'');
});
test('each missing essential field is rejected before any Sheet, Drive or Calendar write',()=>{
 for(const key of ['Title (internal)','StartDate','StartTime','EndDate','EndTime']) {
  const f=fixture(),item=proposal('a');item.fields[key]='';
  assert.match(f.context.qdpInboxImport_([item]).results[0].error,/Title.*start date\/time.*end date\/time/);
  assert.equal(f.calls.inserts,0);assert.equal(f.calls.writes,0);assert.equal(f.calls.downloads,0);
 }
});
test('invalid date/time ranges fail per item without blocking another valid selection',()=>{
 const f=fixture(),bad=proposal('a'),good=proposal('b');bad.fields.StartTime='not a time';good.fields['Title (internal)']='Valid party';
 const result=f.context.qdpInboxImport_([bad,good]);assert.match(result.results.find(r=>r.id===bad.id).error,/valid start and end/);
 assert.equal(result.results.find(r=>r.id===good.id).error,undefined);assert.equal(f.calls.inserts,1);
});
test('owner-approved description content is not an additional required-field gate',()=>{
 const f=fixture(),item=proposal('a');item.fields.Description='Owner copy with https://example.com';item.fields.Location='';item.fields.Lineup_Raw='';
 assert.equal(f.context.qdpInboxImport_([item]).results[0].error,undefined);assert.equal(f.calls.inserts,1);
 assert.equal(f.context.qdpInboxAdmin_({action:'admin.discovery.import',phase:'capabilities'}).optionalDetails,true);
});
