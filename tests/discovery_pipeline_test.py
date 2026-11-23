import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools/discovery'))
from preprocess import normalize_dataset, partition, compare_schedule
from media import prepare_media, frames, describe_image, contact_sheets, safe_url
from pipeline import Pipeline, validate_visual_review, search_plan, ACTOR
from PIL import Image, ImageDraw


class FakeEndpoint:
    def __init__(self):
        self.work, self.calls, self.items, self.posts, self.venues, self.runs = {}, [], {}, {}, {}, {}
        self.checkpoint = {'version': 1, 'value': {'activeRun': None, 'last_completed_collection_at': '2026-11-22T12:00:00Z', 'deferredGaps': ['keep']}}
        self.fail_stage_once, self.fail_root_once = False, False
    def __call__(self, action, body):
        self.calls.append((action, copy.deepcopy(body)))
        if action == 'work.read':
            return {'records': copy.deepcopy(list(self.work.get(body['runId'], {}).values()))}
        if action == 'work.save':
            records = self.work.setdefault(body['runId'], {})
            old = records.get(body['key'], {'version': 0})
            if body['version'] != old['version']: raise RuntimeError('This checkpoint changed.')
            if self.fail_root_once and body['key'] == 'state:0':
                self.fail_root_once = False; raise RuntimeError('Simulated root write failure')
            records[body['key']] = {'key': body['key'], 'value': copy.deepcopy(body['value']), 'version': old['version'] + 1}
            return {'version': old['version'] + 1}
        if action == 'pipeline.bootstrap':
            return {'pipelineVersion': 1, 'config': {'actor': ACTOR, 'usernames': ['approved']},
                'checkpoint': copy.deepcopy(self.checkpoint), 'budget': list(self.runs.values())}
        if action == 'checkpoint.patch':
            if body['version'] != self.checkpoint['version']: raise RuntimeError('This checkpoint changed.')
            self.checkpoint['value'].update(body['value']); self.checkpoint['version'] += 1
            return {'version': self.checkpoint['version']}
        if action == 'snapshot.sync': return {'inboxVersion': 1, 'readAt': 'now', 'changedRecords': 0}
        if action == 'budget.reserve':
            if body['id'] in self.runs: return {'created': False, 'reservation': self.runs[body['id']]}
            self.runs[body['id']] = {'id': body['id'], 'reserved_usd': body['amount'], 'actual_usd': None, 'data': {}}
            return {'created': True, 'reservation': self.runs[body['id']]}
        if action == 'run.read': return {'run': copy.deepcopy(self.runs.get(body['id']))}
        if action == 'run.save':
            row = self.runs.setdefault(body['id'], {'id': body['id'], 'reserved_usd': 0, 'actual_usd': None})
            row.update({'data': body['data'], 'status': body['status']})
            if 'actualUsd' in body: row['actual_usd'] = body['actualUsd']
            return {'saved': True}
        if action == 'posts.lookup': return {'screenedIds': [identity for identity in body['ids'] if identity in self.posts]}
        if action == 'posts.save':
            self.posts.update({post['id']: copy.deepcopy(post) for post in body['posts']}); return {'saved': len(body['posts'])}
        if action == 'venues.read': return {'state': copy.deepcopy(self.venues.get(body['source']))}
        if action == 'venues.save':
            old = self.venues.get(body['source'], {'version': 0})
            if old['version'] != body['version']: raise RuntimeError('This checkpoint changed.')
            self.venues[body['source']] = {'version': old['version'] + 1, 'value': copy.deepcopy(body['value'])}
            return {'version': old['version'] + 1}
        if action == 'match': return {'inboxVersion': 1, 'matchingComplete': all(f.get('date') or f.get('eventId') for f in body['facts']),
            'events': [], 'items': [], 'calendar': [], 'intake': [], 'references': {'venues': [], 'venueAliases': []}}
        if action == 'flyers': return {'flyers': [{'id': item['id'], 'url': 'https://drive.google.com/uc?id=saved'} for item in body['items']]}
        if action == 'stage':
            for item in body['items']: self.items[item['discovery']['id']] = copy.deepcopy(item)
            if self.fail_stage_once:
                self.fail_stage_once -= 1; raise RuntimeError('Response lost after staging')
            return {'staged': len(body['items']), 'ids': [item['discovery']['id'] for item in body['items']]}
        raise AssertionError('Unexpected operation: ' + action)


class DiscoveryPipelineTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.directory = Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()
    def image(self, name='flyer.png'):
        path = self.directory / name
        image = Image.new('RGB', (1080, 1350), 'purple'); ImageDraw.Draw(image).text((100, 100), 'TEST PARTY 12/19 DJ TEST', fill='white'); image.save(path)
        return path
    def test_same_post_merge_preserves_accounts_captions_every_slide_and_video(self):
        row = {'id': '123_1', 'pk': '123', 'code': 'ABC', 'post_url': 'https://www.instagram.com/p/ABC/', 'caption': {'text': ''},
            'scraped_username': 'one', 'media_type': 8, 'carousel_media': [{'image_url': 'https://public.example/slide.jpg'},
            {'media_type': 2, 'image_url': 'https://public.example/preview.jpg', 'video_url': 'https://public.example/video.mp4'}]}
        second = {**row, 'scraped_username': 'two', 'caption': {'text': 'A different coauthor caption'}}
        posts, counts = normalize_dataset([row, second])
        self.assertEqual(counts['duplicateRows'], 1); self.assertEqual(posts[0]['accounts'], ['one', 'two'])
        self.assertEqual(len(posts[0]['captions']), 2); self.assertEqual(len(posts[0]['assets']), 3)
        self.assertEqual(len(partition(posts, [])[0]), 1)  # Empty captions never filter a post.
        self.assertEqual(len(partition(posts, ['123_1'])[0]), 0)  # Edited captions stay skipped by decision.
    def test_resolution_selection_never_drops_carousel_child(self):
        posts, _ = normalize_dataset([{'id': 'x', 'image_versions2': {'candidates': [{'width': 100, 'height': 100, 'url': 'small'},
            {'width': 1080, 'height': 1080, 'url': 'full'}]}, 'carousel_media': [{'image_url': 'second'}]}])
        self.assertEqual([a['url'] for a in posts[0]['assets']], ['full', 'second'])
    def test_media_dedup_uses_identical_bytes_and_keeps_source_associations(self):
        original = self.image()
        posts, _ = normalize_dataset([{'id': 'one', 'images': ['https://public.example/1']}, {'id': 'two', 'image_url': 'https://public.example/2'}])
        def fetch(url, target, size, stats): shutil.copyfile(original, target); return target
        media = prepare_media(posts, self.directory / 'media', {}, fetch=fetch)
        self.assertEqual(len(media['visuals']), 1); self.assertEqual(len(media['assets']), 2)
        self.assertEqual(media['assets'][0]['postKey'], 'pk:one')
        self.assertEqual(media['assets'][1]['postKey'], 'pk:two')
    def test_unavailable_media_is_a_gap_and_requires_explicit_acknowledgement(self):
        posts, _ = normalize_dataset([{'id': 'x', 'image_url': 'https://public.example/failed'}])
        def failure(*args): raise RuntimeError('Unavailable source')
        media = prepare_media(posts, self.directory / 'media', {}, fetch=failure)
        review = {'postReviews': [{'key': posts[0]['key'], 'captionReviewed': True, 'flyerOutcome': 'media_unavailable'}]}
        with self.assertRaisesRegex(ValueError, 'acknowledged'): validate_visual_review(posts, media, review)
        review['postReviews'][0]['acknowledgedUnavailable'] = [media['assets'][0]['assetKey']]
        self.assertEqual(validate_visual_review(posts, media, review)['unavailableMedia'], 1)
    def test_generated_tiles_are_not_counted_as_inspected(self):
        original = self.image(); visual = describe_image({'path': str(original), 'kind': 'image'}); visual['visualId'] = 'visual-test'
        media = {'assets': [{'postKey': 'post', 'kind': 'image', 'status': 'downloaded', 'images': [visual]}],
                 'visuals': [visual], 'contactSheets': contact_sheets([visual], self.directory)}
        review = {'postReviews': [{'key': 'post', 'captionReviewed': True, 'flyerOutcome': 'irrelevant'}]}
        with self.assertRaisesRegex(ValueError, 'visually reviewed'): validate_visual_review([{'key': 'post'}], media, review)
        review['postReviews'][0]['reviewedSheets'] = ['contact-001']
        self.assertEqual(validate_visual_review([{'key': 'post'}], media, review)['imagesInspected'], 1)
    def test_real_video_scene_detection_preserves_original_dimensions_and_transition_frames(self):
        video = self.directory / 'video.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=12:d=1',
            '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=12:d=1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(video)], check=True, capture_output=True)
        images, coverage = frames(video, self.directory / 'frames')
        self.assertGreaterEqual(coverage['transitions'], 1); self.assertTrue(any(i['sample'] == 'transition' for i in images))
        self.assertGreaterEqual(len(images), 7)
        for image in images:
            with Image.open(image['path']) as original: self.assertEqual(original.size, (320, 240))
        self.assertFalse(coverage['fullVideoAudioReview'])
    def test_private_media_locations_are_rejected(self):
        for url in ('http://public.example/a', 'https://user:secret@public.example/a', 'https://127.0.0.1/a', 'https://[::1]/a'):
            with self.assertRaises(ValueError): safe_url(url)
    def test_unreviewed_venue_versions_are_not_silently_filtered(self):
        current = {'status': 'collected', 'events': [{'id': 'event', 'title': 'Party', 'date': '2099-12-19'}]}
        one = compare_schedule(current); self.assertEqual(len(compare_schedule(current, one['next'])['entries']), 1)
        one['next']['entries']['event']['reviewed'] = True
        two = compare_schedule(current, one['next']); self.assertEqual(two['status'], 'no_new_entries')
        current['events'][0]['title'] = 'Changed lineup'
        self.assertEqual(compare_schedule(current, one['next'])['entries'][0]['change'], 'changed')
        failed = compare_schedule({'status': 'incomplete', 'error': 'source down'}, one['next'])
        self.assertEqual(failed['status'], 'unavailable'); self.assertEqual(failed['next'], one['next'])
    def test_unavailable_event_page_never_looks_unchanged_or_empty(self):
        current = {'status': 'collected', 'events': [{'url': 'https://public.example/party', 'status': 'incomplete', 'error': '403'}]}
        result = compare_schedule(current); self.assertEqual(result['entries'][0]['change'], 'unavailable')
        self.assertEqual(len(result['next']['entries']), 0)
    def test_journal_recovers_last_committed_generation_after_failed_publish(self):
        endpoint = FakeEndpoint(); pipeline = Pipeline({}, self.directory, 'test', endpoint).load()
        pipeline.data['inputs'] = {'text': 'old' * 40000}; pipeline.save()
        pipeline.data['inputs'] = {'text': 'new' * 40000}; endpoint.fail_root_once = True
        with self.assertRaisesRegex(RuntimeError, 'root'): pipeline.save()
        recovered = Pipeline({}, self.directory / 'new-machine', 'test', endpoint).load()
        self.assertEqual(recovered.data['inputs']['text'], 'old' * 40000)
    def test_existing_reservation_and_ambiguous_launch_never_authorize_second_start(self):
        endpoint = FakeEndpoint(); pipeline = Pipeline({}, self.directory, 'test', endpoint).load()
        self.assertTrue(pipeline.begin(reserve=True)['startAuthorized'])
        recovered = Pipeline({}, self.directory / 'recovered', 'test', endpoint).load()
        self.assertFalse(recovered.begin(reserve=True)['startAuthorized'])
        self.assertEqual(sum(action == 'budget.reserve' for action, _ in endpoint.calls), 1)
        self.assertEqual(endpoint.runs['test']['actual_usd'], None)
        self.assertEqual(endpoint.runs['test']['reserved_usd'], .59)
    def test_estimated_charge_cannot_settle_reservation(self):
        endpoint = FakeEndpoint(); pipeline = Pipeline({}, self.directory, 'test', endpoint).load(); pipeline.begin(True)
        with self.assertRaisesRegex(ValueError, 'confirmed exact'):
            pipeline.attach({'actorName': ACTOR, 'runId': 'actor', 'charge': {'amountUsd': .05, 'confirmed': False}})
        self.assertIsNone(endpoint.runs['test']['actual_usd'])
    def test_registered_public_artwork_keeps_its_verified_source_and_does_not_become_an_instagram_marker(self):
        endpoint = FakeEndpoint(); pipeline = Pipeline({}, self.directory, 'test', endpoint).load()
        pipeline.data = {'inputs': {'posts': []}, 'media': {'assets': [], 'visuals': [], 'contactSheets': []}, 'venues': {}}
        pipeline.metrics['aiReviewWorkload'] = {}
        empty_media = {'assets': [], 'visuals': [], 'contactSheets': []}
        with patch('pipeline.prepare_media', return_value=empty_media) as prepare:
            pipeline.evidence([{'sourceUrl': 'https://venue.example/event', 'verified': True, 'images': ['https://venue.example/flyer.jpg']}])
            post = prepare.call_args.args[0][0]
            self.assertTrue(post['isPublicEvidence']); self.assertEqual(post['sources'], ['https://venue.example/event'])
            self.assertEqual(post['assets'][0]['url'], 'https://venue.example/flyer.jpg')
        review = {'postReviews': [{'key': pipeline.data['inputs']['posts'][0]['key'], 'captionReviewed': True, 'flyerOutcome': 'no_usable_flyer'}]}
        pipeline.finish(review)
        self.assertFalse(endpoint.posts)

    def test_lost_delivery_response_retries_without_import_or_rescreening(self):
        endpoint = FakeEndpoint(); pipeline = Pipeline({}, self.directory, 'test', endpoint).load()
        image = self.image(); visual = describe_image({'path': str(image), 'kind': 'image'}); visual['visualId'] = 'visual-test'
        media = {'assets': [{'postKey': 'ig:NEW', 'assetKey': 'asset', 'kind': 'image', 'status': 'downloaded', 'url': 'https://public.example/flyer.png',
            'sourceUrl': 'https://www.instagram.com/p/NEW/', 'images': [visual]}], 'visuals': [visual],
            'contactSheets': contact_sheets([visual], self.directory)}
        with patch('pipeline.prepare_media', return_value=media):
            pipeline.prepare([{'id': 'new', 'post_url': 'https://www.instagram.com/p/NEW/', 'image_url': 'https://public.example/flyer.png'}],
                {'venues': [{'key': 'vals', 'status': 'collected', 'events': []}, {'key': 'wow', 'status': 'collected', 'events': []},
                            {'key': 'dolphin', 'status': 'embedded_feed'}]})
        review = {'candidates': [{'title': 'Party', 'date': '2099-12-19', 'end_date': '2099-12-20', 'start': '22:00', 'end': '02:00',
                    'location': 'Venue', 'lineup': 'DJ Test', 'source_url': 'https://www.instagram.com/p/NEW/', 'description': 'Verified event-specific copy.'}],
                  'postReviews': [{'key': 'ig:NEW', 'captionReviewed': True, 'flyerOutcome': 'saved', 'reviewedSheets': ['contact-001'],
                      'fullResolutionVisuals': ['visual-test']}], 'flyers': [{'candidateIndex': 0, 'visualId': 'visual-test', 'verified': True}],
                  'searchReceipts': [{'id': q['id'], 'completed': True} for q in search_plan(pipeline.data['venues'])]}
        endpoint.fail_stage_once = 3
        with self.assertRaisesRegex(RuntimeError, 'Response lost'): pipeline.finish(review)
        self.assertEqual(endpoint.posts, {})
        recovered = Pipeline({}, self.directory, 'test', endpoint).load()
        result = recovered.finish()
        self.assertEqual(len(endpoint.items), 1); self.assertEqual(result['delivered'], 1)
        self.assertEqual(result['metrics']['flyersPreserved'], 1)
        self.assertEqual(sum(action == 'flyers' for action, _ in endpoint.calls), 1)
        self.assertIn('new', endpoint.posts)
        self.assertFalse(any(action in ('import','publish','save') for action, _ in endpoint.calls))
        self.assertEqual(endpoint.checkpoint['value']['deferredGaps'], ['keep'])
        self.assertEqual(next(iter(endpoint.items.values()))['fields']['Description'], 'Verified event-specific copy.')


if __name__ == '__main__': unittest.main(verbosity=2)
