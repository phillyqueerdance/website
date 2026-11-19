import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const client=fs.readFileSync(new URL('../admin/admin.js',import.meta.url),'utf8');
function fn(name) {
  const start=client.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start>=0,name);
  const rest=client.slice(start);
  const end=rest.slice(1).search(/\n(?:async )?function /);
  return end<0?rest.slice(0,rest.lastIndexOf('\n}')+2):rest.slice(0,end+1);
}
const plain=value=>JSON.parse(JSON.stringify(value));
function setup(){
 const events=Array.from({length:3},(_,i)=>({eventId:`E${i}`,publicTitle:`Event ${i}`,description:'Original',artistIds:['KNOWN','UNRESOLVED'],venueId:'V',publishToWeb:true,explicitQueer:false,revision:`r${i}`,inSyncWindow:true}));
 const state={events,drafts:new Map(),cards:new Map(),capabilities:{bulkSave:true},busy:false,refreshing:false,referencesVersion:'refs'};
 const requests=[],messages=[],timers=[];
 const context=vm.createContext({state,Map,Set,TextEncoder,Date,console,
  elements:{syncProgress:{},saveAllButton:{}},
  setTimeout(fn){timers.push(fn);return timers.length;},clearTimeout(){},
  renderEvents(){},renderStatus(){},updateGlobalControls(){},updateStatusFromEvents(){},updateCardState(){},compareEvents:(a,b)=>a.eventId.localeCompare(b.eventId),
  showToast(message){messages.push(message);},setBusy(value){state.busy=value;},
  window:{confirm:()=>true},adminRequest:async(action,body)=>{requests.push({action,body});throw Error('Not configured');}});
 vm.runInContext(client.match(/^const EVENT_LOCATION_FIELDS = .+;$/m)[0],context);
 for(const name of ['baseDraft','draftFor','sameIds','draftIsDirty','draftMatchesEvent','eventSavePayload','saveAllChanges','saveChangedEvents','applySavedEvents','applySavedEvent','applyDashboard'])vm.runInContext(fn(name),context);
 for(const event of events)state.drafts.set(event.eventId,{...context.baseDraft(event),description:`Edit ${event.eventId}`});
 return {context,state,events,requests,messages,timers};
}
test('Save all sends every draft, including filtered events, in exactly one request',async()=>{
 const h=setup();h.context.adminRequest=async(action,body)=>{h.requests.push({action,body});return {events:body.changes.map(change=>({...h.events.find(e=>e.eventId===change.eventId),...change,revision:'new-'+change.eventId}))};};
 await h.context.saveAllChanges();
 assert.equal(h.requests.length,1);assert.equal(h.requests[0].action,'admin.savebatch');
 assert.equal(h.requests[0].body.changes.length,3);assert.equal(h.state.drafts.size,0);
 assert.equal(h.state.busy,false);assert.deepEqual(plain(h.requests[0].body.changes[0].artistIds),['KNOWN','UNRESOLVED']);
});
test('bulk conflict keeps every draft and its original revision without retrying writes',async()=>{
 const h=setup();h.context.adminRequest=async(action,body)=>{h.requests.push({action,body});throw Error('Nothing was saved. E1: Changed since you started editing.');};
 await h.context.saveAllChanges();assert.equal(h.requests.length,1);assert.equal(h.state.drafts.size,3);assert.equal(h.state.busy,false);
 assert.equal(h.state.drafts.get('E1').expectedRevision,'r1');assert.match(h.messages.at(-1),/Nothing was saved/);
});
test('a legacy single-save dashboard is accepted directly and another draft survives',()=>{
 const h=setup();const updated={...h.events[0],description:'Saved',revision:'new'};
 h.context.applySavedEvent({events:[updated,h.events[1],h.events[2]]},'E0');
 assert.equal(h.state.events[0].revision,'new');assert.equal(h.state.drafts.has('E0'),false);assert.equal(h.state.drafts.size,2);
});
test('an incomplete batch confirmation cannot clear some drafts or partially update the page',()=>{
 const h=setup();assert.throws(()=>h.context.applySavedEvents({events:[{...h.events[0],revision:'new'}]},['E0','E1']),/invalid confirmation/);
 assert.equal(h.state.drafts.size,3);assert.equal(h.state.events[0].revision,'r0');
});
test('network interruption reconciles with one read and never writes a second time',async()=>{
 const h=setup();h.context.adminRequest=async(action,body)=>{
  h.requests.push({action,body});if(action==='admin.savebatch')throw Error('Network response interrupted');
  return {events:h.events.map(e=>({...e,...h.state.drafts.get(e.eventId),revision:'confirmed'}))};
 };
 await h.context.saveAllChanges();assert.deepEqual(h.requests.map(r=>r.action),['admin.savebatch','admin.bootstrap']);assert.equal(h.state.drafts.size,0);
});
test('older Apps Script deployments get an actionable bulk message and no bulk request',async()=>{
 const h=setup();h.state.capabilities={};await h.context.saveAllChanges();assert.equal(h.requests.length,0);assert.equal(h.state.drafts.size,3);assert.match(h.messages.at(-1),/updated Apps Script/);
});
test('sync refresh preserves drafts and stale revisions, while unchanged editable fields can rebase',()=>{
 const h=setup();h.state.artists=[{id:'A'}];h.state.venues=[{id:'V'}];h.state.artistById=new Map();h.state.venueById=new Map();
 const fresh=h.events.map(e=>({...e,revision:'after-sync'}));fresh[1].description='Changed by Calendar';
 h.context.applyDashboard({events:fresh,status:{},referencesVersion:'refs',capabilities:{bulkSave:true}},{preserveDrafts:true});
 assert.equal(h.state.drafts.get('E0').expectedRevision,'after-sync');assert.equal(h.state.drafts.get('E1').expectedRevision,'r1');
 assert.equal(h.state.drafts.get('E1').description,'Edit E1');assert.equal(h.state.artists[0].id,'A');
});
test('an event removed during sync retains its unsaved draft for review',()=>{
 const h=setup();h.context.applyDashboard({events:h.events.slice(1),status:{}},{preserveDrafts:true});
 assert.equal(h.state.drafts.get('E0').description,'Edit E0');assert.equal(h.state.events.find(e=>e.eventId==='E0').removedFromSheet,true);
});

test('refresh reuses unchanged event cards and invalidates cards with changed records or discarded drafts',()=>{
 const h=setup();h.state.drafts.clear();
 const original=h.events[0],card={event:original,card:{}};
 h.state.cards.set('E0',card);
 const refresh=()=>h.context.applyDashboard({events:h.events.map(e=>({...e})),capabilities:{bulkSave:true}});
 refresh();assert.equal(h.state.events[0],original);assert.equal(h.state.cards.get('E0'),card);
 h.state.drafts.set('E0',{...h.context.baseDraft(original),description:'Discarded edit'});
 refresh();assert.equal(h.state.cards.has('E0'),false);
});

test('refresh invalidates cards when reference data changes',()=>{
 const h=setup();h.state.drafts.clear();h.state.cards.set('E0',{event:h.events[0],card:{}});
 h.context.applyDashboard({events:h.events.map(e=>({...e})),capabilities:{bulkSave:true},references:{artists:[{id:'NEW',name:'New Artist'}]}});
 assert.equal(h.state.cards.size,0);
});
test('location-only drafts are included in Save all and clear only after confirmation',async()=>{
 const h=setup();h.state.drafts.clear();h.state.capabilities.eventLocations=true;
 const event=h.events[0];Object.assign(event,{venueId:'',location:'Original location',address:'',neighborhood:''});
 h.state.drafts.set(event.eventId,{...h.context.baseDraft(event),location:'New location',address:'123 Main St',neighborhood:'Center City'});
 h.context.adminRequest=async(action,body)=>{h.requests.push({action,body});return {events:body.changes.map(change=>({...event,...change,revision:'location-saved'}))};};
 await h.context.saveAllChanges();
 assert.equal(h.requests.length,1);assert.equal(h.requests[0].body.changes.length,1);
 assert.equal(h.requests[0].body.changes[0].location,'New location');
 assert.equal(h.requests[0].body.changes[0].address,'123 Main St');
 assert.equal(h.requests[0].body.changes[0].neighborhood,'Center City');
 assert.equal(h.state.drafts.size,0);assert.equal(h.state.events[0].location,'New location');
});

test('linked venues and older deployments never receive manual location fields',()=>{
 const h=setup();h.state.capabilities.eventLocations=true;
 assert.equal(Object.hasOwn(h.context.eventSavePayload(h.events[0]),'location'),false);
 h.events[0].venueId='';h.state.drafts.set('E0',h.context.baseDraft(h.events[0]));h.state.capabilities.eventLocations=false;
 assert.equal(Object.hasOwn(h.context.eventSavePayload(h.events[0]),'location'),false);
});

test('refresh cannot rebase a location draft over an external location change',()=>{
 const h=setup();h.state.drafts.clear();h.state.artists=[];h.state.venues=[];
 Object.assign(h.events[0],{venueId:'',location:'Old place'});
 h.state.drafts.set('E0',{...h.context.baseDraft(h.events[0]),location:'My edit'});
 const fresh=h.events.map(event=>({...event,revision:'refreshed'}));fresh[0].location='Someone else’s edit';
 h.context.applyDashboard({events:fresh,status:{},capabilities:{eventLocations:true}},{preserveDrafts:true});
 assert.equal(h.state.drafts.get('E0').expectedRevision,'r0');assert.equal(h.state.drafts.get('E0').location,'My edit');
});
