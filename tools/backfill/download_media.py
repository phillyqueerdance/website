import sys,concurrent.futures, datetime as dt, hashlib, io, json, pathlib, time, urllib.request
from PIL import Image, ImageOps, ImageDraw, ImageFile
ImageFile.LOAD_TRUNCATED_IMAGES = True
root = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else pathlib.Path(__file__).parent
posts = json.loads((root/'all-posts.json').read_text())
media=[]
for p in posts:
    date=dt.datetime.fromtimestamp(p.get('taken_at',0),dt.timezone.utc).strftime('%Y-%m-%d')
    if not '2024-12-01' <= date < '2026-02-01': continue
    for index,m in enumerate(p.get('carousel_media') or [p]):
        if not m.get('image_url'): continue
        media.append({'key':p['code']+'-'+str(index+1),'post':p['pk'],'account':p['scraped_username'], 'date':date,'order':index+1,'id':str(m.get('pk') or m.get('id') or p['pk']), 'url':m['image_url'],'type':m.get('media_type',1),'video_url':m.get('video_url','')})
(root/'media').mkdir(exist_ok=True)
def download(m):
    path=root/'media'/(m['key']+'.jpg')
    try:
        if not path.exists():
            for attempt in range(2):
                try:
                    req=urllib.request.Request(m['url'],headers={'User-Agent':'Mozilla/5.0','Accept':'image/*'})
                    with urllib.request.urlopen(req,timeout=20) as r: data=r.read(16*1024*1024+1)
                    if len(data)>16*1024*1024: raise ValueError('Image exceeds 16 MB')
                    with Image.open(io.BytesIO(data)) as im:im.verify()
                    path.write_bytes(data);break
                except Exception:
                    if attempt:raise
                    time.sleep(.2)
        data=path.read_bytes()
        with Image.open(path) as im:size=im.size
        return dict(m,path=str(path.relative_to(root)),status='saved',sha256=hashlib.sha256(data).hexdigest(),bytes=len(data),width=size[0],height=size[1])
    except Exception as e:return dict(m,status='failed',error=str(e)[:300])
out=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
    for m in pool.map(download,media):
        out.append(m)
        if len(out)%100==0:
            (root/'media-manifest.json').write_text(json.dumps(out))
            print('Downloaded',len(out),'of',len(media),flush=True)
(root/'media-manifest.json').write_text(json.dumps(out))
print({'images':len(out),'saved':sum(m['status']=='saved' for m in out),'bytes':sum(m.get('bytes',0) for m in out)},flush=True)
first=[m for m in out if m['order']==1 and m['status']=='saved']
(root/'contact-sheets').mkdir(exist_ok=True)
for batch in range(0,len(first),24):
    selected=first[batch:batch+24]; sheet=Image.new('RGB',(1680,1560),'#eeeeee');draw=ImageDraw.Draw(sheet)
    for i,m in enumerate(selected):
        x=(i%6)*280;y=(i//6)*390
        with Image.open(root/m['path']) as im:thumb=ImageOps.contain(im.convert('RGB'),(274,330))
        sheet.paste(thumb,(x+(280-thumb.width)//2,y+32))
        draw.text((x+4,y+3),m['key'],fill='black');draw.text((x+4,y+17),m['account']+' '+m['date'],fill='black')
    sheet.save(root/'contact-sheets'/('first-'+str(batch//24+1).zfill(2)+'.jpg'),quality=90)
print('Contact sheets', (len(first)+23)//24,flush=True)
