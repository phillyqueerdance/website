#!/usr/bin/env python3
"""Restricted QDP inbox client. Credentials stay in a private connection file."""
import argparse,json,urllib.request,urllib.error,urllib.parse,pathlib,time

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        raise RuntimeError('The QDP inbox redirected. No credentials were forwarded.')

def request(connection,action,body=None,metrics=None):
    url=connection.get('url','')
    parsed=urllib.parse.urlsplit(url)
    if parsed.scheme!='https' or parsed.hostname not in ('queerdancephilly.com','qdp-ali.pages.dev') or parsed.path!='/api/discovery' or parsed.query or parsed.fragment:
        raise ValueError('Use the configured QDP discovery endpoint only.')
    payload=json.dumps({**(body or {}),'action':action}).encode()
    started=time.monotonic()
    if metrics is not None:
        metrics['httpRequests']=metrics.get('httpRequests',0)+1
        metrics['wireRequestBytes']=metrics.get('wireRequestBytes',0)+len(payload)
    req=urllib.request.Request(url,data=payload,headers={'Content-Type':'application/json','Authorization':'Bearer '+connection['token'],'User-Agent':'QDP-Discovery/1.0 (+https://queerdancephilly.com)'})
    try:
        with urllib.request.build_opener(NoRedirect).open(req,timeout=300) as response:
            raw=response.read(16*1024*1024+1)
            if metrics is not None:metrics['wireResponseBytes']=metrics.get('wireResponseBytes',0)+len(raw)
            if len(raw)>16*1024*1024:raise RuntimeError('The bounded discovery response is too large.')
            result=json.loads(raw)
    except urllib.error.HTTPError as error:
        try: detail=json.loads(error.read()).get('error','Request failed')
        except Exception: detail='The QDP endpoint returned HTTP '+str(error.code)
        raise RuntimeError(detail) from None
    if metrics is not None:metrics['wireSeconds']=metrics.get('wireSeconds',0)+time.monotonic()-started
    if result.get('ok')!='yes':raise RuntimeError(result.get('error','The operation was not confirmed.'))
    return result

def all_items(connection,view='all'):
    items=[];offset=0
    while True:
        result=request(connection,'items',{'view':view,'offset':offset,'limit':50})
        items.extend(result['items']);offset+=50
        if offset>=result['total']:return items

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--connection',required=True)
    parser.add_argument('--action',required=True)
    parser.add_argument('--input');parser.add_argument('--output',required=True)
    args=parser.parse_args()
    connection=json.loads(pathlib.Path(args.connection).read_text())
    body=json.loads(pathlib.Path(args.input).read_text()) if args.input else {}
    if args.action=='review-state':
        boot=request(connection,'bootstrap');items=all_items(connection);posts=[];after=''
        while True:
            page=request(connection,'posts.read',{'after':after});posts.extend(page['posts'])
            if not page.get('cursor'):break
            after=page['cursor']
        result={**boot,'items':items,'screenedPosts':posts}
    elif args.action=='deliver':
        results=[]
        for offset in range(0,len(body['items']),10):results.append(request(connection,'stage',{'items':body['items'][offset:offset+10]}))
        result={'ok':'yes','staged':sum(x['staged'] for x in results),'reviewUrl':'https://queerdancephilly.com/admin/discovery'}
    elif args.action=='screened-posts':
        count=0
        for offset in range(0,len(body['posts']),30):count+=request(connection,'posts.save',{'posts':body['posts'][offset:offset+30]})['saved']
        result={'ok':'yes','saved':count}
    else:result=request(connection,args.action,body)
    pathlib.Path(args.output).write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps({'action':args.action,'ok':result.get('ok','yes'),'staged':result.get('staged'),'saved':result.get('saved')}))

if __name__=='__main__':main()
