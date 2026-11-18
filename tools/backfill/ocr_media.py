import sys,concurrent.futures,io,json,os,pathlib,subprocess,time
from PIL import Image,ImageOps,ImageFile
ImageFile.LOAD_TRUNCATED_IMAGES=True
root=pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else pathlib.Path(__file__).parent
existing={}
if (root/'ocr.jsonl').exists():
    for line in (root/'ocr.jsonl').read_text().splitlines():
        try:
            value=json.loads(line);existing[value['key']]=value
        except Exception: pass
paths=[p for p in sorted((root/'media').glob('*.jpg')) if p.stem not in existing]
def read(path):
    try:
        with Image.open(path) as image:
            thumb=ImageOps.contain(image.convert('RGB'),(1400,1400))
            data=io.BytesIO();thumb.save(data,format='PNG')
        process=subprocess.run(['tesseract','stdin','stdout','--psm','11'],input=data.getvalue(),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=25,env={**os.environ,'OMP_THREAD_LIMIT':'1'})
        return {'key':path.stem,'text':process.stdout.decode(errors='replace'),'status':'read' if process.returncode==0 else 'failed'}
    except Exception as e:return {'key':path.stem,'text':'','status':'failed','error':str(e)}
with (root/'ocr.jsonl').open('a') as output:
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for i,record in enumerate(pool.map(read,paths)):
            output.write(json.dumps(record)+'\n')
            if (i+1)%100==0:output.flush();print('Text read',i+1,'/',len(paths),flush=True)
print('Finished',len(paths),'new images; already read',len(existing),flush=True)
