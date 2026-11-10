import { DIRECTORY_FOR, KINDS, keyOf, connectionsFor, pickConnections,
  upcomingFor, relationshipText } from "./scene-map-graph.js";

const $ = selector => document.querySelector(selector);
const ns = "http://www.w3.org/2000/svg";
const known = new Map(), profiles = new Map();
const palette = { artist: "#a481fa", party: "#dc50a4", venue: "#67b7b9", collective: "#ecaa69" };
const types = { artist: "Artist", party: "Party", venue: "Venue", collective: "Collective" };
const state = { current: null, path: [], neighbors: [], filter: new Set(KINDS),
  upcomingOnly: false, scale: 1, x: 0, y: 0, busy: false };
const svg = $("#sceneSvg"), status = $("#mapStatus"), details = $("#details");
let currentEvents = [], currentLinks = [];

function element(name, attrs = {}, text = null) {
  const e = document.createElementNS(ns, name);
  for (const [k,v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== null) e.textContent = text;
  return e;
}
function dom(name, text, className) {
  const e = document.createElement(name);
  if (text != null) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function archiveUrl(item) {
  const u = new URL("/", location.origin);
  u.searchParams.set("archive", item.kind);
  u.searchParams.set("id", item.id);
  return u.href;
}
function eventUrl(event) {
  const u = new URL("/", location.origin);
  u.searchParams.set("event", event.eventId);
  return u.href;
}
function link(text, href) {
  const a = dom("a", text);
  a.href = href;
  return a;
}
function date(value) {
  const d = new Date(value);
  return Number.isFinite(d.valueOf()) ? d.toLocaleDateString("en-US", {
    timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric"
  }) : "Date unknown";
}
async function api(resource, id = "") {
  const u = new URL("/api/archive", location.origin);
  u.searchParams.set("resource", resource);
  if (id) u.searchParams.set("id", id);
  const res = await fetch(u, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Public archive returned ${res.status} for ${resource}`);
  return res.json();
}
async function directories() {
  const results = await Promise.allSettled(KINDS.map(async kind => {
    const payload = await api(DIRECTORY_FOR[kind]);
    for (const item of payload[DIRECTORY_FOR[kind]] || []) {
      if (!item?.id || !item?.name) continue;
      known.set(keyOf(kind,item.id), { ...item, kind, key: keyOf(kind,item.id) });
    }
    return kind;
  }));
  const failures = results.filter(x => x.status === "rejected");
  const line = $("#directoryStatus");
  if (!known.size) {
    line.textContent = "The public directory is unavailable. Try refreshing.";
    return;
  }
  line.textContent = `${known.size} approved profiles loaded` +
    (failures.length ? ` · ${failures.length} directories unavailable` : "") +
    ". Search to begin.";
  search();
  const params = new URLSearchParams(location.search);
  const kind = params.get("kind"), id = params.get("id");
  if (KINDS.includes(kind) && known.has(keyOf(kind,id))) {
    visit(known.get(keyOf(kind,id)));
  }
}
function search() {
  const query = $("#sceneSearch").value.trim().toLocaleLowerCase();
  const box = $("#sceneResults");
  box.replaceChildren();
  if (!query) {
    // Handful of recurring projects by alphabetical name, not fabricated recommendations.
    const hint = dom("p","Type a name to explore the network.","subtle");
    box.append(hint); return;
  }
  const matching = [...known.values()].filter(x => x.name.toLocaleLowerCase().includes(query))
    .sort((a,b) => (a.name.toLocaleLowerCase().startsWith(query)?0:1) -
      (b.name.toLocaleLowerCase().startsWith(query)?0:1) ||
      a.name.localeCompare(b.name)).slice(0,12);
  if (!matching.length) box.append(dom("p","No matching public profiles.","subtle"));
  for (const item of matching) {
    const b = dom("button",null,"search-hit");
    b.type="button";
    const dot=dom("span",null,"dot "+item.kind);
    b.append(dot,dom("span",item.name),dom("small",types[item.kind]));
    b.onclick=()=>{ $("#sceneSearch").value=item.name; box.replaceChildren(); visit(item); };
    box.append(b);
  }
}
async function loadProfile(item) {
  if (!profiles.has(item.key)) profiles.set(item.key,api(item.kind,item.id)
    .then(raw => {
      if (!raw.profile || !Array.isArray(raw.events)) throw new Error("Profile is incomplete");
      return raw;
    }).catch(err => { profiles.delete(item.key); throw err; }));
  return profiles.get(item.key);
}
function trail() {
  const holder=$("#trail"); holder.replaceChildren();
  for (let i=0; i<state.path.length; i++) {
    if (i) holder.append(dom("span","›"));
    const item=state.path[i];
    const b=dom("button",item.name);
    b.type="button";
    b.onclick=()=>{state.path=state.path.slice(0,i);visit(item);};
    holder.append(b);
  }
}
async function visit(item) {
  if (state.busy || !item) return;
  state.busy=true; state.current=item;
  const last=state.path.at(-1);
  if (last?.key!==item.key) state.path.push(item);
  trail(); status.textContent=`Loading connections for ${item.name}…`;
  $("#empty").hidden=true;
  details.replaceChildren(dom("p","Loading public event relationships…","loading"));
  try {
    const payload=await loadProfile(item);
    currentEvents=payload.events;
    currentLinks=connectionsFor(item,payload.events,known);
    state.neighbors=pickConnections(currentLinks,12,state.path.at(-2)?.key);
    render();
    inspect(item,payload.profile,null);
    const u=new URL(location.href);
    u.searchParams.set("kind",item.kind);u.searchParams.set("id",item.id);
    history.replaceState(null,"",u);
  } catch(err) {
    currentEvents=[];currentLinks=[];state.neighbors=[];render();
    details.replaceChildren(dom("p","Unable to read this profile's public events. "+err.message,"warning"));
    status.textContent="Could not load connections";
  } finally {state.busy=false;}
}
function filtered() {
  return state.neighbors.filter(x=>state.filter.has(x.kind) &&
    (!state.upcomingOnly || x.upcoming>0));
}
function inspect(item,profile,connection) {
  details.replaceChildren();
  details.append(dom("span",types[item.kind],"category"),dom("h2",item.name));
  if (connection) {
    details.append(dom("p",relationshipText(state.current,connection),"related"));
    const ul=dom("ul");
    for (const event of connection.examples) {
      const li=dom("li");
      li.append(link(event.title,eventUrl({eventId:event.id})),dom("small",date(event.start)));
      ul.append(li);
    }
    details.append(dom("h3","Shared events"),ul);
    const expand=dom("button","Explore "+item.name);
    expand.onclick=()=>visit(item);
    details.append(expand);
  } else {
    if (profile.bio) details.append(dom("p",profile.bio,"bio"));
    details.append(link("Open QDP profile ↗",archiveUrl(item)));
    const number=dom("p",`${currentLinks.length} distinct connections found in documented events. Showing up to 12.`);
    details.append(number);
    const upcoming=upcomingFor(item,currentEvents);
    details.append(dom("h3","Upcoming events"));
    if (!upcoming.length) details.append(dom("p","No upcoming events in this profile's published history."));
    else {
      const ul=dom("ul");
      for (const event of upcoming) {
        const li=dom("li");
        li.append(link(event.title,eventUrl(event)),dom("small",date(event.start)));
        ul.append(li);
      }
      details.append(ul);
    }
  }
}
function render() {
  svg.replaceChildren(); const focus=state.current;
  if (!focus) return;
  const items=filtered();
  const group=element("g",{transform:`translate(${state.x} ${state.y}) scale(${state.scale})`});
  svg.append(group);
  const cx=400,cy=300;
  const radius=Math.min(224,items.length>9?222:196);
  const points=items.map((item,i)=>({
    ...item, x:cx+Math.cos(i*2*Math.PI/items.length-Math.PI/2)*radius,
    y:cy+Math.sin(i*2*Math.PI/items.length-Math.PI/2)*radius
  }));
  for (const p of points) group.append(element("line",{
    x1:cx,y1:cy,x2:p.x,y2:p.y,class:"edge",
    "stroke-width":Math.min(6,1.5+Math.log2(p.count+1))
  }));
  for (const p of points) node(group,p,false);
  node(group,{...focus,x:cx,y:cy},true);
  status.textContent=`${items.length} connections displayed · ${currentLinks.length} total found`;
}
function node(group,item,center) {
  const g=element("g",{class:"node"+(center?" center":""),transform:`translate(${item.x} ${item.y})`,
    tabindex:"0",role:"button","aria-label":center?`Selected: ${item.name}`:`Explore ${item.name}, ${item.count} shared events`});
  const r=center?53:Math.min(39,26+Math.log2(item.count+1)*2);
  g.append(element("circle",{r,fill:palette[item.kind]}));
  let label=item.name;
  if(label.length>18)label=label.slice(0,17)+"…";
  const words=label.split(" ");
  if(words.length>1&&label.length>12){
    const at=Math.ceil(words.length/2);
    g.append(element("text",{y:-3},words.slice(0,at).join(" ")));
    g.append(element("text",{y:11},words.slice(at).join(" ")));
  } else g.append(element("text",{y:4},label));
  g.append(element("text",{y:r+15,class:"node-kind"},types[item.kind].toUpperCase()));
  g.addEventListener("click",()=> {
    if(center)inspect(item, profiles.get(item.key)?.profile || item,null);
    else {
      const raw=profiles.get(item.key);
      inspect(item,raw?.profile||item,item);
      // A second tap on the same node expands it.
      if(g.dataset.selected==="yes")visit(item);
      else {svg.querySelectorAll(".node").forEach(n=>n.dataset.selected="no");
        g.dataset.selected="yes";}
    }
  });
  g.addEventListener("keydown",event=>{
    if(event.key==="Enter"||event.key===" "){event.preventDefault();visit(item);}
  });
  group.append(g);
}
function reset() {
  state.current=null;state.path=[];state.neighbors=[];state.x=0;state.y=0;state.scale=1;
  currentLinks=[];currentEvents=[];svg.replaceChildren();
  $("#empty").hidden=false;$("#trail").replaceChildren();
  $("#sceneSearch").value="";search();
  details.replaceChildren(dom("div",null,"details-empty"));
  details.firstChild.append(dom("h2","Wander a little."),dom("p","Choose a public profile to begin."));
  status.textContent="Select a starting point";
  const url=new URL(location.href);url.searchParams.delete("kind");url.searchParams.delete("id");
  history.replaceState(null,"",url);
}
$("#sceneSearch").addEventListener("input",search);
$("#kindFilters").addEventListener("change",()=>{
  state.filter=new Set([...document.querySelectorAll("#kindFilters input:checked")].map(x=>x.value));
  render();
});
$("#upcomingOnly").addEventListener("change",e=>{state.upcomingOnly=e.target.checked;render();});
$("#reset").onclick=reset;
const changeZoom=delta=>{state.scale=Math.max(.5,Math.min(2.5,state.scale*delta));render();};
$("#zoomIn").onclick=()=>changeZoom(1.2);
$("#zoomOut").onclick=()=>changeZoom(1/1.2);
$("#fit").onclick=()=>{state.x=0;state.y=0;state.scale=1;render();};
$("#mapWrap").addEventListener("wheel",e=>{e.preventDefault();changeZoom(e.deltaY<0?1.1:1/1.1);},{passive:false});
let drag=null;
$("#mapWrap").addEventListener("pointerdown",e=>{
  if(e.target.closest(".node"))return;
  drag={x:e.clientX,y:e.clientY,left:state.x,top:state.y};
  e.currentTarget.setPointerCapture(e.pointerId);
});
$("#mapWrap").addEventListener("pointermove",e=>{
  if(!drag)return;
  const rect=svg.getBoundingClientRect();
  state.x=drag.left+(e.clientX-drag.x)*800/rect.width;
  state.y=drag.top+(e.clientY-drag.y)*600/rect.height;
  render();
});
$("#mapWrap").addEventListener("pointerup",()=>{drag=null;});
$("#mapWrap").addEventListener("pointercancel",()=>{drag=null;});
directories();
