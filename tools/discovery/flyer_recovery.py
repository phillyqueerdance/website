"""Free, bounded recovery of media for active inbox editions. Never starts Apify."""
import copy
from html.parser import HTMLParser
import json
from pathlib import Path
import urllib.request
from media import PublicRedirect, safe_url
from preprocess import media_assets, normalize_dataset, source_code


class PostPage(HTMLParser):
    def __init__(self):
        super().__init__(); self.metadata = {}; self.scripts = []; self.script = None
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'meta' and attrs.get('content'):
            self.metadata[attrs.get('property') or attrs.get('name')] = attrs['content']
        if tag == 'script': self.script = []
    def handle_data(self, data):
        if self.script is not None: self.script.append(data)
    def handle_endtag(self, tag):
        if tag == 'script' and self.script is not None:
            self.scripts.append(''.join(self.script)); self.script = None


def parse_post_page(text, source_url):
    code = source_code(source_url)
    if not code: raise ValueError('Recovery requires a known Instagram post.')
    page = PostPage(); page.feed(text)
    pending = []
    decoder = json.JSONDecoder()
    for script in page.scripts:
        script = script.strip()
        starts = [0]
        if '_sharedData' in script or '__additionalDataLoaded' in script:
            starts += [i for i, c in enumerate(script[:300]) if c == '{']
        for start in starts:
            try: value, _ = decoder.raw_decode(script[start:]); pending.append((value, 0)); break
            except (ValueError, TypeError): pass
    examined = 0
    while pending and examined < 50000:
        value, depth = pending.pop(); examined += 1
        if depth > 64: continue
        if isinstance(value, dict):
            if (value.get('shortcode') or value.get('code')) == code:
                assets = media_assets(value)
                if any(asset['url'] for asset in assets):
                    caption = value.get('caption') or ''
                    if isinstance(caption, dict): caption = caption.get('text', '')
                    edges = (value.get('edge_media_to_caption') or {}).get('edges') or []
                    if edges: caption = edges[0].get('node', {}).get('text') or caption
                    return {'assets': assets, 'caption': caption, 'complete': True, 'method': 'public_post_json'}
            pending += [(child, depth + 1) for child in value.values()]
        elif isinstance(value, list): pending += [(child, depth + 1) for child in value]
        elif isinstance(value, str) and value.lstrip().startswith(('{', '[')):
            try: pending.append((json.loads(value), depth + 1))
            except (ValueError, TypeError): pass
    image = page.metadata.get('og:image') or ''
    video = page.metadata.get('og:video:secure_url') or page.metadata.get('og:video') or ''
    if image or video:
        row = {'image_url': image, 'video_url': video, 'is_video': bool(video or '/reel/' in source_url or '/tv/' in source_url)}
        return {'assets': media_assets(row), 'caption': page.metadata.get('og:description', ''), 'complete': False, 'method': 'public_preview_only'}
    raise ValueError('Public Instagram page did not expose usable post media; it may require login or be unavailable.')


def fetch_post_page(url, stats):
    safe_url(url)
    request = urllib.request.Request(url, headers={'User-Agent': 'QDP-Discovery/2.0 (public event artwork)', 'Accept': 'text/html'})
    stats['recoverySourceRequests'] = stats.get('recoverySourceRequests', 0) + 1
    with urllib.request.build_opener(PublicRedirect).open(request, timeout=25) as response:
        raw = response.read(2 * 1024 * 1024 + 1)
    stats['recoverySourceBytes'] = stats.get('recoverySourceBytes', 0) + len(raw)
    if len(raw) > 2 * 1024 * 1024: raise ValueError('Public post exceeds the bounded retrieval size.')
    return parse_post_page(raw.decode('utf-8'), url)


def saved_posts(records):
    by_key = {row['key']: row for row in records}
    root = by_key.get('state:0', {}).get('value', {})
    section = root.get('manifest', {}).get('inputs')
    if not section: return []
    text = ''.join(by_key[key]['value'] for key in section['parts'])
    import hashlib
    if hashlib.sha256(text.encode()).hexdigest() != section['sha256']: raise ValueError('Saved source evidence checksum mismatch.')
    inputs = json.loads(text)
    posts = inputs.get('posts', [])
    if inputs.get('dataset') is not None:
        raw, _ = normalize_dataset(inputs['dataset']); posts += raw
    return posts


def recover_posts(jobs, collected_posts, stats, prior_loader=None, fetch_page=fetch_post_page):
    current = {post['key']: post for post in collected_posts}
    prior = {}
    recovered = []
    for job in jobs:
        key = job['sourceRef']; post = copy.deepcopy(current.get(key))
        fresh = post and post['assets'] and all(asset['url'] for asset in post['assets'])
        if not post:
            for item in job['items']:
                run_id = item.get('runId')
                if not run_id or prior_loader is None: continue
                if run_id not in prior:
                    try: prior[run_id] = saved_posts(prior_loader(run_id))
                    except Exception: prior[run_id] = []
                match = next((p for p in prior[run_id] if p['key'] == key), None)
                if match: post = copy.deepcopy(match); break
        if not post:
            post = {'key': key, 'id': key, 'ids': [], 'sources': [job['sourceUrl']], 'accounts': [], 'captions': [], 'assets': [], 'taken_at': None}
        errors = []
        if fresh:
            method = 'normal_daily_dataset'
        else:
            method = 'saved_media_and_public_post'
            complete = False
            # Two free public representations at most. Never log in or use a paid actor.
            for url in [job['sourceUrl'], job['sourceUrl'].rstrip('/') + '/embed/captioned/']:
                try:
                    source = fetch_page(url, stats)
                    for asset in source['assets']:
                        if asset not in post['assets']: post['assets'].append(asset)
                    if source.get('caption') and source['caption'] not in post['captions']: post['captions'].append(source['caption'])
                    if source['complete']: complete = True; break
                except Exception as error: errors.append(str(error)[:500])
            if not complete:
                post['assets'].append({'kind': 'unavailable', 'url': '', 'position': 'recovery_source_refresh'})
        for item in job['items']:
            hint = item['fields'].get('RawFlyerURL')
            if hint and hint.startswith('https://') and not any(a['url'] == hint for a in post['assets']):
                post['assets'].append({'kind': 'image', 'url': hint, 'position': 'saved_original_flyer_url'})
        if not post['assets']: post['assets'] = [{'kind': 'unavailable', 'url': '', 'position': 'recovery'}]
        post['flyerRecovery'] = {'id': job['id'], 'targets': job['items'], 'method': method, 'sourceErrors': errors}
        recovered.append(post)
    stats['flyerRecoveryPosts'] = len(recovered)
    return recovered
