// Isolated, synthetic preview. This file is never included in the production tree.
const nativeFetch = window.fetch.bind(window);
const original = {eventId:'SAMPLE-112726',title:'A night together',location:'A local dance floor',fields:{description:'A Friday night of house and disco with local selectors. Doors open at 9 PM.',lineup:'DJ North',start:'2026-11-28T02:00:00Z',end:'2026-11-28T07:00:00Z',flyer:''}};
const base = {id:'a'.repeat(64),kind:'correction',title:'A night together',date:'2026-11-27',fields:{'Title (internal)':'A night together',StartDate:'2026-11-27',EndDate:'2026-11-28',StartTime:'21:00',EndTime:'02:00',Location:'A local dance floor',Description:'Local selectors, house and disco.',Lineup_Raw:'DJ North, DJ South'},eventId:original.eventId,listingUrl:'https://queerdancephilly.com/?event=SAMPLE-112726',sourceUrl:'https://www.instagram.com/p/SAMPLEPOST/',changes:{description:'House, disco and a little room to get closer. DJ North and DJ South share the booth from 10 PM until late.',lineup:'DJ North, DJ South',start:'2026-11-27T22:00'},selectedFields:[],baseline:null,decision:'WAIT',status:'pending',version:1,result:{},error:'',isUpdated:true,note:'A new announcement adds DJ South to the lineup and confirms a later start.'};
const records=[structuredClone(base),{...structuredClone(base),id:'b'.repeat(64),kind:'event',title:'Late bloom',fields:{...base.fields,'Title (internal)':'Late bloom',Description:'A warm late-night dance floor with local DJs.'},eventId:'',listingUrl:'',changes:{},note:'',isUpdated:false,isNew:true}];
window.fetch=async(url,options={})=>{
  if(new URL(url,location.href).pathname!=='/admin/discovery'||options.method!=='POST')return nativeFetch(url,options);
  const body=JSON.parse(options.body);await new Promise(resolve=>setTimeout(resolve,body.action==='listings'?800:350));
  let data;
  const pending=records.filter(row=>row.decision!=='EXCLUDE');
  if(body.action==='items')data={items:body.view==='excluded'?records.filter(row=>row.decision==='EXCLUDE'):pending,total:body.view==='excluded'?records.filter(row=>row.decision==='EXCLUDE').length:pending.length};
  else if(body.action==='bootstrap')data={counts:{selected:pending.filter(row=>row.decision==='INCLUDE').length},runs:[{day:'2026-11-23',status:'review complete'}],checkpoint:{value:{coverage:{'New posts reviewed':28,'Flyers reviewed':42,'Waiting for a lineup':3}}}};
  else if(body.action==='listings')data={events:[original]};
  else if(body.action==='save'){const item=records.find(row=>row.id===body.id);Object.assign(item,body,{version:item.version+1});data={item};}
  else if(body.action==='selected')data={items:[]};
  else return new Response(JSON.stringify({error:'This sample preview does not import or publish events.'}),{status:400,headers:{'Content-Type':'application/json'}});
  return new Response(JSON.stringify({ok:'yes',...data}),{headers:{'Content-Type':'application/json'}});
};
