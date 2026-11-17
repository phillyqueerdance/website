import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../functions/admin/api.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^export /gm, '');
function setup({
 upstream = {ok:'yes',events:[{eventId:'ONE',revision:'new'}]},
 authorize = async () => ({email:'test@example.com'})
} = {}){
 const requests=[];
 const ctx=vm.createContext({Request,Response,URL,TextEncoder,crypto,console:{error(){}},fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>upstream};}});
 vm.runInContext(source,ctx);ctx.verifyAccess=authorize;
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

test('profile editors use the existing private Apps Script proxy', async () => {
  const upstream = {ok: 'yes', profile: {id: 'COLLECT-001', revision: 'new'}};
  const {call, requests} = setup({upstream});
  const calls = [
    {action: 'admin.profiles.list', kind: 'venue'},
    {action: 'admin.profile.read', kind: 'party', profileId: 'PARTY-001'},
    {
      action: 'admin.profile.save', kind: 'collective', profileId: 'COLLECT-001',
      expectedRevision: 'old', fields: {CollBio: 'Updated bio'}
    }
  ];
  for (const body of calls) {
    const response = await call(body);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    assert.deepEqual(await response.json(), upstream);
  }
  assert.deepEqual(requests.map(({body}) => body), calls.map(body => ({
    ...body, adminToken: 'fixture-secret'
  })));
});

test('profile saves require Admin access', async () => {
  const {call, requests} = setup({
    authorize: async () => { throw new Error('Cloudflare Access token is required.'); }
  });
  const response = await call({
    action: 'admin.profile.save', kind: 'venue', profileId: 'VENUE-001', fields: {Address: '123 Main St'}
  });
  assert.equal(response.status, 403);
  assert.equal(requests.length, 0);
});
