"""Free source media retrieval, original video frames, and labelled contact sheets."""
import concurrent.futures
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import socket
import subprocess
import threading
import urllib.parse
import urllib.request
from PIL import Image, ImageDraw, ImageOps

_LOCK = threading.Lock()


def safe_url(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('Media must use public HTTPS without credentials.')
    for address in socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM):
        if not ipaddress.ip_address(address[4][0]).is_global:
            raise ValueError('Private network media is not permitted.')
    return url


class PublicRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url, target, max_bytes, stats):
    safe_url(url)
    target = Path(target)
    if target.exists():
        return target
    temporary = target.with_suffix('.part')
    target.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={'User-Agent': 'QDP-Discovery/2.0', 'Accept': 'image/*,video/*'})
    try:
        with _LOCK:
            stats['mediaRequests'] = stats.get('mediaRequests', 0) + 1
        with urllib.request.build_opener(PublicRedirect).open(request, timeout=45) as response, temporary.open('wb') as stream:
            if int(response.headers.get('Content-Length') or 0) > max_bytes:
                raise ValueError('Media exceeds the bounded download size; coverage is incomplete.')
            total = 0
            while chunk := response.read(128 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError('Media exceeds the bounded download size; coverage is incomplete.')
                stream.write(chunk)
                with _LOCK:
                    stats['mediaBytes'] = stats.get('mediaBytes', 0) + len(chunk)
        os.replace(temporary, target)
        return target
    finally:
        temporary.unlink(missing_ok=True)


def command(args, timeout=180):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('Media decoder failed: ' + result.stderr[-500:])
    return result


def frames(path, directory):
    path, directory = Path(path), Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    probe = json.loads(command(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=avg_frame_rate', '-of', 'json', str(path)]).stdout)
    duration = float(probe['format']['duration'])
    if not math.isfinite(duration) or duration <= 0 or duration > 10800:
        raise ValueError('Unsupported clip duration; record incomplete video coverage.')
    rate_text = next((s.get('avg_frame_rate') for s in probe.get('streams', []) if s.get('avg_frame_rate') not in (None, '0/0')), '25/1')
    numerator, denominator = map(float, rate_text.split('/'))
    interval = denominator / numerator if numerator else .04
    last = max(0, duration - max(.1, interval * 1.5))
    timestamps = {0.0, last, *[round(last * fraction, 3) for fraction in (.1, .25, .5, .75, .9)],
                  *[round(min(last, i * 3.0), 3) for i in range(1, math.ceil(duration / 3))]}
    # Decode the complete clip for scene boundaries. No paid vision/OCR service is involved.
    scene = command(['ffmpeg', '-nostdin', '-hide_banner', '-i', str(path), '-an',
        '-vf', "select='gt(scene,0.12)',showinfo", '-fps_mode', 'vfr', '-f', 'null', '-'])
    transitions = [float(t) for t in re.findall(r'pts_time:([\d.]+)', scene.stderr)]
    for t in transitions:
        timestamps.update(round(max(0, min(last, t + offset)), 3) for offset in (-.3, -.15, 0, .15, .3))
    results = []
    for t in sorted(timestamps):
        target = directory / (f'{t:012.3f}.png')
        if not target.exists():
            # PNG retains the decoded original frame at its full dimensions. No reconstruction.
            command(['ffmpeg', '-nostdin', '-v', 'error', '-ss', str(t), '-i', str(path), '-frames:v', '1', '-update', '1', str(target)])
        if not target.exists():
            raise RuntimeError('A requested video frame was not produced; coverage is incomplete.')
        results.append({'path': str(target), 'seconds': t, 'kind': 'frame',
                        'sample': 'transition' if any(abs(t - s) <= .301 for s in transitions) else 'representative'})
    return results, {'duration': duration, 'transitions': len(transitions), 'samplingComplete': True, 'fullVideoAudioReview': False}


def describe_image(asset):
    path = Path(asset['path'])
    with Image.open(path) as image:
        image.verify()
    with Image.open(path) as image:
        width, height = image.size
    return {**asset, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'width': width, 'height': height}


def prepare_media(posts, directory, stats, fetch=download):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    jobs, manifest = {}, []
    for post in posts:
        for source in post['assets']:
            key = hashlib.sha256((source['kind'] + '|' + source['url']).encode()).hexdigest()
            if key not in jobs:
                jobs[key] = source
            manifest.append({'postKey': post['key'], 'sourceUrl': post['sources'][0] if post['sources'] else '', 'assetKey': key, **source})

    def process(job):
        key, asset = job
        try:
            cache_file = directory / (key + '.json')
            if cache_file.exists():
                prior = json.loads(cache_file.read_text())
                if prior.get('status') != 'unavailable' and all(Path(image['path']).exists() and
                    hashlib.sha256(Path(image['path']).read_bytes()).hexdigest() == image['sha256'] for image in prior.get('images', [])):
                    return key, prior
            if not asset['url']:
                raise ValueError('Source did not expose this media URL.')
            path = fetch(asset['url'], directory / (key + ('.mp4' if asset['kind'] == 'video' else '.image')),
                         256 * 1024 * 1024 if asset['kind'] == 'video' else 32 * 1024 * 1024, stats)
            if asset['kind'] == 'video':
                images, coverage = frames(path, directory / (key + '-frames'))
                result = {'status': 'sampled', 'path': str(path), 'images': [describe_image(i) for i in images], **coverage}
            else:
                result = {'status': 'downloaded', 'images': [describe_image({'path': str(path), 'kind': asset['kind']})]}
            cache_file.write_text(json.dumps(result))
            return key, result
        except Exception as error:
            # Preserve a typed failure and never equate missing media with an irrelevant post.
            return key, {'status': 'unavailable', 'error': str(error)}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        processed = dict(pool.map(process, jobs.items()))
    unique, visuals = {}, []
    for asset in manifest:
        result = processed[asset['assetKey']]
        asset.update(result)
        for image in result.get('images', []):
            image['visualId'] = 'visual-' + image['sha256'][:20]
            if image['sha256'] not in unique:
                unique[image['sha256']] = image
                visuals.append(image)
    sheets = contact_sheets(visuals, directory)
    stats.update({'imagesDownloaded': sum(r['status'] == 'downloaded' for r in processed.values()),
                  'videosSampled': sum(r['status'] == 'sampled' for r in processed.values()),
                  'framesGenerated': sum(len(r.get('images', [])) for r in processed.values() if r['status'] == 'sampled'),
                  'uniqueVisuals': len(visuals), 'unavailableMedia': sum(r['status'] == 'unavailable' for r in processed.values())})
    return {'assets': manifest, 'visuals': visuals, 'contactSheets': sheets}


def contact_sheets(visuals, directory, per_page=12):
    sheets = []
    for offset in range(0, len(visuals), per_page):
        page = visuals[offset:offset + per_page]
        canvas = Image.new('RGB', (1536, math.ceil(len(page) / 3) * 560), '#202020')
        draw = ImageDraw.Draw(canvas)
        for i, asset in enumerate(page):
            x, y = (i % 3) * 512, (i // 3) * 560
            with Image.open(asset['path']) as image:
                thumb = ImageOps.contain(ImageOps.exif_transpose(image).convert('RGB'), (500, 500))
                canvas.paste(thumb, (x + (512 - thumb.width) // 2, y))
            draw.text((x + 8, y + 502), asset['visualId'], fill='white')
            draw.text((x + 8, y + 523), f"{asset['kind']} {asset.get('seconds', '')} {asset['width']}x{asset['height']}", fill='white')
        path = Path(directory) / ('contact-' + str(offset // per_page + 1).zfill(3) + '.jpg')
        canvas.save(path, quality=93)
        sheets.append({'id': path.stem, 'path': str(path), 'visualIds': [a['visualId'] for a in page]})
    return sheets
