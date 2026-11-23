import {performanceAction,PERFORMANCE_ACTIONS} from '../functions/discovery-performance.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../admin/discovery.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const html = fs.readFileSync(new URL('../admin/discovery.html',import.meta.url),'utf8');
const workbook = fs.readFileSync(new URL('../admin/apify-workbook.js',import.meta.url),'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const candidate = (extra = {}) => ({id:'a'.repeat(64),kind:'event',title:'A night together',date:'2099-12-19',fields:{'Title (internal)':'A night together',StartDate:'2099-12-19',EndDate:'2099-12-20',StartTime:'22:00',EndTime:'02:00',Location:'A local dance floor',Description:'Current copy',Lineup_Raw:'Named DJ'},sourceUrl:'https://www.instagram.com/p/TestPost/',listingUrl:'',changes:{},selectedFields:[],decision:'WAIT',status:'pending',version:1,result:{},error:'',...extra});
const current = {eventId:'TEST-121999',title:'A night together',location:'A local dance floor',fields:{description:'Current QDP copy.',lineup:'Original DJ',start:'2099-12-20T03:00:00Z',end:'2099-12-20T07:00:00Z',flyer:''}};
const correction = (extra={}) => candidate({kind:'correction',eventId:current.eventId,listingUrl:'https://queerdancephilly.com/?event=TEST-121999',changes:{description:'Recommended new copy.',lineup:'Original DJ, New DJ'},baseline:{...current,fields:{...current.fields,description:'An older saved comparison.'}},...extra});
const gate = () => {let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
function setup(records=[candidate()],options={}) {
  class Element {
    constructor(tag='div') {this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.attributes={};this.dataset={};this._text='';this._value='';this.hidden=false;this.disabled=false;this.checked=false;this.className='';this.classList={add:name=>{this.className+=' '+name;}};}
    set textContent(value){this._text=String(value);this.children=[];}
    get textContent(){return this._text+this.children.map(child=>child.textContent||'').join('');}
    get text(){return this.textContent;}
    set value(value){this._value=String(value);}
    get value(){return this._value;}
    get options(){return this.children;}
    get selectedIndex(){return Math.max(0,this.children.findIndex(child=>child.value===this.value));}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this._text='';this.children=[...children];}
    setAttribute(name,value){this.attributes[name]=String(value);}
    addEventListener(name,listener){(this.listeners[name]||=[]).push(listener);}
    async emit(name){for(const listener of this.listeners[name]||[])await listener({preventDefault(){}});}
  }
  const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(match=>[match[1],new Element()]));
  const view=elements.get('view');
  for(const [value,text] of [['all','All pending'],['new','New'],['updated','Updated'],['waiting','Waiting'],['failed','Failed'],['excluded','Excluded'],['imported','Imported']]){const option=new Element('option');option.value=value;option.textContent=text;view.append(option);}view.value='all';
  const state={records:structuredClone(records),listings:[structuredClone(current)],...options},requests=[],downloads=[],timers=new Map();let timerId=0;
  const fetch=async(url,request)=>{
    const body=JSON.parse(request.body);requests.push(body);
    const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
    const pending=()=>state.records.filter(item=>item.decision!=='EXCLUDE'&&item.status!=='imported');
    if(body.action==='items'){
      if(state.itemsGate)await state.itemsGate.promise;
      if(state.failItems)return reply({error:'The inbox could not be reached.'},400);
      return reply({ok:'yes',items:pending().slice(body.offset||0,(body.offset||0)+(body.limit||25)),total:pending().length});
    }
    if(body.action==='bootstrap')return reply({ok:'yes',counts:{selected:pending().filter(item=>item.decision==='INCLUDE').length},runs:[],checkpoint:{value:{coverage:{captions:12,slides:24}}}});
    if(body.action==='listings'){
      if(state.listingsGate)await state.listingsGate.promise;
      if(state.failListings)return reply({error:'Google is temporarily unavailable.'},400);
      return reply({ok:'yes',events:state.listings});
    }
    if(body.action==='save'){
      if(state.saveGate)await state.saveGate.promise;
      if(state.failSave)return reply({error:'This proposal changed. Refresh before saving.'},400);
      const item=state.records.find(item=>item.id===body.id);
      if(item.version!==body.version)return reply({error:'Stale revision'},400);
      Object.assign(item,body,{version:item.version+1});return reply({ok:'yes',item});
    }
    if(body.action==='selected')return reply({ok:'yes',items:pending().filter(item=>item.decision==='INCLUDE').map(({id,version})=>({id,version}))});
    if(body.action==='import-options')return reply({ok:'yes',phased:!state.legacyImporter,batchSize:state.legacyImporter?5:20});
    if(body.action==='import'){
      if(state.importGate)await state.importGate.promise;
      return reply({ok:'yes',results:body.items.map(item=>{
        const saved=state.records.find(row=>row.id===item.id);saved.version++;saved.status=body.phase==='sheet'?'accepted':'ready';
        return{id:item.id,eventId:'FIXTURE',version:saved.version,sheetSaved:true,needsCalendar:body.phase==='sheet',needsPublish:body.phase!=='sheet'};
      })});
    }
    if(body.action==='publish'){for(const item of state.records)if(body.ids.includes(item.id))item.status='imported';return reply({ok:'yes',published:body.ids.length});}
    return reply({error:'Unknown fixture operation'},400);
  };
  const context=vm.createContext({URL,Map,Set,Intl,Date,JSON,Number,Object,String,Array,RegExp,Response,AbortController,console,fetch,location:{origin:'https://queerdancephilly.com'},
    document:{getElementById:id=>{assert.ok(elements.has(id),'Control exists in real HTML: '+id);return elements.get(id);},createElement:tag=>new Element(tag)},
    window:{addEventListener(){}},setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);},downloadReview:(...args)=>downloads.push(args)});
  vm.runInContext(workbook.match(/export const REVIEW_FIELDS = \[[\s\S]*?\n\];/)[0].replace('export ',''),context);
  vm.runInContext(source,context);
  const settle=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
  const walk=root=>root.children.flatMap(child=>[child,...walk(child)]);
  const find=predicate=>walk(elements.get('items')).filter(predicate);
  const button=label=>find(element=>element.tagName==='BUTTON'&&element.textContent===label)[0];
  const field=label=>find(element=>element.attributes['aria-label']===label)[0];
  const cardStatus=()=>find(element=>element.className==='discovery-save-status')[0];
  return {context,elements,state,requests,downloads,timers,settle,find,button,field,cardStatus,walk};
}
test('current and recommended fields load automatically in one read without saving approval',async()=>{
  const h=setup([correction(),correction({id:'b'.repeat(64),eventId:'SECOND'})]);await h.settle();
  assert.equal(h.requests.filter(request=>request.action==='listings').length,1);
  assert.equal(h.requests.filter(request=>request.action==='save').length,0);
  assert.ok(h.elements.get('items').textContent.includes('Current QDP copy.'));
  assert.equal(h.field('Proposed Description · A night together').value,'Recommended new copy.');
  assert.equal(h.state.records[0].baseline.fields.description,'An older saved comparison.');
  const media=h.find(element=>element.className==='apify-media')[0];
  assert.equal(media.children[0].textContent,'https://www.instagram.com/p/TestPost/');
  assert.match(media.children[1].textContent,/QDP listing/);
  assert.equal(h.elements.get('items').hidden,false);
});
test('Include, Wait and Exclude show immediate saving feedback, confirmed state and selection counts',async()=>{
  const hold=gate(),h=setup([candidate()],{saveGate:hold});await h.settle();
  const include=h.button('Include'),pending=include.emit('click');await h.settle();
  assert.equal(h.elements.get('toast').dataset.state,'busy');assert.match(h.elements.get('toast').textContent,/Saving Include/);assert.equal(include.disabled,true);
  hold.release();await pending;await h.settle();
  assert.equal(include.attributes['aria-pressed'],'true');assert.equal(include.dataset.decision,'INCLUDE');assert.equal(h.elements.get('selection').textContent,'1 selected');
  for(const decision of ['Wait','Exclude']){const button=h.button(decision);await button.emit('click');await h.settle();assert.equal(button.attributes['aria-pressed'],'true');assert.equal(h.elements.get('selection').textContent,'0 selected');assert.match(h.elements.get('toast').textContent,/saved/);}
  assert.deepEqual(h.requests.filter(request=>request.action==='save').map(request=>request.decision),['INCLUDE','WAIT','EXCLUDE']);
});
test('failed decisions cannot look confirmed and the persistent error names the failure',async()=>{
  const h=setup([candidate()],{failSave:true});await h.settle();await h.button('Include').emit('click');await h.settle();
  assert.equal(h.elements.get('toast').dataset.state,'error');assert.match(h.elements.get('toast').textContent,/Not saved.*changed/s);
  assert.equal(h.button('Include').attributes['aria-pressed'],'false');assert.equal(h.button('Wait').attributes['aria-pressed'],'true');assert.equal(h.state.records[0].decision,'WAIT');
});
test('typing during a save preserves newer input and retries with the confirmed revision',async()=>{
  const hold=gate(),h=setup([candidate()],{saveGate:hold});await h.settle();const input=h.field('Description · A night together');
  input.value='First edit';await input.emit('input');const pending=input.emit('change');await h.settle();
  input.value='Newer edit while saving';await input.emit('input');hold.release();await pending;await h.settle();
  assert.equal(input.value,'Newer edit while saving');assert.match(h.cardStatus().textContent,/newer edits/);
  await h.button('Save edits').emit('click');await h.settle();assert.equal(h.state.records[0].fields.Description,'Newer edit while saving');
  assert.deepEqual(h.requests.filter(request=>request.action==='save').map(request=>request.version),[1,2]);
});
test('Include waits for the comparison and changes the saved baseline only on approval',async()=>{
  const hold=gate(),h=setup([correction()],{listingsGate:hold});await h.settle();
  const apply=h.field('Apply Description · A night together');apply.checked=true;await apply.emit('change');await h.settle();
  assert.equal(h.state.records[0].baseline.fields.description,'An older saved comparison.');
  const pending=h.button('Include').emit('click');await h.settle();assert.match(h.elements.get('toast').textContent,/Loading the current QDP listing/);assert.equal(h.state.records[0].decision,'WAIT');
  hold.release();await pending;await h.settle();assert.equal(h.state.records[0].baseline.fields.description,'Current QDP copy.');
  assert.equal(h.requests.filter(request=>request.action==='listings').length,1);assert.equal(h.requests.some(request=>request.action==='import'),false);
});
test('a failed comparison is explicit and Wait remains available without Google',async()=>{
  const h=setup([correction()],{failListings:true});await h.settle();
  assert.match(h.elements.get('items').textContent,/Google is temporarily unavailable/);
  await h.button('Wait').emit('click');await h.settle();assert.match(h.cardStatus().textContent,/Waiting · saved/);
  await h.button('Refresh comparison').emit('click');await h.settle();assert.equal(h.elements.get('toast').dataset.state,'error');assert.match(h.elements.get('toast').textContent,/Comparison refresh failed/);
});
test('Add selected shows progress before import and refreshes QDP once per selection',async()=>{
  const hold=gate(),h=setup([candidate({decision:'INCLUDE'})],{importGate:hold});await h.settle();
  const pending=h.elements.get('add').emit('click');await h.settle();assert.match(h.elements.get('toast').textContent,/Saving event rows:/);assert.equal(h.elements.get('add').attributes['aria-busy'],'true');assert.equal(h.elements.get('add').disabled,true);
  hold.release();await pending;await h.settle();assert.equal(h.requests.filter(request=>request.action==='publish').length,1);assert.match(h.elements.get('toast').textContent,/1 item\(s\) completed/);
});
test('forty-one selections finish every Sheet batch before Calendar batches and publish only once',async()=>{
  const records=Array.from({length:41},(_,i)=>candidate({id:(i+1).toString(16).padStart(64,'0'),decision:'INCLUDE'})),h=setup(records);await h.settle();
  await h.elements.get('add').emit('click');await h.settle();
  const imports=h.requests.filter(request=>request.action==='import');assert.deepEqual(imports.map(request=>request.phase),['sheet','sheet','sheet','calendar','calendar','calendar']);assert.deepEqual(imports.map(request=>request.items.length),[20,20,1,20,20,1]);
  assert.ok(imports.slice(3).every(request=>request.items.every(item=>item.version===2)));assert.equal(h.requests.filter(request=>request.action==='publish').length,1);assert.match(h.elements.get('toast').textContent,/41 item\(s\) completed/);
});
test('Review notes remain visible above the Links and IDs disclosure',async()=>{
  const h=setup();await h.settle();const editor=h.find(element=>element.className==='apify-editor')[0];
  const noteIndex=editor.children.findIndex(element=>element.textContent.includes('Review notes')),detailsIndex=editor.children.findIndex(element=>element.tagName==='DETAILS');
  assert.ok(noteIndex>=0&&noteIndex<detailsIndex);assert.equal(editor.children[detailsIndex].children[0].textContent,'Links & IDs');assert.equal(h.walk(editor.children[detailsIndex]).some(element=>element.textContent==='Review notes'),false);
  assert.ok(html.indexOf('id="selection"')<html.indexOf('Back to Admin'));assert.ok(html.indexOf('id="add"')<html.indexOf('Back to Admin'));assert.equal(html.includes('<footer'),false);
});
test('the updated client can finish imports while the older Apps Script is still installed',async()=>{
  const h=setup([candidate({decision:'INCLUDE'})],{legacyImporter:true});await h.settle();await h.elements.get('add').emit('click');await h.settle();
  const imports=h.requests.filter(request=>request.action==='import');assert.equal(imports.length,1);assert.equal(imports[0].phase,undefined);assert.equal(h.requests.filter(request=>request.action==='publish').length,1);
});
test('Refresh and Excel show progress, success and restored controls',async()=>{
  const h=setup();await h.settle();const hold=gate();h.state.itemsGate=hold;
  const pending=h.elements.get('refresh').emit('click');await h.settle();assert.equal(h.elements.get('refresh').attributes['aria-busy'],'true');assert.match(h.elements.get('toast').textContent,/Refreshing/);
  hold.release();await pending;await h.settle();assert.equal(h.elements.get('toast').textContent,'Inbox refreshed.');
  await h.elements.get('export').emit('click');await h.settle();assert.equal(h.downloads.length,1);assert.match(h.elements.get('toast').textContent,/download has started/);assert.equal(h.elements.get('export').disabled,false);
});
test('automatic listing reads filter requested events without writing or reconciling decisions',async()=>{
  const source=fs.readFileSync(new URL('../functions/discovery-api.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export async function discoveryRequest','async function discoveryRequest');
  const calls=[],context=vm.createContext({performanceAction,PERFORMANCE_ACTIONS,Response,Request,URL,Map,Set,JSON,TextDecoder,Uint8Array,console,
    verifyAccess:async()=>({email:'fixture'}),requestAppsScriptAdmin:async(env,body)=>{calls.push(body);return {ok:'yes',events:[current,{...current,eventId:'OTHER'}],legacyDecisions:[{alias:'must-not-be-reconciled'}]};},
    database:()=>({prepare(){throw new Error('A comparison must not read or write D1');}})});
  vm.runInContext(source,context);
  const result=await context.discoveryRequest({env:{},request:new Request('https://queerdancephilly.com/admin/discovery',{method:'POST',headers:{Origin:'https://queerdancephilly.com','Content-Type':'application/json'},body:JSON.stringify({action:'listings',eventIds:['test-121999']})})});
  const body=await result.json();assert.equal(result.status,200);assert.deepEqual(body.events.map(event=>event.eventId),['TEST-121999']);assert.equal(calls.length,1);assert.equal(calls[0].action,'admin.discovery.snapshot');
});
