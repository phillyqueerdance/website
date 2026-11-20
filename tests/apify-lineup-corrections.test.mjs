import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {setup,event} from './helpers/archive-fixture.mjs';
const test=(name,fn)=>nodeTest(name,{skip:!process.env.QDP_CORE_SOURCE&&'Set QDP_CORE_SOURCE to the supplied Core.gs'},fn);

function fixture(){
 const h=setup({active:[event('ONE','Original description')]});
 const c=h.c;
 c.qdpScanNormalize_=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');
 c.qdpScanMap_=(sheet,names)=>Object.fromEntries(names.map(name=>[name,sheet.rows[0].indexOf(name)+1]));
 c.qdpAdminApifyCell_=(_,value)=>({userEnteredValue:{stringValue:String(value)}});
 h.ss.getSpreadsheetTimeZone=()=> 'America/New_York';
 return h;
}
test('lineup correction stages only its selected field on the existing EventID',()=>{
 const h=fixture();const headers=['EventID','Title (internal)','Review','Import readiness','Lineup_Raw','Review_notes','ImportSourceSnapshot','ImportSourceKey','Event_URL','Instagram_URL'];
 const sheet=h.ss.insertSheet('Apify Import');sheet.rows=[headers];
 const result=h.c.qdpApifyCorrectionStage_({key:'a'.repeat(64)+':2',eventId:'ONE',title:'Night ONE',changes:{lineup:'Artist One; Artist Two'}});
 assert.equal(result.alreadySaved,false);const row=Object.fromEntries(headers.map((name,i)=>[name,sheet.rows[1][i]]));
 assert.equal(row.EventID,'ONE');assert.equal(row.Lineup_Raw,'Artist One; Artist Two');assert.equal(row.Review,'Correction');
 assert.deepEqual(JSON.parse(row.ImportSourceSnapshot).changes,{lineup:'Artist One; Artist Two'});
 assert.equal(h.sheets.get('Events').rows[1][6],'Original description');
 assert.throws(()=>h.c.qdpApifyCorrectionStage_({key:'b'.repeat(64)+':2',eventId:'ONE',title:'Night ONE',changes:{lineup:''}}),/confirmed lineup/);
});
test('lineup decoding never treats a lineup as schedule or flyer data',()=>{
 const h=fixture();const table={headers:['Lineup_Raw']};
 const changes=h.c.qdpApifyCorrectionChanges_(table,{row:['Artist One; Artist Two'],snapshot:{changes:{lineup:'original proposal'}}},'America/New_York');
 assert.deepEqual(h.plain(changes),{lineup:'Artist One; Artist Two'});
});
test('applying a lineup-only correction preserves description and never reads Calendar',()=>{
 const h=fixture(),c=h.c,sheet=h.sheets.get('Events');
 sheet.rows[0].push('Lineup_Raw');sheet.rows[1].push('Old Artist');
 const table={sheet,headers:sheet.rows[0],rows:sheet.rows.slice(1)};
 const intakeSheet=h.ss.insertSheet('Apify Import');
 intakeSheet.rows=[['Review','Lineup_Raw','ImportSourceSnapshot','Import_result'],['Correction','New Artist','','']];
 const intake={sheet:intakeSheet,headers:intakeSheet.rows[0]};
 const entry={row:intakeSheet.rows[1].slice(),rowNumber:2,rowEventId:'ONE',eventId:'ONE',snapshot:{changes:{lineup:'New Artist'}}};
 const original=sheet.rows[1].slice();
 c.qdpEnsureEventEditState_=()=>{};c.qdpPublicReadContext_=()=>({});c.qdpPublicSheet_=()=>table;
 c.buildLookupMaps_=()=>({});c.qdpApifyCorrectionConfirmRows_=()=>{};
 c.qdpApifyCorrectionReadCalendar_=()=>{throw new Error('Lineup-only changes must not read Calendar');};
 c.qdpApplyEventSaveRules_=(row,headers,lookups,options)=>{
   assert.deepEqual(h.plain(options.touched),[headers.indexOf('Lineup_Raw')+1]);
   return {updates:new Map([[headers.indexOf('Lineup_Raw')+1,row.at(-1)]])};
 };
 const result=c.qdpApifyCorrectionApplyEvent_(h.ss,intake,[entry],[]);
 assert.equal(result.applied,1);assert.equal(result.pending,0);
 assert.deepEqual(sheet.rows[1].slice(0,-1),original.slice(0,-1));assert.equal(sheet.rows[1].at(-1),'New Artist');
});
