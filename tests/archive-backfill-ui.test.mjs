import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../admin/archive-backfill.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../admin/archive-backfill.html',import.meta.url),'utf8');
function setup({failSave=false,ingestErrors=[]}={}){
  class Element {
    constructor(tag='div'){this.tag=tag;this.children=[];this.listeners={};this.value='';this.attributes={};this.checked=false;this.disabled=false;this.textContent='';this.files=[];}
    append(...children){this.children.push(...children);}replaceChildren(...children){this.children=[];this.append(...children);}
    setAttribute(k,v){this.attributes[k]=v;}toggleAttribute(k,v){if(v)this.attributes[k]='';else delete this.attributes[k];}
    addEventListener(n,f){(this.listeners[n]||=[]).push(f);}async emit(n,event={}){for(const f of this.listeners[n]||[])await f({preventDefault(){},...event});}
    click(){}get childNodes(){return this.children;}
  }
  const elements=new Map([...html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bid="([^"]+)"/g)].map(m=>[m[2],new Element(m[1])]));
  const all=root=>root.children.flatMap(child=>[child,...all(child)]),requests=[],timers=[];
  const target={sheet:'Archive 2025',eventId:'ONE',revision:'event-r1',title:'Current event title',fields:[
    {key:'Title (internal)',label:'Title',value:'Current event title'},
    {key:'Description',label:'Description',value:'Existing description'},
    {key:'Flyer_URL',label:'Flyer',value:'https://images.example/current.jpg'}
  ]};
  const item={key:'candidate:one',revision:'r1',runId:'2025',fields:{'Title (internal)':'Proposed event title',Description:''},state:'pending',selectedFields:[],draftDescription:'',visual:{status:'inspected'},evidence:{notes:'Same date, venue and lineup'},sources:[{key:'ig:12345',account:'example',url:'https://www.instagram.com/p/Example/',caption:'Original caption',media:[{id:'12345',order:1,url:'https://images.example/source.jpg',savedUrl:''}]}],matches:[{sheet:target.sheet,eventId:'ONE',title:'Current event title',date:'2025-03-01',reasons:['Same event date','Same venue'],conflicts:[]}]};
  const response=()=>({items:[structuredClone(item)],offset:0,pageSize:10,total:1,summary:{[item.state]:1},sourceCount:1,runs:[],descriptionRequests:0});
  const message=(n,t,e=false)=>{n.textContent=t;n.toggleAttribute('data-error',e);};
  const context=vm.createContext({URL,Blob,Map,Set,JSON,Object,Array,String,Number,Math,structuredClone,clearTimeout(){},setTimeout:(fn,delay)=>{timers.push({fn,delay});return timers.length;},
    document:{getElementById:id=>{assert.ok(elements.has(id),'HTML control exists: '+id);return elements.get(id);},createElement:tag=>new Element(tag),querySelectorAll:()=>[...elements.values(),...all(elements.get('backfillItems'))].filter(n=>['button','input','textarea','select'].includes(n.tag))},
    window:{location:{origin:'https://qdp.example'},addEventListener(){},QDPAdminProfiles:{message,request:async(action,data={})=>{
      requests.push({action,data:JSON.parse(JSON.stringify(data))});
      if(action==='admin.backfill.bootstrap')return response();
      if(action==='admin.archive.event.read')return {event:structuredClone(target)};
      if(action==='admin.backfill.save'){
        if(failSave)throw new Error('Network interrupted');
        item.state=data.state;item.selectedFields=data.selectedFields;item.target=structuredClone(target);item.revision='r2';return {revision:'r2'};
      }
      if(action==='admin.backfill.media')return {url:'https://images.example/verified.jpg'};
      if(action==='admin.backfill.apply'){item.state='applied';return {changedCells:1};}
      if(action==='admin.backfill.ingest'){const error=ingestErrors.shift();if(error)throw error;return {};}
      return {};
    }}}
  });
  vm.runInContext(source,context);
  const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
  const find=(fn)=>all(elements.get('backfillItems')).filter(fn);
  const button=text=>find(n=>n.tag==='button'&&n.textContent===text)[0];
  const match=()=>find(n=>n.tag==='button'&&n.className==='backfill-match')[0];
  const choices=()=>find(n=>n.tag==='input'&&n.type==='checkbox');
  return {elements,requests,timers,find,button,match,choices,settle};
}
test('initial visual review never writes and keeps field approvals unchecked',async()=>{
  const h=setup();await h.settle();assert.deepEqual(h.requests.map(r=>r.action),['admin.backfill.bootstrap']);
  assert.equal(h.find(n=>n.tag==='img')[0].src,'/admin/flyer?url=https%3A%2F%2Fimages.example%2Fsource.jpg');
  await h.match().emit('click');assert.ok(h.choices().every(c=>!c.checked));assert.equal(h.requests.at(-1).action,'admin.archive.event.read');
  assert.equal(h.find(n=>n.tag==='a'&&n.textContent==='Open current event')[0].href,'https://qdp.example/?event=ONE');
});
test('confirming a match saves choices without applying or publishing the archive',async()=>{
  const h=setup();await h.settle();await h.match().emit('click');const check=h.choices()[0];check.checked=true;await check.emit('change');
  await h.button('Confirm match / save choices').emit('click');const saved=h.requests.at(-1);assert.equal(saved.action,'admin.backfill.save');assert.deepEqual(saved.data.selectedFields,['Title (internal)']);
  assert.ok(!h.requests.some(r=>r.action==='admin.backfill.apply'||r.action.includes('publish')));
});
test('descriptions stay blank and locked until explicitly selected',async()=>{
  const h=setup();await h.settle();await h.match().emit('click');const input=h.find(n=>n.tag==='textarea')[0];assert.equal(input.value,'');assert.equal(input.readOnly,true);
  const check=h.choices()[1];check.checked=true;await check.emit('change');assert.equal(input.readOnly,false);
  await h.button('Confirm match / save choices').emit('click');const data=h.requests.at(-1).data;assert.deepEqual(data.selectedFields,['Description']);assert.equal(data.draftDescription,'');
});
test('saving a source flyer only verifies media and adds its field to the unsaved selection',async()=>{
  const h=setup();await h.settle();await h.match().emit('click');await h.button('Save this flyer').emit('click');
  assert.equal(h.requests.at(-1).action,'admin.backfill.media');assert.ok(h.choices().at(-1).checked);
  assert.ok(!h.requests.some(r=>r.action==='admin.backfill.apply'));
});
test('unsaved decisions survive refresh and failed saves',async()=>{
  const h=setup({failSave:true});await h.settle();await h.match().emit('click');const check=h.choices()[0];check.checked=true;await check.emit('change');
  await h.button('Confirm match / save choices').emit('click');assert.match(h.find(n=>n.className==='backfill-notice').at(-1).textContent,/Network interrupted/);
  await h.elements.get('backfillRefresh').emit('click');assert.equal(h.choices()[0].checked,true);
});
test('applying requires saved confirmation and sends only selected field values',async()=>{
  const h=setup();await h.settle();await h.button('Apply selected changes').emit('click');assert.ok(!h.requests.some(r=>r.action==='admin.backfill.apply'));
  await h.match().emit('click');const check=h.choices()[0];check.checked=true;await check.emit('change');await h.button('Confirm match / save choices').emit('click');
  await h.button('Apply selected changes').emit('click');const request=h.requests.find(r=>r.action==='admin.backfill.apply');assert.deepEqual(request.data.fields,{'Title (internal)':'Proposed event title'});assert.equal(request.data.expectedTargetRevision,'event-r1');
  assert.ok(!h.requests.some(r=>r.action.includes('publish')));
});
const busyMessage='Another QDP save or sync is running. Your changes have not been saved; try again when it finishes.';
function collection(h,count=21){
  const input=h.elements.get('backfillImport');
  input.files=[{size:1000,text:async()=>JSON.stringify({schema:'qdp-backfill-v1',runId:'fixture',posts:Array.from({length:count},(_,i)=>({pk:String(123450+i)})),candidates:[]})}];
  return input.emit('change');
}
test('a temporarily busy import retries only its blocked batch and keeps completed progress',async()=>{
  const h=setup({ingestErrors:[null,new Error(busyMessage)]});await h.settle();
  const importing=collection(h);await h.settle();
  assert.equal(h.elements.get('backfillProgress').value,20);
  assert.match(h.elements.get('backfillStatus').textContent,/Waiting for another QDP/);
  assert.equal(h.elements.get('backfillImport').disabled,true);assert.equal(h.timers.length,1);
  h.timers[0].fn();await importing;
  const batches=h.requests.filter(r=>r.action==='admin.backfill.ingest');
  assert.equal(batches.length,3);assert.equal(batches[0].data.posts.length,20);
  assert.deepEqual(batches[1].data,batches[2].data);assert.equal(h.elements.get('backfillProgress').value,21);
  assert.equal(h.elements.get('backfillImport').disabled,false);assert.match(h.elements.get('backfillStatus').textContent,/Collection saved/);
});
test('persistent contention stops after five delayed retries and leaves the import usable',async()=>{
  const h=setup({ingestErrors:Array.from({length:6},()=>new Error(busyMessage))});await h.settle();
  const importing=collection(h,1);
  for(let i=0;i<5;i++){await h.settle();assert.equal(h.timers.length,i+1);h.timers[i].fn();}
  await importing;assert.equal(h.requests.filter(r=>r.action==='admin.backfill.ingest').length,6);
  assert.equal(h.elements.get('backfillStatus').textContent,busyMessage);assert.equal(h.elements.get('backfillImport').disabled,false);
});
test('import validation failures stop immediately without an automatic retry',async()=>{
  const h=setup({ingestErrors:[new Error('This pilot accepts event dates in 2025.')]});await h.settle();await collection(h,1);
  assert.equal(h.timers.length,0);assert.equal(h.requests.filter(r=>r.action==='admin.backfill.ingest').length,1);
  assert.match(h.elements.get('backfillStatus').textContent,/event dates in 2025/);
});
