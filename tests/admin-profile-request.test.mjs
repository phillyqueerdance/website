import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../admin/profile-editor.js',import.meta.url),'utf8');
function setup(fetch){
  const window={};
  vm.runInNewContext(source,{window,fetch,document:{querySelector:()=>null}});
  return window.QDPAdminProfiles.request;
}
test('Admin requests preserve server errors, including the shared-lock refusal',async()=>{
  const error='Another QDP save or sync is running. Your changes have not been saved; try again when it finishes.';
  const request=setup(async()=>Response.json({error},{status:400}));
  await assert.rejects(request('admin.backfill.ingest'),{message:error});
});
test('a timeout page reports its HTTP status rather than blaming the Index',async()=>{
  const request=setup(async()=>new Response('<html>Gateway timeout</html>',{status:524}));
  await assert.rejects(request('admin.backfill.bootstrap'),/Archive Backfill timed out \(HTTP 524\)/);
});
test('an unexpected HTML response reports its HTTP status without displaying its contents',async()=>{
  const request=setup(async()=>new Response('<html>Private upstream contents</html>'));
  await assert.rejects(request('admin.backfill.bootstrap'),error=>{
    assert.match(error.message,/unreadable response \(HTTP 200\)/);
    assert.equal(error.message.includes('Private upstream'),false);return true;
  });
});
test('authentication redirects report sign-in before attempting to decode the login page',async()=>{
  const request=setup(async()=>({redirected:true,status:200,json(){throw new Error('Must not parse login HTML');}}));
  await assert.rejects(request('admin.backfill.bootstrap'),/Sign in to QDP Admin again/);
});
test('an older Apps Script deployment gives installation instructions for backfill',async()=>{
  const request=setup(async()=>Response.json({error:'Unknown admin action.'},{status:400}));
  await assert.rejects(request('admin.backfill.bootstrap'),/deployment with Core.gs and ArchiveBackfill.gs/);
});
test('connection failures show a relevant message and successful requests retain their payload',async()=>{
  const failed=setup(async()=>{throw new TypeError('Failed to fetch');});
  await assert.rejects(failed('admin.backfill.bootstrap'),/Archive Backfill could not connect/);
  const calls=[],request=setup(async(url,options)=>{calls.push({url,options});return Response.json({ok:'yes',total:3});});
  const result=await request('admin.backfill.bootstrap',{queue:'matches'});
  assert.equal(result.total,3);assert.equal(calls[0].url,'/admin/api');assert.equal(calls[0].options.credentials,'same-origin');
  assert.deepEqual(JSON.parse(calls[0].options.body),{action:'admin.backfill.bootstrap',queue:'matches'});
});
