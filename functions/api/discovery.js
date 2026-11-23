import {discoveryRequest} from '../discovery-api.js';
export const onRequestPost=context=>discoveryRequest(context,true);
export const onRequestGet=()=>Response.json({error:'Discovery task authorization required.'},{status:403,headers:{'Cache-Control':'no-store','X-Robots-Tag':'noindex'}});
