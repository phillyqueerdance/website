import {verifyAccess,requestAppsScriptAdmin} from './api.js';
const MAX_BYTES=6*1024*1024;
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
export async function onRequestPost(context){
  try{
    const url=new URL(context.request.url),origin=context.request.headers.get('Origin');
    if(origin&&origin!==url.origin)return json({error:'Cross-origin uploads are not allowed.'},403);
    await verifyAccess(context);
    if(Number(context.request.headers.get('Content-Length'))>MAX_BYTES)return json({error:'Choose a source image no larger than 6 MB.'},413);
    const postKey=url.searchParams.get('postKey'),mediaId=url.searchParams.get('mediaId');
    if(!/^ig:\d{5,30}$/.test(postKey||'')||!/^\d{5,30}$/.test(mediaId||''))return json({error:'Choose a source post and image.'},400);
    const reader=context.request.body?.getReader();if(!reader)return json({error:'Choose a saved source image.'},400);
    const chunks=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES){await reader.cancel();return json({error:'Choose a source image no larger than 6 MB.'},413);}chunks.push(value);}
    if(!size)return json({error:'The source image is empty.'},400);
    let binary='';for(const chunk of chunks)for(let at=0;at<chunk.length;at+=16384)binary+=String.fromCharCode(...chunk.subarray(at,at+16384));
    const result=await requestAppsScriptAdmin(context.env,{action:'admin.backfill.media',postKey,mediaId,imageBase64:btoa(binary)});
    return result.ok==='yes'?json(result):json({error:result.error||'The image could not be saved.'},400);
  }catch(error){return json({error:error.message||'Source image upload failed.'},/Cloudflare Access|authorized/i.test(error.message)?403:400);}
}
export function onRequestGet(){return json({error:'Use Archive Backfill to restore an image.'},405);}
