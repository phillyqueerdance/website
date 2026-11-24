#!/usr/bin/env python3
"""Resumable QDP discovery orchestration. AI interpretation stays in the scheduled ChatGPT task.

This command never launches a scraper, calls a paid AI API, imports, or publishes.
The existing authorized Apify tool is the collection bridge; its result is attached here.
"""
import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
from zoneinfo import ZoneInfo
from preprocess import normalize_dataset, partition, compare_schedule, fingerprint, source_code
from media import prepare_media
from flyer_recovery import recover_posts

ROOT = Path(__file__).resolve().parent

def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result

CLIENT = module('inbox_client', 'inbox-client.py')
VENUES = module('venue_collector', 'collect-venues.py')
NOW = lambda: datetime.now(timezone.utc).isoformat()
DAY = lambda: datetime.now(ZoneInfo('America/New_York')).date().isoformat()
ACTOR = 'sones/instagram-posts-scraper-lowcost'


def write_json(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)


def chunks(values, size):
    for offset in range(0, len(values), size):
        yield values[offset:offset + size]


class Pipeline:
    def __init__(self, connection, directory, run_id, transport=None):
        self.connection, self.directory, self.run_id = connection, Path(directory).resolve(), run_id
        self.directory.mkdir(parents=True, exist_ok=True); self.directory.chmod(0o700)
        self.transport = transport or (lambda action, body: CLIENT.request(connection, action, body, metrics=self.metrics))
        self.state = {'runId': run_id, 'startedAt': NOW(), 'phase': 'new', 'progress': {}}
        self.data, self.records, self.manifest, self.next_indexes = {}, {}, {}, {}
        self.metrics = {'stagesSeconds': {}, 'apiRequests': 0, 'serializedApiRequestBytes': 0, 'serializedApiResponseBytes': 0,
                        'scriptInvocations': 0, 'chatgptToolCalls': None, 'aiReviewWorkload': {}}

    def api(self, action, body=None):
        body = body or {}
        started = time.monotonic()
        for attempt in range(3):
            self.metrics['apiRequests'] += 1
            self.metrics['serializedApiRequestBytes'] += len(json.dumps({'action': action, **body}).encode())
            try:
                result = self.transport(action, body)
                self.metrics['serializedApiResponseBytes'] += len(json.dumps(result, ensure_ascii=False).encode())
                return result
            except (RuntimeError, OSError) as error:
                transient = any(word in str(error).lower() for word in ('timeout','timed out','temporarily','http 502','http 503','http 504','connection reset','response lost'))
                if not transient or attempt == 2: raise
                self.metrics['safeRetries'] = self.metrics.get('safeRetries', 0) + 1
                time.sleep(.2 * (attempt + 1))
            finally:
                self.metrics['apiSeconds'] = self.metrics.get('apiSeconds', 0) + time.monotonic() - started
                started = time.monotonic()

    @contextmanager
    def stage(self, name):
        started = time.monotonic()
        try:
            yield
        finally:
            stages = self.metrics['stagesSeconds']
            stages[name] = stages.get(name, 0) + time.monotonic() - started

    def load(self):
        response = self.api('work.read', {'runId': self.run_id})
        self.records = {r['key']: r for r in response['records']}
        self.next_indexes = response.get('nextIndexes', {})
        root = self.records.get('state:0')
        if root:
            self.state = root['value']['state']; self.manifest = root['value']['manifest']
            for section, info in self.manifest.items():
                content = ''.join(self.records[key]['value'] for key in info['parts'])
                if hashlib.sha256(content.encode()).hexdigest() != info['sha256']:
                    raise RuntimeError('Durable pipeline checkpoint is incomplete; do not start another collection.')
                self.data[section] = json.loads(content)
            previous = self.data.get('metrics', {})
            for key in ('apiRequests','serializedApiRequestBytes','serializedApiResponseBytes','apiSeconds','httpRequests','wireRequestBytes','wireResponseBytes','wireSeconds'):
                previous[key] = previous.get(key, 0) + self.metrics.get(key, 0)
            self.metrics = previous
        self.metrics['scriptInvocations'] = self.metrics.get('scriptInvocations', 0) + 1
        return self

    def save(self):
        self.data['metrics'] = self.metrics
        write_json(self.directory / 'checkpoint.json', {'state': self.state, 'data': self.data})
        manifest = dict(self.manifest)
        for section, value in self.data.items():
            content = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
            sha = hashlib.sha256(content.encode()).hexdigest()
            if manifest.get(section, {}).get('sha256') == sha:
                continue
            # New numbered parts never overwrite the last committed generation.
            index = max(self.next_indexes.get(section, 0), max([int(k.split(':')[1]) for k in self.records if k.startswith(section + ':')] or [-1]) + 1)
            parts = []
            for part in chunks(content, 90000):
                key = section + ':' + str(index); index += 1
                saved = self.api('work.save', {'runId': self.run_id, 'key': key, 'value': part, 'version': 0})
                self.records[key] = {'key': key, 'value': part, 'version': saved['version']}; parts.append(key)
            self.next_indexes[section] = index
            manifest[section] = {'sha256': sha, 'parts': parts}
        value = {'state': self.state, 'manifest': manifest}
        result = self.api('work.save', {'runId': self.run_id, 'key': 'state:0', 'value': value,
                                       'version': self.records.get('state:0', {}).get('version', 0)})
        self.records['state:0'] = {'key': 'state:0', 'value': value, 'version': result['version']}
        self.manifest = manifest

    def boot(self):
        result = self.api('pipeline.bootstrap', {'day': DAY()})
        if result.get('pipelineVersion') != 1:
            raise RuntimeError('The optimized endpoint has not been deployed; do not spend actor credits.')
        return result

    def patch_checkpoint(self, patch):
        boot = self.boot(); checkpoint = boot['checkpoint']
        active = checkpoint['value'].get('activeRun')
        if active and active != self.run_id:
            raise RuntimeError('Another review is active. Resume it; do not overwrite its checkpoint.')
        self.api('checkpoint.patch', {'version': checkpoint['version'], 'value': patch})

    def run_summary(self, status, charge=None):
        previous = self.api('run.read', {'id': self.run_id}).get('run') or {}
        body = {'id': self.run_id, 'status': status,
                'data': {**previous.get('data', {}), 'pipeline': {'phase': self.state['phase'], 'metrics': self.metrics,
                    'collection': self.state.get('collection'), 'coverage': self.state.get('coverage')}}}
        if charge is not None:
            body['actualUsd'] = charge
        self.api('run.save', body)

    def begin(self, reserve=False):
        with self.stage('preflight'):
            boot = self.boot()
            sync = self.api('snapshot.sync')
            if sync.get('inboxVersion') != 1:
                raise RuntimeError('Snapshot validation failed. Do not start paid collection.')
            self.state['snapshot'] = sync
            if boot['config'].get('actor') != ACTOR:
                raise ValueError('The approved QDP actor configuration changed; no collection is authorized by this plan.')
            if self.state.get('collection'):
                return {'resume': self.state['collection'], 'startAuthorized': False}
            active = boot['checkpoint']['value'].get('activeRun')
            if active and active != self.run_id:
                return {'resumeRunId': active, 'startAuthorized': False}
            cutoff = boot['checkpoint']['value'].get('last_completed_collection_at')
            if not cutoff:
                raise ValueError('A collection cutoff is required.')
            cutoff = datetime.fromisoformat(cutoff.replace('Z', '+00:00')) - timedelta(hours=6)
            spent = sum(row['actual_usd'] if row['actual_usd'] is not None else row['reserved_usd'] for row in boot['budget'])
            remaining = math.floor((.59 - spent + 1e-8) * 100) / 100
            plan = {'actor': ACTOR, 'usernames': boot['config']['usernames'], 'postsPerProfile': 3,
                    'newerThan': cutoff.isoformat(), 'memoryMb': 1024, 'timeoutSeconds': 1800,
                    'maxTotalChargeUsd': remaining, 'schemaAndPricingMustBeChecked': True}
            write_json(self.directory / 'collection-plan.json', plan)
            if remaining <= 0:
                return {'startAuthorized': False, 'remainingUsd': remaining, 'reuseRuns': boot['budget']}
            if reserve:
                reservation = self.api('budget.reserve', {'id': self.run_id, 'amount': remaining})
                if not reservation['created']:
                    return {'startAuthorized': False, 'reservation': reservation['reservation'], 'reason': 'Existing reservation is not permission to launch again.'}
                self.state['collection'] = {'reservationId': self.run_id, 'reservedUsd': remaining,
                    'launchState': 'claimed', 'plan': plan}
                self.state['phase'] = 'collection_claimed'
                self.save(); self.run_summary('collection_claimed'); self.patch_checkpoint({'activeRun': self.run_id})
            return {'startAuthorized': bool(reserve), 'planFile': str(self.directory / 'collection-plan.json'), 'remainingUsd': remaining}

    def attach(self, result):
        with self.stage('collection_receipt'):
            collection = self.state.get('collection')
            if not collection:
                raise ValueError('Attach only to this pipeline\'s existing reservation; no actor was authorized here.')
            if result.get('actorName') != ACTOR or not result.get('runId'):
                raise ValueError('An exact approved QDP actor run receipt is required.')
            if collection.get('actorRunId') and collection['actorRunId'] != result['runId']:
                raise ValueError('This reservation is already bound to another actor run.')
            stores = result.get('storages', {})
            collection.update({'actorRunId': result['runId'], 'datasetId': stores.get('datasets', {}).get('default', {}).get('id'),
                'storeId': stores.get('keyValueStores', {}).get('default', {}).get('id'), 'status': result.get('status'),
                'startedAt': result.get('startedAt'), 'finishedAt': result.get('finishedAt'),
                'expectedItems': stores.get('datasets', {}).get('default', {}).get('itemCount'),
                'statusMessage': result.get('statusMessage'), 'stats': result.get('stats'), 'profileCoverage': result.get('collectionSummary')})
            charge = result.get('charge')
            actual = None
            if charge:
                if not (charge.get('confirmed') is True and charge.get('runId') == result['runId'] and
                        charge.get('source') == 'Apify run.usageTotalUsd' and isinstance(charge.get('amountUsd'), (int, float)) and charge['amountUsd'] >= 0):
                    raise ValueError('Only a confirmed exact Apify run charge may settle its reservation.')
                actual = charge['amountUsd']; collection['confirmedActualUsd'] = actual
            self.state['phase'] = 'collected' if result.get('status') == 'SUCCEEDED' else 'collecting'
            self.save(); self.run_summary(self.state['phase'], actual); self.patch_checkpoint({'activeRun': self.run_id})

    def prepare(self, dataset=None, venue_result=None):
        if self.state.get('phase') == 'complete':
            return self.report()
        with self.stage('preprocessing'):
            if dataset is not None:
                self.data['inputs'] = {**self.data.get('inputs', {}), 'dataset': dataset}
            dataset = self.data.get('inputs', {}).get('dataset')
            if dataset is None:
                raise ValueError('Attach the complete saved dataset before preprocessing.')
            collection = self.state.get('collection', {})
            raw = dataset.get('items') if isinstance(dataset, dict) else dataset
            if collection.get('expectedItems') is not None and len(raw) != collection['expectedItems']:
                raise ValueError('Dataset pagination is incomplete; retain collection and fetch only missing pages.')
            posts, counts = normalize_dataset(dataset)
            ids = sorted({identity for post in posts for identity in post['ids']})
            screened = []
            for group in chunks(ids, 300):
                related = [post for post in posts if set(post['ids']).intersection(group)]
                urls = list(dict.fromkeys(url for post in related for url in post['sources']))
                for sources in list(chunks(urls, 300)) or [[]]:
                    lookup = self.api('posts.lookup', {'ids': group, 'sources': sources})
                    screened += lookup['screenedIds'] + lookup.get('screenedKeys', [])
            new, known = partition(posts, screened)
            new_count = len(new)
            if 'flyerRecoveryJobs' not in self.data['inputs']:
                recovery = self.api('flyer-retries.claim', {'runId': self.run_id, 'limit': 10})
                self.data['inputs']['flyerRecoveryJobs'] = recovery['jobs']
                self.metrics['flyerRecoveryDeferred'] = recovery.get('deferred', 0)
                self.save()  # Claims survive interruption before free source retrieval.
            jobs = self.data['inputs']['flyerRecoveryJobs']
            recovered = recover_posts(jobs, posts, self.metrics,
                prior_loader=lambda run_id: self.api('work.read', {'runId': run_id, 'sections': ['inputs']})['records'])
            new_keys = {post['key'] for post in new}
            for post in recovered:
                if post['key'] in new_keys:
                    new = [post if original['key'] == post['key'] else original for original in new]
                else:
                    post['isFlyerRecovery'] = True; new.append(post)
            known_keys = {post['key'] for post in known}
            recovered_known = sum(post['key'] in known_keys for post in recovered)
            self.data['inputs'].update({'posts': new, 'counts': {**counts, 'screenedPostsSkipped': len(known) - recovered_known,
                'screenedPostsRecovered': recovered_known, 'newPosts': new_count}})
            self.metrics.update(self.data['inputs']['counts'])
        self.state['phase'] = 'preparing_media'; self.save()
        with self.stage('media_preprocessing'):
            self.data['media'] = prepare_media(new, self.directory / 'media', self.metrics)
        with self.stage('venue_comparison'):
            previous = {key: self.api('venues.read', {'source': key})['state'] for key in ('vals','dolphin','wow')}
            result = venue_result if venue_result is not None else VENUES.collect_all({k: (v or {}).get('value', {}) for k, v in previous.items()}, stats=self.metrics)
            comparisons = {}
            for venue in result['venues']:
                key = venue['key']; old = previous.get(key) or {'version': 0, 'value': {}}
                comparisons[key] = {'version': old['version'], 'source': venue.get('source'), 'venue': venue.get('venue'),
                    **compare_schedule(venue, old['value'])}
            self.data['venues'] = comparisons
        self.state['phase'] = 'awaiting_review'
        self.state.setdefault('reviewInputsReadyAt', NOW())
        finished = self.state.get('collection', {}).get('finishedAt')
        if finished and self.state.get('collection', {}).get('status') == 'SUCCEEDED':
            prior = self.boot()['checkpoint']['value'].get('last_completed_collection_at')
            boundary = max([value for value in (finished, prior) if value], key=lambda value: datetime.fromisoformat(value.replace('Z', '+00:00')))
            self.patch_checkpoint({'activeRun': self.run_id, 'last_completed_collection_at': boundary})
        self.metrics['aiReviewWorkload'] = {'posts': len(new), 'captions': sum(len(p['captions']) for p in new),
            'uniqueVisuals': len(self.data['media']['visuals']), 'contactSheets': len(self.data['media']['contactSheets']),
            'venueEntries': sum(len(v['entries']) for v in comparisons.values())}
        self.save(); self.run_summary('awaiting_review')
        self.export_review_inputs()
        return {'phase': self.state['phase'], 'reviewInputs': str(self.directory / 'ai-review-inputs.json'),
                'newPosts': len(new), 'visuals': len(self.data['media']['visuals'])}

    def evidence(self, sources):
        """Register freely retrieved venue/ticket/public artwork without another collection."""
        if not isinstance(sources, list): raise ValueError('Supply a sources array.')
        with self.stage('public_evidence_media'):
            existing = {post['key'] for post in self.data['inputs']['posts']}
            for source in sources:
                url = source.get('sourceUrl', '')
                if not url.startswith('https://') or source.get('verified') is not True:
                    raise ValueError('Public artwork needs its verified event source URL.')
                key = 'public:' + fingerprint(url)
                assets = [{'kind': 'image', 'url': image, 'position': 'public.' + str(i)} for i, image in enumerate(source.get('images', []))]
                if not assets: continue
                if key in existing:
                    post = next(post for post in self.data['inputs']['posts'] if post['key'] == key)
                    post['assets'] += [asset for asset in assets if asset not in post['assets']]
                else:
                    self.data['inputs']['posts'].append({'key': key, 'id': key, 'ids': [], 'sources': [url], 'accounts': [],
                        'captions': [source.get('evidence', '')], 'taken_at': None, 'assets': assets, 'isPublicEvidence': True})
                    existing.add(key)
            self.data['media'] = prepare_media(self.data['inputs']['posts'], self.directory / 'media', self.metrics)
            self.metrics['aiReviewWorkload']['publicSources'] = sum(bool(p.get('isPublicEvidence')) for p in self.data['inputs']['posts'])
        self.export_review_inputs(); self.save()
        return {'reviewInputs': str(self.directory / 'ai-review-inputs.json'), 'publicSources': self.metrics['aiReviewWorkload']['publicSources']}

    def export_review_inputs(self):
        payload = {'runId': self.run_id, 'posts': self.data['inputs']['posts'], 'media': self.data['media'],
                   'venues': {key: {k: v for k, v in value.items() if k != 'next'} for key, value in self.data['venues'].items()},
                   'searchPlan': search_plan(self.data['venues']), 'noKeywordFiltering': True,
                   'reviewContract': {'postReviews': 'One per new post: key, captionReviewed, flyerOutcome, reviewedSheets, fullResolutionVisuals, acknowledgedUnavailable.',
                    'flyers': 'Verified original visualId plus candidateIndex/correctionIndex, or recoveryId and targetIds from flyerRecovery. Each chosen flyer requires a full-resolution inspection. Recovery only supplies artwork; retain the saved event facts.',
                    'facts': 'Supply edition date, source URLs, aliases and existing EventID when known. Undated leads cannot establish absence.',
                    'searchReceipts': 'Record targeted venue fallback queries and actual source coverage; broader discovery, news and mentions belong to the separate daily task.',
                    'venueReviews': 'List source, id, hash for each reviewed new/changed venue entry; do not acknowledge unavailable pages.'}}
        write_json(self.directory / 'ai-review-inputs.json', payload)

    def restore_media(self):
        media = self.data.get('media', {})
        if not any(not Path(v['path']).exists() for v in media.get('visuals', [])):
            return
        old_ids = {v['visualId'] for v in media['visuals']}
        restored = prepare_media(self.data['inputs']['posts'], self.directory / 'media', self.metrics)
        new_ids = {v['visualId'] for v in restored['visuals']}
        self.data['media'] = restored; self.export_review_inputs(); self.save()
        if old_ids != new_ids:
            raise RuntimeError('Source media was restored with different or unavailable originals. Complete the changed visual review before finishing; no new collection is needed.')

    def review_facts(self, review):
        facts = facts_for(review)
        for job in self.data.get('inputs', {}).get('flyerRecoveryJobs', []):
            for item in job['items']:
                fields = item['fields']
                facts.append({'date': fields.get('StartDate') or item.get('date', ''), 'title': fields.get('Title (internal)', ''),
                    'location': fields.get('Location', ''), 'venueId': fields.get('VenueID', ''), 'sources': [job['sourceUrl']],
                    'eventId': item.get('result', {}).get('eventId') or item.get('eventId'), 'aliases': item.get('discovery', {}).get('aliases', [])})
        return facts

    def match(self, review):
        self.data['review'] = review
        with self.stage('matching'):
            facts = self.review_facts(review)
            snapshots = [self.api('match', {'facts': group}) for group in chunks(facts, 50)]
            snapshot = merge_matches(snapshots)
            self.data['review']['matching'] = snapshot
            write_json(self.directory / 'matching.json', snapshot)
        self.save()
        return {'matching': str(self.directory / 'matching.json'), 'complete': snapshot.get('matchingComplete', False)}

    def selected_items(self, selection, payload):
        if 'recoveryId' in selection:
            jobs = {job['id']: job for job in self.data['inputs'].get('flyerRecoveryJobs', [])}
            job = jobs.get(selection['recoveryId'])
            if not job or not isinstance(selection.get('targetIds'), list) or not selection['targetIds']:
                raise ValueError('Select an actual flyer recovery job and its target IDs.')
            if set(selection['targetIds']) - {target['id'] for target in job['items']}:
                raise ValueError('Recovery artwork cannot be attached to an unrelated proposal.')
            assets = [a for a in self.data['media']['assets'] if a['postKey'] == job['sourceRef']]
            if not any(image['visualId'] == selection.get('visualId') for asset in assets for image in asset.get('images', [])):
                raise ValueError('Recovery artwork must belong to the reviewed recovery post.')
            return [item for item in payload['items'] if item.get('_review', {}).get('kind') == 'recovery' and
                    item['_review']['recoveryId'] == job['id'] and item['_review']['index'] in selection['targetIds']]
        target = {'kind': 'candidate', 'index': selection['candidateIndex']} if 'candidateIndex' in selection else {'kind': 'correction', 'index': selection['correctionIndex']}
        return [item for item in payload['items'] if item.get('_review') == target]

    def upload_original(self, identity, visual, asset, original):
        image = visual['kind'] != 'frame'
        prefix = 'flyers.image' if image else 'flyers.frame'
        parts = list(chunks(original, 96 * 1024))
        source = {'postUrl': asset['sourceUrl'], 'verified': True}
        if not image: source['seconds'] = visual['seconds']
        for i, part in enumerate(parts):
            self.api(prefix + '.part', {'id': identity, 'sha256': visual['sha256'], 'index': i, 'total': len(parts),
                'base64': base64.b64encode(part).decode(), 'source': source})
        return self.api(prefix + '.commit', {'id': identity, 'sha256': visual['sha256']})

    def preserve(self, payload, review):
        media = self.data['media']; visuals = {v['visualId']: v for v in media['visuals']}
        full = {v for r in review.get('postReviews', []) for v in r.get('fullResolutionVisuals', [])}
        progress = self.state['progress'].setdefault('flyers', {})
        saved_posts, frame_posts = set(), set()
        for selection in review.get('flyers', []):
            visual = visuals.get(selection.get('visualId'))
            if not visual or visual['visualId'] not in full or selection.get('verified') is not True:
                raise ValueError('Preserve only a verified actual flyer inspected at full resolution.')
            for item in self.selected_items(selection, payload):
                identity = item.get('discovery', {}).get('id') or item['_preservationId']
                original = Path(visual['path']).read_bytes()
                if hashlib.sha256(original).hexdigest() != visual['sha256']:
                    raise ValueError('The selected original media changed; inspect it again before saving.')
                receipt_key = identity + ':' + visual['sha256']; saved = progress.get(receipt_key)
                asset = next((a for a in media['assets'] if any(i['visualId'] == visual['visualId'] for i in a.get('images', []))), None)
                if not asset: raise ValueError('The selected visual has no source association.')
                if visual['kind'] == 'frame': frame_posts.add(asset['postKey'])
                if not saved:
                    try:
                        if visual['kind'] == 'frame':
                            saved = self.upload_original(identity, visual, asset, original)
                        else:
                            response = self.api('flyers', {'items': [{'id': identity, 'fields': {'RawFlyerURL': asset['url'],
                                'Title (internal)': item['fields'].get('Title (internal)', '')}}]})
                            saved = next((f for f in response.get('flyers', []) if f['id'] == identity), {})
                            if (not saved.get('url') or saved.get('error')) and source_code(asset['sourceUrl']):
                                # Instagram can allow the local download but reject Apps Script.
                                # Preserve those exact inspected bytes instead of losing the flyer.
                                saved = self.upload_original(identity, visual, asset, original)
                        if not saved.get('url') or saved.get('error'):
                            raise RuntimeError(saved.get('error', 'No preservation receipt'))
                        saved['fromVideo'] = visual['kind'] == 'frame'; progress[receipt_key] = saved; self.save()
                    except (RuntimeError, ValueError) as error:
                        self.state.setdefault('flyerErrors', []).append({'id': identity, 'error': str(error), 'fromVideo': visual['kind'] == 'frame'})
                        item['readiness'] = 'waiting: flyer preservation unconfirmed'
                        item['note'] = (item.get('note', '') + '\nFlyer identified; preservation unconfirmed: ' + str(error)).strip()
                        self.save(); continue
                item['fields']['Flyer_URL'] = saved['url']; saved_posts.add(asset['postKey'])
                for error in self.state.get('flyerErrors', []):
                    if error['id'] == identity: error['resolvedAt'] = NOW()
                if item.get('_review', {}).get('kind') == 'recovery': item['readiness'] = 'Flyer recovered; review saved event details.'
                if visual['kind'] != 'frame': item['fields']['RawFlyerURL'] = asset['url']
                if item['kind'] == 'correction': item['changes']['flyer'] = saved['url']
        for post in review.get('postReviews', []):
            if post['key'] in saved_posts: post['flyerOutcome'] = 'saved'
            elif post.get('flyerOutcome') == 'saved': post['flyerOutcome'] = 'preservation_failed'
        self.metrics['videoFlyersIdentifiedButUnsaved'] = len(frame_posts - saved_posts)
        self.metrics['flyersVerified'] = len(review.get('flyers', []))
        self.metrics['flyersPreserved'] = len(progress)
        self.metrics['videoFlyersPreserved'] = sum(bool(v.get('fromVideo')) for v in progress.values())

    def complete_recovery(self, payload):
        done = self.state['progress'].setdefault('completedRecoveryJobs', {})
        for job in self.data['inputs'].get('flyerRecoveryJobs', []):
            if job['id'] in done: continue
            recovered = []
            for item in payload['items']:
                info = item.get('_review', {})
                if info.get('kind') == 'recovery' and info.get('recoveryId') == job['id'] and item['fields'].get('Flyer_URL'):
                    recovered.append({'targetId': info['index'], 'proposalId': item.get('discovery', {}).get('id') or item['_preservationId'], 'url': item['fields']['Flyer_URL']})
            assets = [asset for asset in self.data['media']['assets'] if asset['postKey'] == job['sourceRef']]
            selected = any(s.get('recoveryId') == job['id'] for s in self.data.get('review', {}).get('flyers', []))
            unavailable = any(asset['status'] == 'unavailable' for asset in assets) or (selected and not recovered)
            receipt = self.api('flyer-retries.complete', {'runId': self.run_id, 'id': job['id'], 'version': job['version'], 'lease': job['lease'],
                'outcome': 'saved' if recovered else 'unavailable' if unavailable else 'not_found', 'saved': recovered,
                'error': 'Source/media retrieval or preservation remains incomplete.' if unavailable else ''})
            done[job['id']] = receipt; self.save()
        self.metrics['flyerRecoveryResolved'] = sum(result.get('status') == 'saved' for result in done.values())

    def finish(self, review=None):
        review = review if review is not None else self.data.get('review')
        if review is None: raise ValueError('A completed AI review is required.')
        self.restore_media()
        self.data['review'] = review; self.save()
        if self.state.get('reviewInputsReadyAt'):
            self.metrics['aiReviewWallSeconds'] = (datetime.now(timezone.utc) - datetime.fromisoformat(self.state['reviewInputsReadyAt'])).total_seconds()
        with self.stage('validation'):
            coverage = validate_visual_review(self.data['inputs']['posts'], self.data['media'], review)
            self.metrics.update(coverage)
            self.metrics['chatgptToolCalls'] = review.get('instrumentation', {}).get('chatgptToolCalls')
            self.metrics['toolCallMeasurement'] = 'task_recorded' if self.metrics['chatgptToolCalls'] is not None else 'unavailable'
            self.state['coverage'] = coverage
        with self.stage('matching'):
            self.state['snapshot'] = self.api('snapshot.sync')
            snapshots = [self.api('match', {'facts': group}) for group in chunks(self.review_facts(review), 50)]
            snapshot = merge_matches(snapshots)
            payload_review = {**review, 'flyerRecoveryJobs': self.data['inputs'].get('flyerRecoveryJobs', [])}
            write_json(self.directory / 'review.json', payload_review); write_json(self.directory / 'matching.json', snapshot)
            subprocess.run(['node', str(ROOT / 'pipeline-payload.mjs'), str(self.directory / 'review.json'),
                str(self.directory / 'matching.json'), str(self.directory / 'payload.json')], check=True, capture_output=True, text=True)
            payload = json.loads((self.directory / 'payload.json').read_text())
        with self.stage('flyer_preservation'):
            self.preserve(payload, review)
        with self.stage('delivery'):
            delivered = self.state['progress'].setdefault('delivered', {})
            for item in payload['items']:
                if item['kind'] == 'event':
                    lineup = item['fields'].get('Lineup_Raw', '')
                    ready = bool(item.get('date') and lineup and lineup.lower() not in ('tba','tbd','unknown') and item['fields'].get('Flyer_URL'))
                    if not ready:
                        item['readiness'] = 'waiting: ' + ', '.join(name for name, present in [('date', item.get('date')), ('named lineup', lineup and lineup.lower() not in ('tba','tbd','unknown')), ('preserved flyer', item['fields'].get('Flyer_URL'))] if not present)
                # Review notes remain visible; human edits/decisions/receipts are owned by D1.
                item['runId'] = self.run_id
            pending = [item for item in payload['items'] if delivered.get(fingerprint(item)) is None and
                       (item.get('_review', {}).get('kind') != 'recovery' or item['fields'].get('Flyer_URL'))]
            for group in chunks(pending, 10):
                result = self.api('stage', {'items': group})
                if result.get('staged') != len(group): raise RuntimeError('Delivery was not fully confirmed.')
                for item, identity in zip(group, result['ids']): delivered[fingerprint(item)] = identity
                self.save()
            # Mark sources only after all proposals and preservation receipts are durable.
            markers = []
            reviews = {r['key']: r for r in review.get('postReviews', [])}
            for post in self.data['inputs']['posts']:
                if post.get('isPublicEvidence') or post.get('isFlyerRecovery'): continue
                r = reviews[post['key']]
                markers.append({'id': post['id'], 'source_url': next(iter(post['sources']), ''), 'source_accounts': post['accounts'],
                    'taken_at': post['taken_at'], 'caption_sha256': fingerprint(post['captions']), 'review_method': 'pipeline: caption, all slides and sampled video frames',
                    'flyer_outcome': r['flyerOutcome'], 'visual_review': r})
            for group in chunks(markers, 30): self.api('posts.save', {'posts': group})
            receipts = review.get('venueReviews', [])
            for key, comparison in self.data['venues'].items():
                if comparison['status'] == 'unavailable': continue
                for receipt in receipts:
                    if receipt.get('source') == key:
                        saved = comparison['next']['entries'].get(receipt.get('id'))
                        if saved and saved['hash'] == receipt.get('hash'): saved['reviewed'] = True
                try:
                    receipt = self.api('venues.save', {'source': key, 'value': comparison['next'], 'version': comparison['version']})
                except RuntimeError:
                    current = self.api('venues.read', {'source': key})['state']
                    if not current or fingerprint(current['value']) != fingerprint(comparison['next']): raise
                    receipt = current
                comparison['version'] = receipt['version']; self.save()
        self.complete_recovery(payload)
        self.metrics['elapsedWallSeconds'] = (datetime.now(timezone.utc) - datetime.fromisoformat(self.state['startedAt'])).total_seconds()
        self.state['phase'] = 'complete'
        complete_searches = {r.get('id') for r in review.get('searchReceipts', []) if r.get('completed')}
        missing_searches = [q['id'] for q in search_plan(self.data['venues']) if q['id'] not in complete_searches]
        venue_missing = sum(not entry.get('reviewed') for v in self.data['venues'].values() for entry in v.get('next', {}).get('entries', {}).values())
        active_flyer_errors = [error for error in self.state.get('flyerErrors', []) if not error.get('resolvedAt')]
        recovery_pending = [key for key, result in self.state['progress'].get('completedRecoveryJobs', {}).items() if result.get('status') != 'saved']
        self.state['coverage'].update({'flyerRecoveryPending': recovery_pending, 'flyerRecoveryIssues': payload.get('recoveryIssues', []), 'missingSearches': missing_searches, 'unreviewedVenueEntries': venue_missing,
            'venueUnavailable': [key for key, v in self.data['venues'].items() if v['status'] == 'unavailable'],
            'flyerPreservationErrors': active_flyer_errors,
            'complete': not active_flyer_errors and not payload.get('recoveryIssues') and not missing_searches and not venue_missing and not coverage['unavailableMedia'] and not any(v['status'] == 'unavailable' for v in self.data['venues'].values())})
        self.save(); self.run_summary('delivered' if self.state['coverage']['complete'] else 'delivered_with_coverage_gaps')
        self.patch_checkpoint({'activeRun': None, 'last_completed_review_at': NOW(),
            'last_review_status': 'delivered' if self.state['coverage']['complete'] else 'delivered_with_coverage_gaps',
            'coverage': {'pipelineVersion': 1, 'runId': self.run_id, 'metrics': self.metrics, **self.state['coverage']}})
        write_json(self.directory / 'report.json', self.report())
        return self.report()

    def report(self):
        return {'reviewUrl': 'https://queerdancephilly.com/admin/discovery', 'phase': self.state['phase'],
            'delivered': len(self.state['progress'].get('delivered', {})), 'coverage': self.state.get('coverage'), 'metrics': self.metrics,
            'confirmedApifyUsd': self.state.get('collection', {}).get('confirmedActualUsd'),
            'retainedReservationUsd': None if self.state.get('collection', {}).get('confirmedActualUsd') is not None else self.state.get('collection', {}).get('reservedUsd')}


def validate_visual_review(posts, media, review):
    sheets = {s['id']: set(s['visualIds']) for s in media['contactSheets']}
    reviews = {r['key']: r for r in review.get('postReviews', [])}
    inspected, full, unavailable, video_posts = set(), set(), 0, set()
    for post in posts:
        r = reviews.get(post['key'])
        if not r or r.get('captionReviewed') is not True or r.get('flyerOutcome') not in ('saved','no_usable_flyer','media_unavailable','video_frame_found','irrelevant','preservation_failed'):
            raise ValueError('Every new post requires caption review and an explicit flyer search outcome.')
        viewed = set(r.get('fullResolutionVisuals', []))
        for sheet in r.get('reviewedSheets', []):
            if sheet not in sheets: raise ValueError('Unknown inspected contact sheet.')
            viewed |= sheets[sheet]
        for asset in (a for a in media['assets'] if a['postKey'] == post['key']):
            if asset['kind'] == 'video': video_posts.add(post['key'])
            if asset['status'] == 'unavailable':
                unavailable += 1
                if asset['assetKey'] not in r.get('acknowledgedUnavailable', []):
                    raise ValueError('A media failure was not acknowledged; this post is not fully screened.')
            if any(image['visualId'] not in viewed for image in asset.get('images', [])):
                raise ValueError('Every available slide, preview and sampled video frame must be visually reviewed.')
        inspected |= viewed; full |= set(r.get('fullResolutionVisuals', []))
    visuals = {v['visualId']: v for v in media['visuals']}
    if (inspected | full) - set(visuals): raise ValueError('Unknown inspected original media.')
    return {'postsVisuallyReviewed': len(posts), 'carouselSlidesInspected': sum(a.get('position', '0') != '0' and a.get('status') != 'unavailable' for a in media['assets']), 'imagesInspected': sum(visuals[v]['kind'] != 'frame' for v in inspected),
            'framesInspected': sum(visuals[v]['kind'] == 'frame' for v in inspected), 'fullResolutionInspected': len(full),
            'videosExamined': len(video_posts), 'unavailableMedia': unavailable}


def facts_for(review):
    facts = []
    for candidate in review.get('candidates', []):
        fields = candidate.get('fields', {})
        facts.append({'date': candidate.get('date') or fields.get('StartDate', ''),
            'sources': [u for u in [candidate.get('source_url'), fields.get('Instagram_URL'), fields.get('Event_URL')] if u],
            'title': candidate.get('title') or fields.get('Title (internal)', ''), 'location': candidate.get('location') or candidate.get('venue') or fields.get('Location', ''),
            'venueId': fields.get('VenueID', ''), 'aliases': candidate.get('discovery', {}).get('aliases', [])})
    for correction in review.get('corrections', []):
        facts.append({'date': correction.get('Date') or correction.get('date', ''), 'eventId': correction.get('eventId'),
            'sources': [u for u in [correction.get('source_url'), correction.get('Instagram source')] if u]})
    return facts


def merge_matches(snapshots):
    result = {'events': [], 'calendar': [], 'intake': [], 'items': [], 'references': {}, 'matchingComplete': True, 'comparisons': []}
    for snapshot in snapshots:
        result['comparisons'] += snapshot.get('comparisons', [])
        result['references'] = snapshot.get('references', {})
        result['matchingComplete'] &= snapshot.get('matchingComplete', False)
        for key in ('events','calendar','intake','items'):
            existing = {fingerprint(v) for v in result[key]}
            result[key] += [v for v in snapshot.get(key, []) if fingerprint(v) not in existing]
    return result


def search_plan(venues):
    # Broader discovery, news and mentions run in the separate daily report.
    return [{'id': 'venue_gap_' + key, 'query': (value.get('venue') or key) + ' Philadelphia upcoming DJ events lineup',
             'purpose': 'Resolve this unavailable official venue source using free public evidence.'}
            for key, value in venues.items() if key in ('vals', 'dolphin', 'wow') and value.get('status') == 'unavailable']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['begin','attach','prepare','evidence','match','finish','status'])
    parser.add_argument('--connection', required=True); parser.add_argument('--directory', required=True)
    parser.add_argument('--run-id', default='qdp-' + DAY()); parser.add_argument('--input')
    parser.add_argument('--reserve', action='store_true')
    args = parser.parse_args()
    connection = json.loads(Path(args.connection).read_text())
    pipeline = Pipeline(connection, args.directory, args.run_id).load()
    value = json.loads(Path(args.input).read_text()) if args.input else None
    try:
        if args.phase == 'begin': result = pipeline.begin(args.reserve); pipeline.save()
        elif args.phase == 'attach': pipeline.attach(value); result = {'phase': pipeline.state['phase']}
        elif args.phase == 'prepare': result = pipeline.prepare(value)
        elif args.phase == 'evidence': result = pipeline.evidence(value['sources'])
        elif args.phase == 'match': result = pipeline.match(value)
        elif args.phase == 'finish': result = pipeline.finish(value)
        else: result = pipeline.report()
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        pipeline.state['lastError'] = {'phase': args.phase, 'error': str(error), 'at': NOW()}
        try: pipeline.save()
        except Exception: pass
        print(json.dumps({'error': str(error), 'runId': args.run_id, 'resumable': True}), file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()

