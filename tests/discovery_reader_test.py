import importlib.util
import io
import json
import pathlib
import unittest
import sys
sys.dont_write_bytecode = True
import urllib.request

path = pathlib.Path(__file__).parents[1] / "tools/discovery/read-decisions.py"
spec = importlib.util.spec_from_file_location("decision_reader", path)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)

TOKEN = "a" * 64
REVISION = "b" * 64
URL = "https://script.google.com/macros/s/FIXTURE/exec"


def record(alias="c" * 64, decision="EXCLUDE"):
    return {"alias": alias, "id": alias, "kind": "event", "date": "2026-12-19",
        "decision": decision, "updatedAt": "2026-11-22T12:00:00Z"}


def page(records, total=None, cursor=None):
    return {"ok": "yes", "feedbackVersion": 1, "provider": "apps_script", "revision": REVISION,
        "total": len(records) if total is None else total, "records": records, "cursor": cursor,
        "complete": cursor is None, "readAt": "2026-11-22T13:00:00Z"}


class Opener:
    def __init__(self, pages):
        self.pages = iter(pages)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        return io.BytesIO(json.dumps(next(self.pages)).encode())


class ReaderTest(unittest.TestCase):
    def test_live_snapshot_uses_only_configured_google_post_and_private_body(self):
        opener = Opener([page([record()])])
        result = reader.fetch_snapshot({"url": URL, "token": TOKEN}, opener)
        self.assertEqual(result["source"], "apps_script")
        self.assertTrue(result["complete"])
        request = opener.requests[0]
        self.assertEqual(request.full_url, URL)
        self.assertNotIn(TOKEN, request.full_url)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(json.loads(request.data), {"action": "discovery.feedback.read", "readToken": TOKEN})
        self.assertNotIn(TOKEN, json.dumps(result))

    def test_all_pages_are_followed_and_missing_pages_are_not_complete(self):
        opener = Opener([page([record()], total=2, cursor=REVISION + ":1"), page([record("d" * 64)], total=2)])
        result = reader.fetch_snapshot({"url": URL, "token": TOKEN}, opener)
        self.assertEqual(len(result["records"]), 2)
        self.assertEqual(json.loads(opener.requests[1].data)["cursor"], REVISION + ":1")
        with self.assertRaises(reader.FeedbackError):
            reader.fetch_snapshot({"url": URL, "token": TOKEN}, Opener([page([record()], total=2)]))

    def test_token_is_not_forwarded_on_contentservice_redirect(self):
        req = urllib.request.Request(URL, data=json.dumps({"readToken": TOKEN}).encode(),
            headers={"Authorization": "Bearer " + TOKEN})
        handler = reader.GoogleContentRedirect()
        redirected = handler.redirect_request(req, None, 302, "", {}, "https://script.googleusercontent.com/macros/echo?user_content_key=ONE_TIME")
        self.assertIsNone(redirected.data)
        self.assertIsNone(redirected.get_header("Authorization"))
        self.assertEqual(redirected.get_method(), "GET")
        for url in ["https://example.invalid/macros/echo", "https://script.googleusercontent.com/other", "https://accounts.google.com/"]:
            with self.assertRaises(reader.FeedbackError):
                handler.redirect_request(req, None, 302, "", {}, url)

    def test_changed_snapshot_restarts_once(self):
        opener = Opener([page([record()], total=2, cursor=REVISION + ":1"),
            {"ok": "no", "error": "Discovery decisions changed during pagination. Restart the snapshot."}, page([record("d" * 64)])])
        result = reader.fetch_snapshot({"url": URL, "token": TOKEN}, opener)
        self.assertEqual(result["records"][0]["alias"], "d" * 64)
        self.assertNotIn("cursor", json.loads(opener.requests[-1].data))

    def test_failed_read_preserves_saved_decisions_without_false_sync(self):
        saved = [record()]
        s = {"daily_discovery": {"decisions": saved, "decisionReadAt": "2026-11-20T12:00:00Z",
            "appsScriptFeedback": {"provider": "apps_script", "url": URL, "token": TOKEN}}}
        result = reader.read_decisions(s, Opener([{"ok": "no", "error": "Unauthorized"}]))
        self.assertEqual(result["records"], saved)
        self.assertFalse(result["complete"])
        self.assertEqual(result["lastLiveSyncAt"], s["daily_discovery"]["decisionReadAt"])
        self.assertIn("feedbackReadError", result)

    def test_legacy_urls_and_duplicate_or_malformed_records_are_rejected(self):
        for url in ["https://queerdancephilly.com/api/discovery-decisions", URL + "?token=" + TOKEN, "https://example.invalid/exec"]:
            with self.assertRaises(reader.FeedbackError):
                reader.fetch_snapshot({"url": url, "token": TOKEN}, Opener([]))
        for records in [[record(), record()], [{**record(), "decision": "FORGED"}]]:
            with self.assertRaises(reader.FeedbackError):
                reader.fetch_snapshot({"url": URL, "token": TOKEN}, Opener([page(records)]))


if __name__ == "__main__":
    unittest.main()
