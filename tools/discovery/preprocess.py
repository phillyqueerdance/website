"""Lossless source normalization. No keyword, identity, genre or date eligibility filter."""
import hashlib
import json
import re
import urllib.parse


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def source_code(url):
    try:
        parsed = urllib.parse.urlsplit(url)
        if parsed.hostname not in ('instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am'):
            return ''
        match = re.match(r'^/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)', parsed.path)
        return match[1] if match else ''
    except (ValueError, TypeError):
        return ''


def image_url(media):
    choices = []
    for key in ('image_url', 'displayUrl', 'display_url', 'thumbnail_url', 'thumbnailUrl'):
        if isinstance(media.get(key), str):
            choices.append((int(media.get('original_width') or 0) * int(media.get('original_height') or 0), media[key]))
    for image in (media.get('image_versions2') or {}).get('candidates', []):
        if image.get('url'):
            choices.append((int(image.get('width') or 0) * int(image.get('height') or 0), image['url']))
    return max(choices, key=lambda pair: pair[0])[1] if choices else ''


def media_assets(row):
    assets = []

    def visit(media, position):
        image = image_url(media)
        video = media.get('video_url') or media.get('videoUrl') or ''
        versions = media.get('video_versions') or []
        if versions:
            video = max(versions, key=lambda v: int(v.get('width') or 0) * int(v.get('height') or 0)).get('url') or video
        children = media.get('carousel_media') or media.get('childPosts') or (media.get('sidecar') or {}).get('edges') or []
        is_video = bool(video or media.get('media_type') == 2 or str(media.get('type', '')).lower() in ('video', 'reel'))
        if image:
            assets.append({'kind': 'preview' if is_video else 'image', 'url': image, 'position': position})
        if is_video:
            assets.append({'kind': 'video', 'url': video, 'position': position})
        # A carousel container cover never substitutes for its children.
        for i, child in enumerate(children):
            visit(child.get('node', child), position + '.' + str(i + 1))
        if not image and not is_video and not children and not media.get('images'):
            assets.append({'kind': 'unavailable', 'url': '', 'position': position})
    visit(row, '0')
    for i, url in enumerate(row.get('images') or []):
        if isinstance(url, str):
            assets.append({'kind': 'image', 'url': url, 'position': 'images.' + str(i)})
    return assets


def normalize_dataset(value):
    if isinstance(value, dict):
        value = value.get('items', value.get('data', value))
    if not isinstance(value, list):
        raise ValueError('Dataset must contain the complete items array, not a tool summary.')
    posts = {}
    failures = []
    for row in value:
        if not isinstance(row, dict):
            raise ValueError('Invalid dataset row.')
        if row.get('error') or not any(k in row for k in ('id', 'pk', 'code', 'post_url', 'url', 'shortCode')):
            failures.append(row)
            continue
        url = row.get('post_url') or row.get('url') or ''
        code = row.get('code') or row.get('shortCode') or source_code(url)
        account = row.get('scraped_username') or row.get('ownerUsername') or row.get('user', {}).get('username') or ''
        pk = str(row.get('pk') or str(row.get('id') or '').split('_')[0])
        ids = {str(v) for v in (row.get('id'), row.get('pk'), code) if v}
        if pk and row.get('user', {}).get('pk'):
            ids.add(pk + '_' + str(row['user']['pk']))
        key = 'ig:' + str(code) if code else 'pk:' + pk if pk else 'unknown:' + fingerprint(row)
        if not url and code:
            # A shortcode supplied by Instagram is source evidence, not a guessed account URL.
            url = 'https://www.instagram.com/p/' + code + '/'
        caption = row.get('caption') or ''
        if isinstance(caption, dict):
            caption = caption.get('text') or ''
        if not isinstance(caption, str):
            raise ValueError('Unsupported caption shape; retain this row for interpretation.')
        current = posts.setdefault(key, {'key': key, 'id': str(row.get('id') or pk or code or key),
            'ids': [], 'sources': [], 'accounts': [], 'captions': [], 'taken_at': row.get('taken_at', row.get('timestamp')), 'assets': []})
        current['ids'] = sorted(set(current['ids']) | ids)
        if url and url not in current['sources']:
            current['sources'].append(url)
        for name in [account] + [p.get('username', '') for p in (row.get('coauthor_producers') or [])]:
            if name and name not in current['accounts']:
                current['accounts'].append(name)
        if caption not in current['captions']:
            current['captions'].append(caption)
        for asset in media_assets(row):
            if asset not in current['assets']:
                current['assets'].append(asset)
    return list(posts.values()), {'rawRows': len(value), 'uniquePosts': len(posts),
        'duplicateRows': len(value) - len(posts) - len(failures), 'collectionErrors': failures}


def partition(posts, screened_ids):
    screened = set(screened_ids)
    known, new = [], []
    for post in posts:
        (known if post['key'] in screened or screened.intersection(post['ids']) else new).append(post)
    return new, known


def compare_schedule(current, previous=None):
    """Retain the last successful schedule on failures; acknowledge only reviewed versions."""
    previous = previous or {}
    rows = current.get('events')
    if rows is None:
        rows = [{'url': url} for url in current.get('eventLinks', [])]
    if current.get('status') not in ('collected', 'empty_confirmed'):
        return {'status': 'unavailable', 'sourceStatus': current.get('status'), 'error': current.get('error') or current.get('note'),
                'entries': rows, 'next': previous, 'unchanged': 0}
    entries, next_rows, unchanged = [], {}, 0
    for row in rows:
        identity = str(row.get('id') or row.get('url') or fingerprint([row.get('title'), row.get('date'), row.get('start')]))
        revision = fingerprint([row.get('url'), row['contentHash']]) if row.get('contentHash') else fingerprint(row)
        prior = previous.get('entries', {}).get(identity)
        if row.get('status') == 'incomplete':
            entries.append({'id': identity, 'change': 'unavailable', 'entry': row})
            if prior: next_rows[identity] = prior
            continue
        next_rows[identity] = {'hash': revision, 'entry': {k: v for k, v in row.items() if k not in ('detailContent', 'retrieval', 'notModified')}, 'reviewed': bool(prior and prior.get('hash') == revision and prior.get('reviewed'))}
        if prior and prior.get('hash') == revision and prior.get('reviewed'):
            unchanged += 1
        else:
            entries.append({'id': identity, 'hash': revision, 'change': 'changed' if prior else 'new', 'entry': row})
    removed = sorted(set(previous.get('entries', {})) - set(next_rows))
    return {'status': 'no_new_entries' if not entries and not removed else 'review', 'entries': entries,
            'removed': removed, 'unchanged': unchanged, 'next': {'entries': next_rows}}
