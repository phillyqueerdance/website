import {REVIEW_FIELDS} from './apify-workbook.js?v=20261120-daily-1';
import {downloadReview} from './discovery-export.js?v=20261123-1';
const el=Object.fromEntries(['items','status','count','view','query','refresh','previous','next','page','add','selection','run-status','coverage','export'].map(id=>[id,document.getElementById(id)]));
let rows=[],offset=0,total=0,busy=false,snapshot=null,selected=0;
const dirty=new Map(),saving=new Map();
const node=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
const link=(label,url)=>{try{const u=new URL(url);if(u.protocol!=='https:')return null;const a=node('a',label,'apify-link');a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';return a;}catch{return null;}};
async function request(action,data={}){const r=await fetch('/admin/discovery',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...data})});const result=await r.json();if(!r.ok||result.ok!=='yes')throw new Error(result.error||'Discovery Review is unavailable.');return result;}
function status(text,error=false){el.status.textContent=text;el.status.className=error?'discovery-error':'';}
function controls(){el.add.disabled=busy||saving.size>0||selected===0;el.refresh.disabled=busy;el.previous.disabled=busy||offset===0;el.next.disabled=busy||offset+25>=total;el.selection.textContent=selected+' selected';}
async function save(item,message){
  if(saving.has(item.id))await saving.get(item.id);
  const operation=(async()=>{
    message.textContent='Saving…';
    const editable=()=>({fields:item.fields,changes:item.changes,selectedFields:item.selectedFields,decision:item.decision,baseline:item.baseline});
    const submitted=JSON.stringify(editable()),payload=JSON.parse(submitted);
    try{const {item:saved}=await request('save',{id:item.id,version:item.version,...payload});
      if(JSON.stringify(editable())===submitted){Object.assign(item,saved);dirty.delete(item.id);message.textContent='Saved';}
      else {item.version=saved.version;message.textContent='Unsaved changes';}}
    catch(error){message.textContent=error.message;message.classList.add('discovery-error');throw error;}
  })();saving.set(item.id,operation);controls();try{await operation;}finally{saving.delete(item.id);controls();}
}
function field(item,definition,message){
  const label=node('label',definition.label,'field'+(definition.wide?' apify-wide':''));
  const input=node(definition.type==='textarea'?'textarea':definition.type==='yes-no'?'select':'input');
  if(input.tagName==='SELECT')for(const value of ['', 'Yes','No']){const option=node('option',value||'Unspecified');option.value=value;input.append(option);}
  else if(input.tagName==='INPUT')input.type=['date','time'].includes(definition.type)?definition.type:'text';
  if(input.type==='time')input.step=1;
  input.value=item.fields[definition.name]||'';
  if(item.fields[definition.name]&&!input.value){input.type='text';input.value=item.fields[definition.name];}
  input.addEventListener('input',()=>{item.fields[definition.name]=input.value;dirty.set(item.id,{item,message});message.textContent='Unsaved changes';});
  input.addEventListener('change',()=>save(item,message).then(refreshSummary).catch(()=>{}));label.append(input);return label;
}
async function checkListing(item,section,message){
  message.textContent='Loading the current listing…';
  try{snapshot=await request('snapshot');const current=snapshot.events.find(e=>e.eventId.toUpperCase()===item.eventId.toUpperCase());
    if(!current)throw new Error('This event was not found in Events.');item.baseline=current;
    section.textContent=[current.title,current.location,current.fields.start+' – '+current.fields.end,current.fields.description,'Lineup: '+current.fields.lineup].join('\n\n');
    dirty.set(item.id,{item,message});await save(item,message);
  }catch(error){message.textContent=error.message;message.classList.add('discovery-error');}
}
function card(item){
  const article=node('article','','apify-card'),heading=node('div','','apify-card-header');
  heading.append(node('h2',item.fields['Title (internal)']||item.title||'Untitled lead'),node('p',[item.date||'Date unconfirmed',item.kind==='correction'?'Correction':'New event',item.fields.Location||''].filter(Boolean).join(' · '),'apify-card-date'));
  const state=node('p',item.status==='ready'?'Saved to Events and Calendar; website refresh pending.':item.status==='imported'?'Website refresh completed.':item.status==='existing'?'Already present in QDP.':item.status==='importing'?'Import is processing. Refresh to check its result.':item.readiness||'','discovery-card-status');
  heading.append(state);article.append(heading);
  if(item.error)article.append(node('p',item.error,'discovery-error'));
  const message=node('p','','discovery-save-status');
  const choices=node('fieldset','','apify-decisions');choices.append(node('legend','Review decision'));
  const locked=['ready','importing','imported','existing'].includes(item.status);
  for(const decision of ['INCLUDE','WAIT','EXCLUDE']){const button=node('button',decision[0]+decision.slice(1).toLowerCase(),'apify-decision');button.type='button';button.setAttribute('aria-pressed',String(item.decision===decision));button.disabled=locked;
    button.addEventListener('click',async()=>{item.decision=decision;dirty.set(item.id,{item,message});for(const b of choices.querySelectorAll('button'))b.setAttribute('aria-pressed',String(b===button));await save(item,message).then(refreshSummary).catch(()=>{});});choices.append(button);}
  article.append(choices);
  const layout=node('div','','apify-review-layout'),media=node('div','','apify-media');
  const flyer=item.fields.Flyer_URL||item.fields.RawFlyerURL||item.changes.flyer;
  if(flyer){const image=node('img');image.alt=(item.title||'Event')+' flyer';image.loading='lazy';image.referrerPolicy='no-referrer';image.src='/admin/flyer?url='+encodeURIComponent(flyer);image.addEventListener('error',()=>{image.hidden=true;media.append(node('p','Flyer preview unavailable. Use the source link.'));});media.append(image);}
  for(const l of [link('Source',item.sourceUrl),link('QDP listing',item.listingUrl),item.result.eventId?link('Edit accepted event',location.origin+'/admin/?editEvent='+encodeURIComponent(item.result.eventId)+'#events'):null])if(l)media.append(l);
  layout.append(media);const editor=node('fieldset','','apify-editor');editor.disabled=locked;
  if(item.kind==='event')for(const definition of REVIEW_FIELDS.filter(f=>f.type!=='link').concat([
    {name:'RawFlyerURL',label:'Original flyer image URL',wide:true},
    {name:'VenueID',label:'Venue ID'},{name:'ArtistIDs (comma-separated)',label:'Artist IDs'},
    {name:'PartyID',label:'Party ID'},{name:'HostCollectiveIDs (comma-separated)',label:'Collective IDs'}]))editor.append(field(item,definition,message));
  else {
    editor.classList.add('discovery-correction-editor');
    if(item.note)editor.append(node('p',item.note,'apify-description'));
    const current=node('div',item.baseline?[item.baseline.title,item.baseline.fields.description,'Lineup: '+item.baseline.fields.lineup].join('\n\n'):'Load the current listing before applying this correction.','discovery-current');
    const check=node('button','Load current listing');check.type='button';check.addEventListener('click',()=>checkListing(item,current,message));editor.append(check,current);
    for(const [key,value] of Object.entries(item.changes)){
      const section=node('div','','discovery-change'),label=node('label'),checkbox=node('input');checkbox.type='checkbox';checkbox.checked=item.selectedFields.includes(key);label.append(checkbox,node('span',' Apply '+key));
      const input=node(key==='start'||key==='end'?'input':'textarea');input.setAttribute('aria-label','Proposed '+key);if(input.tagName==='INPUT')input.type='datetime-local';input.value=value;
      checkbox.addEventListener('change',()=>{item.selectedFields=checkbox.checked?[...new Set([...item.selectedFields,key])]:item.selectedFields.filter(k=>k!==key);dirty.set(item.id,{item,message});save(item,message).catch(()=>{});});
      input.addEventListener('input',()=>{item.changes[key]=input.value;dirty.set(item.id,{item,message});message.textContent='Unsaved changes';});input.addEventListener('change',()=>save(item,message).catch(()=>{}));section.append(label,input);editor.append(section);
    }
  }
  const explicitSave=node('button','Save edits');explicitSave.type='button';explicitSave.addEventListener('click',()=>save(item,message).then(refreshSummary).catch(()=>{}));editor.append(explicitSave);layout.append(editor);article.append(layout,message);return article;
}
async function refreshSummary(){const data=await request('bootstrap');selected=data.counts.selected||0;const run=data.runs[0];el['run-status'].textContent=run?'Latest run: '+run.day+' · '+run.status:'Your saved backlog is ready. No scheduled run has been delivered to this inbox yet.';el.coverage.textContent=JSON.stringify(data.checkpoint?.value?.coverage||run?.data?.coverage||{},null,2);controls();}
async function load(){busy=true;controls();status('Loading discoveries…');try{const data=await request('items',{view:el.view.value,query:el.query.value,offset});rows=data.items;total=data.total;el.items.replaceChildren(...rows.map(card));el.count.textContent=total+' '+el.view.options[el.view.selectedIndex].text.toLowerCase()+' item(s)';el.page.textContent=total?(offset+1)+'–'+Math.min(offset+25,total)+' of '+total:'No items';await refreshSummary();status('');}catch(error){status(error.message,true);}finally{busy=false;controls();}}
async function flushEdits(){for(const {item,message} of [...dirty.values()])await save(item,message);await Promise.all([...saving.values()]);}
el.add.addEventListener('click',async()=>{
  busy=true;controls();try{await flushEdits();const selection=await request('selected'),ids=[];let completed=0;const errors=[];
    for(let i=0;i<selection.items.length;i+=5){status('Adding selected items: '+i+' of '+selection.items.length+' checked…');const data=await request('import',{items:selection.items.slice(i,i+5)});for(const result of data.results){if(result.error)errors.push(result.error);else{completed++;if(result.needsPublish)ids.push(result.id);}}}
    if(ids.length){status('Refreshing website data for '+ids.length+' item(s)…');await request('publish',{ids});}
    await load();status(completed+' item(s) completed.'+(errors.length?'\n'+errors.length+' item(s) need attention:\n'+[...new Set(errors)].join('\n'):''),!!errors.length);
  }catch(error){status(error.message,true);}finally{busy=false;controls();}
});
el.refresh.addEventListener('click',()=>flushEdits().then(load).catch(error=>status(error.message,true)));
el.view.addEventListener('change',()=>{offset=0;flushEdits().then(load).catch(error=>status(error.message,true));});
let searchTimer;el.query.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{offset=0;flushEdits().then(load).catch(error=>status(error.message,true));},350);});
el.previous.addEventListener('click',()=>{offset=Math.max(0,offset-25);flushEdits().then(load).catch(error=>status(error.message,true));});
el.next.addEventListener('click',()=>{offset+=25;flushEdits().then(load).catch(error=>status(error.message,true));});
el.export.addEventListener('click',async()=>{try{await flushEdits();const all=[];let page=0;do{const data=await request('items',{view:el.view.value,query:el.query.value,offset:page,limit:50});all.push(...data.items);page+=50;if(page>=data.total)break;}while(page<2000);downloadReview(all,el.coverage.textContent);}catch(error){status(error.message,true);}});
window.addEventListener('beforeunload',event=>{if(dirty.size||saving.size){event.preventDefault();event.returnValue='';}});
load();
