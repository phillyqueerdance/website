import {discoveryRequest} from '../discovery-api.js';
export const onRequestPost=context=>discoveryRequest(context,false);
export const onRequestGet=context=>context.next();
export const onRequestHead=onRequestGet;
