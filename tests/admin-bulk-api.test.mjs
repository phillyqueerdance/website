import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../functions/admin/api.js',import.meta.url),'utf8').replace(/^export /gm,'');
function setup(){
 const requests=[];
 const ctx=vm.createContext({Request,Response,URL,TextEncoder,crypto,console:{error(){}},fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({ok:'yes',events:[{eventId:'ONE',revision:'new'}]})};}});
 vm.runInContext(source,ctx);ctx.verifyAccess=async()=>({email:'test@example.com'});
 const call=(body,origin='https://qdp.example')=>ctx.onRequestPost({request:new Request('https://qdp.example/admin/api',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)}),env:{QDP_ADMIN_SHARED_SECRET:'fixture-secret'}});
 return {requests,call};
}
test('authenticated bulk action forwards the whole batch once and preserves its confirmation',async()=>{
 const h=setup(),changes=[{eventId:'ONE'},{eventId:'TWO'}];const response=await h.call({action:'admin.savebatch',changes});
 assert.equal(response.status,200);assert.equal(h.requests.length,1);assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].body.changes)),changes);
 assert.equal((await response.json()).events[0].revision,'new');assert.match(response.headers.get('Cache-Control'),/no-store/);
});
test('cross-origin writes are rejected before contacting Apps Script',async()=>{
 const h=setup();const r=await h.call({action:'admin.savebatch',changes:[]},'https://other.example');assert.equal(r.status,403);assert.equal(h.requests.length,0);
});
test('bulk request size is measured in UTF-8 bytes',async()=>{
 const h=setup();const r=await h.call({action:'admin.savebatch',changes:[{description:'é'.repeat(1100000)}]});assert.equal(r.status,413);assert.equal(h.requests.length,0);
});
