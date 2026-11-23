import copy
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools/discovery'))
from flyer_recovery import parse_post_page, recover_posts
from preprocess import normalize_dataset
from media import prepare_media
from pipeline import Pipeline
from discovery_pipeline_test import FakeEndpoint
from PIL import Image, ImageDraw

SOURCE = 'https://www.instagram.com/reel/RECOVER/'

def target():
    return {'id': 'a' * 64, 'kind': 'event', 'date': '2099-12-19', 'status': 'pending', 'decision': 'WAIT', 'version': 2,
        'fields': {'Title (internal)': 'Saved party', 'StartDate': '2099-12-19', 'StartTime': '22:00', 'EndDate': '2099-12-20',
            'EndTime': '02:00', 'Location': '', 'Lineup_Raw': '', 'Description': 'Keep my exact copy.', 'Instagram_URL': SOURCE},
        'discovery': {'id': 'a' * 64, 'kind': 'event', 'date': '2099-12-19', 'aliases': ['a' * 64]},
        'sourceUrl': SOURCE, 'note': 'Existing review note', 'readiness': 'waiting', 'result': {}}

def job():
    return {'id': 'b' * 64, 'version': 1, 'lease': 'lease', 'sourceRef': 'ig:RECOVER', 'sourceUrl': SOURCE, 'attempts': 0, 'items': [target()]}


class FlyerRecoveryTest(unittest.TestCase):
    def test_public_post_parser_keeps_every_carousel_child_and_reel_video(self):
        post = {'shortcode': 'RECOVER', 'is_video': False, 'edge_sidecar_to_children': {'edges': [
            {'node': {'display_url': 'https://cdn.example/slide1.jpg'}},
            {'node': {'is_video': True, 'display_url': 'https://cdn.example/cover.jpg', 'video_url': 'https://cdn.example/reel.mp4'}}]}}
        page = '<script type="application/json">' + json.dumps({'data': {'post': post}}) + '</script>'
        parsed = parse_post_page(page, SOURCE)
        self.assertTrue(parsed['complete']); self.assertEqual(len(parsed['assets']), 3)
        self.assertEqual([a['kind'] for a in parsed['assets']], ['image', 'preview', 'video'])
    def test_public_parser_never_uses_recommended_posts_as_target_artwork(self):
        page = '<script type="application/json">' + json.dumps({'post': {'shortcode': 'UNRELATED', 'display_url': 'https://cdn.example/wrong.jpg'}}) + '</script>'
        with self.assertRaisesRegex(ValueError, 'did not expose'): parse_post_page(page, SOURCE)
    def test_preview_only_is_not_full_reel_or_carousel_coverage(self):
        page = '<meta property="og:image" content="https://cdn.example/preview.jpg">'
        parsed = parse_post_page(page, SOURCE)
        self.assertFalse(parsed['complete']); self.assertEqual(parsed['assets'][1]['kind'], 'video')
        self.assertEqual(parsed['assets'][1]['url'], '')
    def test_normal_daily_dataset_supplies_fresh_urls_for_a_previously_screened_source(self):
        posts, _ = normalize_dataset([{'id': 'old_id', 'code': 'RECOVER', 'post_url': SOURCE, 'image_url': 'https://cdn.example/fresh-flyer.jpg'}])
        def no_refetch(*args): self.fail('A complete current dataset must not trigger another source request')
        recovered = recover_posts([job()], posts, {}, fetch_page=no_refetch)
        self.assertEqual(recovered[0]['assets'][0]['url'], 'https://cdn.example/fresh-flyer.jpg')
        self.assertEqual(recovered[0]['flyerRecovery']['method'], 'normal_daily_dataset')
    def test_absent_post_is_revisited_free_with_new_carousel_and_video_urls(self):
        calls = []
        def fetch(url, stats):
            calls.append(url)
            return {'complete': True, 'caption': 'Verified source caption', 'assets': [
                {'kind': 'image', 'url': 'https://cdn.example/new-slide.jpg', 'position': '0.1'},
                {'kind': 'video', 'url': 'https://cdn.example/new-reel.mp4', 'position': '0.2'}]}
        recovered = recover_posts([job()], [], {}, fetch_page=fetch)
        self.assertEqual(calls, [SOURCE]); self.assertEqual(len(recovered[0]['assets']), 2)
        self.assertEqual(recovered[0]['flyerRecovery']['targets'][0]['fields']['Description'], 'Keep my exact copy.')
    def test_blocked_free_source_keeps_saved_media_and_an_honest_gap(self):
        pending = job(); pending['items'][0]['fields']['RawFlyerURL'] = 'https://cdn.example/saved.jpg'; calls = []
        def blocked(url, stats): calls.append(url); raise RuntimeError('HTTP 403')
        recovered = recover_posts([pending], [], {}, fetch_page=blocked)
        self.assertEqual(len(calls), 2)
        self.assertTrue(any(a['kind'] == 'unavailable' for a in recovered[0]['assets']))
        self.assertTrue(any(a['url'] == 'https://cdn.example/saved.jpg' for a in recovered[0]['assets']))
        self.assertEqual(len(recovered[0]['flyerRecovery']['sourceErrors']), 2)
    def test_later_pipeline_recovers_existing_screened_source_without_rewriting_its_event_or_screen_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); original = root / 'source.jpg'
            image = Image.new('RGB', (800, 1000), 'purple'); ImageDraw.Draw(image).text((40,40),'SAVED PARTY / 12-19 / DJ TEST',fill='white'); image.save(original)
            endpoint = FakeEndpoint(); endpoint.posts['old_id'] = {'id': 'old_id', 'review_method': 'original screening'}
            marker = copy.deepcopy(endpoint.posts['old_id']); endpoint.recovery_jobs = [job()]; endpoint.match_items = [target()]
            def fetch(url, path, size, stats): path.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(original, path); return path
            def media(posts, directory, stats): return prepare_media(posts, directory, stats, fetch=fetch)
            pipeline = Pipeline({}, root / 'run', 'later-daily', endpoint).load()
            with patch('pipeline.prepare_media', side_effect=media):
                pipeline.prepare([{'id': 'old_id', 'code': 'RECOVER', 'post_url': SOURCE, 'image_url': 'https://cdn.example/fresh.jpg'}], {'venues': []})
            self.assertEqual(pipeline.metrics['newPosts'], 0); self.assertEqual(pipeline.metrics['screenedPostsRecovered'], 1)
            post = pipeline.data['inputs']['posts'][0]; self.assertTrue(post['isFlyerRecovery'])
            visual = pipeline.data['media']['visuals'][0]
            review = {'candidates': [], 'corrections': [], 'postReviews': [{'key': post['key'], 'captionReviewed': True,
                'flyerOutcome': 'saved', 'reviewedSheets': ['contact-001'], 'fullResolutionVisuals': [visual['visualId']]}],
                'flyers': [{'recoveryId': job()['id'], 'targetIds': [target()['id']], 'visualId': visual['visualId'], 'verified': True}]}
            result = pipeline.finish(review)
            saved = endpoint.items[target()['id']]
            self.assertEqual(saved['fields']['Description'], 'Keep my exact copy.'); self.assertEqual(saved['fields']['Location'], '')
            self.assertTrue(saved['fields']['Flyer_URL']); self.assertEqual(endpoint.posts['old_id'], marker)
            self.assertEqual(endpoint.recovery_receipts[0]['outcome'], 'saved'); self.assertEqual(result['metrics']['flyerRecoveryResolved'], 1)
            self.assertFalse(any(a in ('budget.reserve','import','publish') for a, _ in endpoint.calls))
    def test_recovery_selection_rejects_foreign_targets_before_preserving_media(self):
        with tempfile.TemporaryDirectory() as directory:
            pipeline = Pipeline({}, directory, 'run', FakeEndpoint())
            pipeline.data = {'inputs': {'flyerRecoveryJobs': [job()]}, 'media': {'assets': []}}
            with self.assertRaisesRegex(ValueError, 'unrelated'):
                pipeline.selected_items({'recoveryId': job()['id'], 'targetIds': ['c' * 64], 'visualId': 'visual'}, {'items': []})


if __name__ == '__main__': unittest.main(verbosity=2)
