import {DIRECTORY_FOR,KINDS,keyOf,connectionsFor,pickConnections,upcomingFor,relationshipText,prominence} from "./scene-map-graph.js?v=20261110-scene-map-3";
const NS="http://www.w3.org/2000/svg";
const colors={artist:"#fa2b5a",party:"#922185",venue:"#ff7945",collective:"#000"};
const labels={artist:"Artist",party:"Party",venue:"Venue",collective:"Collective"};
const known=new Map(), cache=new Map();
const node=(tag,cls="",value="")=>{const e=document.createElement(tag);e.className=cls;e.textContent=value;return e;};
const el=(tag,attrs={},value="")=>{const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);e.textContent=value;return e;};
const key=item=>keyOf(item.kind,item.id);
const short=(str,max=19)=>str.length>max?str.slice(0,max-1)+"…":str;
const qdpUrl=(item,event=false)=>{const u=new URL("/",location.origin);if(event)u.searchParams.set("event",item.eventId||item.id);else{u.searchParams.set("archive",item.kind);u.searchParams.set("id",item.id);}return u.href;};
async function resource(kind,id){const u=new URL("/api/archive",location.origin);u.searchParams.set("resource",kind);if(id)u.searchParams.set("id",id);const r=await fetch(u,{cache:"no-cache"});if(!r.ok)throw Error("Public archive unavailable ("+r.status+")");return r.json();}
async function loadDirectories() {
  if (known.size) return;
  const results = await Promise.allSettled(KINDS.map(async kind => {
    const directory = DIRECTORY_FOR[kind];
    const data = await resource(directory);
    for (const profile of data[directory] || []) {
      if (!profile?.id || !profile?.name) continue;
      const profileKey = keyOf(kind, profile.id);
      known.set(profileKey, { ...profile, kind, key: profileKey });
    }
  }));
  if (!known.size) throw new Error("Public directories unavailable");
  if (results.some(result => result.status === "rejected")) {
    console.warn("A QDP directory was unavailable");
  }
}
async function profile(item){const k=key(item);if(!cache.has(k))cache.set(k,resource(item.kind,item.id).then(d=>{if(!d.profile||!Array.isArray(d.events))throw Error("Invalid profile");return d;}).catch(e=>{cache.delete(k);throw e;}));return cache.get(k);}
function anchor(text,url){const a=node("a","scene-map-link",text);a.href=url;a.dataset.archiveLink="";return a;}
function details(c,item,edge=null){
 c.info.replaceChildren();
 const h=node("div","scene-map-detail-heading");
 h.append(node("strong","",item.name),node("small","",labels[item.kind]));c.info.append(h);
 if(edge){c.info.append(node("p","scene-map-note",relationshipText(c.focus,edge)));
  for(const e of edge.examples.slice(0,2))c.info.append(anchor(e.title,qdpUrl({id:e.id},true)));
  const explore=node("button","scene-map-explore","Explore "+item.name);
  explore.onclick=()=>visit(c,item);c.info.append(explore);
 }else{
  const upcoming=upcomingFor(item,c.events,Date.now(),2);
  for(const e of upcoming)c.info.append(anchor("Upcoming: "+e.title,qdpUrl(e,true)));
  if(!upcoming.length)c.info.append(node("p","scene-map-note","No upcoming events listed here."));
 }
 c.info.append(anchor("View QDP profile",qdpUrl(item)));
}
function draw(c){
 c.svg.replaceChildren();c.empty.hidden=!!c.focus;if(!c.focus)return;
 const filtered=c.links.filter(x=>c.allowed.has(x.kind));
 const links=pickConnections(filtered,9,c.path.at(-2)?key(c.path.at(-2)):"");
 const group=el("g",{transform:"translate("+c.dx+" "+c.dy+") scale("+c.scale+")"});c.svg.append(group);
 const cx=250,cy=205,dist=145;
 const coords=links.map((x,i)=>({...x,x:cx+Math.cos(2*Math.PI*i/links.length-Math.PI/2)*dist,y:cy+Math.sin(2*Math.PI*i/links.length-Math.PI/2)*dist}));
 for(const x of coords)group.append(el("line",{x1:cx,y1:cy,x2:x.x,y2:x.y,class:"scene-map-edge","stroke-width":1+Math.min(4,Math.log2(x.count+1))}));
 function circle(item,center){
   const g=el("g",{class:"scene-map-node"+(center?" focus":""),transform:"translate("+item.x+" "+item.y+")",role:"button",tabindex:"0","aria-label":"Explore "+item.name});
   const r=center?38:16+prominence(item)*18;
   g.append(el("circle",{r,fill:colors[item.kind],stroke:item.kind==="collective"?"#fff1f4":"none","stroke-width":2.5}));
   g.append(el("text",{y:r+12,class:"scene-map-label"},short(item.name)));
   g.append(el("text",{y:r+24,class:"scene-map-kind"},labels[item.kind]+(center?"":" · "+item.count)));
   g.addEventListener("click",()=>center?details(c,item):visit(c,item));
   g.addEventListener("pointerenter",()=>{if(!center)details(c,item,item);});
   g.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();if(!center)visit(c,item);}});
   group.append(g);
 }
 coords.forEach(x=>circle(x,false));circle({...c.focus,x:cx,y:cy},true);
 c.status.textContent=links.length+" connections shown · weighted by shared documented events";
}
function historyPath(c){
 c.crumbs.replaceChildren();c.path.forEach((p,i)=>{if(i)c.crumbs.append(node("span","","›"));const b=node("button","",short(p.name,12));b.onclick=()=>{c.path=c.path.slice(0,i);visit(c,p);};c.crumbs.append(b);});
}
async function visit(c,item){
 if(c.busy)return;c.busy=true;c.status.textContent="Loading "+item.name+"…";
 try{const d=await profile(item);if(!c.root.isConnected)return;c.focus=item;c.events=d.events;
  c.links=connectionsFor(item,d.events,known);
  if(c.path.at(-1)?.id!==item.id||c.path.at(-1)?.kind!==item.kind)c.path.push(item);
  historyPath(c);draw(c);details(c,item);
 }catch(e){if(c.root.isConnected)c.status.textContent=e.message;}finally{c.busy=false;}
}
function search(c){
 const q=c.search.value.toLocaleLowerCase().trim();c.results.replaceChildren();if(!q)return;
 const found=[...known.values()].filter(x=>x.name.toLocaleLowerCase().includes(q)).sort((a,b)=>{const rank=x=>x.name.toLocaleLowerCase().startsWith(q)?0:1;return rank(a)-rank(b)||a.name.localeCompare(b.name);}).slice(0,7);
 if(!found.length)c.results.append(node("p","scene-map-note","No matching profiles."));
 found.forEach(item=>{const b=node("button","scene-map-result",item.name+" · "+labels[item.kind]);b.onclick=()=>{c.search.value="";c.results.replaceChildren();visit(c,item);};c.results.append(b);});
}
export async function mountSceneMap(host){
 const root=node("section","scene-map-view");
 const top=node("div","scene-map-top");const input=node("input","scene-map-search");input.type="search";input.placeholder="Search the scene…";input.setAttribute("aria-label","Search artists, parties, venues and collectives");
 const results=node("div","scene-map-results");const filters=node("div","scene-map-filters");top.append(input,results,filters);
 for(const k of KINDS){const label=node("label","scene-map-filter");label.dataset.kind=k;const cb=node("input");cb.type="checkbox";cb.value=k;cb.checked=true;label.append(cb,node("span","",labels[k]+"s"));filters.append(label);}
 const crumbs=node("nav","scene-map-path");crumbs.setAttribute("aria-label","Exploration path");
 const wrap=node("div","scene-map-canvas-wrap"),canvas=el("svg",{class:"scene-map-canvas",viewBox:"0 0 500 420",role:"group","aria-label":"Scene connections"});
 const empty=node("p","scene-map-empty","Search for something you know to begin.");wrap.append(canvas,empty);
 const info=node("div","scene-map-detail"),status=node("p","scene-map-status","Loading public QDP directory…");status.setAttribute("role","status");
 root.append(top,crumbs,wrap,info,status);host.replaceChildren(root);
 const c={root,svg:canvas,info,status,empty,crumbs,search:input,results,focus:null,events:[],links:[],path:[],allowed:new Set(KINDS),dx:0,dy:0,scale:1,busy:false};
 input.addEventListener("input",()=>search(c));
 filters.addEventListener("change",()=>{c.allowed=new Set([...filters.querySelectorAll("input:checked")].map(x=>x.value));draw(c);});
 let pan=null;
 wrap.addEventListener("pointerdown",e=>{if(e.target.closest(".scene-map-node"))return;pan={x:e.clientX,y:e.clientY,dx:c.dx,dy:c.dy};wrap.setPointerCapture(e.pointerId);});
 wrap.addEventListener("pointermove",e=>{if(!pan)return;const r=canvas.getBoundingClientRect();c.dx=pan.dx+(e.clientX-pan.x)*500/r.width;c.dy=pan.dy+(e.clientY-pan.y)*420/r.height;draw(c);});
 wrap.addEventListener("pointerup",()=>pan=null);wrap.addEventListener("pointercancel",()=>pan=null);
 try{await loadDirectories();if(!root.isConnected)return;status.textContent="Choose a starting point · "+known.size+" public profiles";
  const focus=new URL(location.href).searchParams.get("focus");if(focus&&known.has(focus))await visit(c,known.get(focus));
 }catch(e){if(root.isConnected)status.textContent=e.message;}
}
