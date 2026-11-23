import {discoveryRequest} from '../discovery-api.js';
export const onRequestPost=context=>discoveryRequest(context,false);
export const onRequestGet=()=>Response.json({error:'Use Discovery Review in QDP Admin.'},{status:405,headers:{'Cache-Control':'no-store'}});
