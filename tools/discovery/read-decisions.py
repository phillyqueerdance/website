"""Read the decisions-only Apps Script feed, with a preserved local fallback."""
import argparse
import datetime
import json
import re
import urllib.error
import urllib.parse
import urllib.request


class FeedbackError(ValueError):
    pass


def validate_feed_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname != "script.google.com"
            or parsed.username or parsed.password or parsed.port not in (None, 443)
            or not re.fullmatch(r"/macros/s/[A-Za-z0-9_-]+/exec", parsed.path)
            or parsed.query or parsed.fragment):
        raise FeedbackError("Use the configured Google Apps Script feedback deployment.")
    return url


class GoogleContentRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old = urllib.parse.urlsplit(req.full_url)
        new = urllib.parse.urlsplit(newurl)
        if (code not in (301, 302, 303) or old.hostname != "script.google.com"
                or new.scheme != "https" or new.hostname != "script.googleusercontent.com"
                or new.username or new.password or new.port not in (None, 443)
                or new.path != "/macros/echo"):
            raise FeedbackError("The feedback service returned an unexpected redirect.")
        # ContentService uses a one-time GET URL. Never forward the token/body.
        return urllib.request.Request(newurl, headers={"Accept": "application/json"}, method="GET")


def fetch_snapshot(settings, opener=None):
    url = validate_feed_url(settings.get("url", ""))
    token = settings.get("token", "")
    if not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{64}", token):
        raise FeedbackError("The read-only feedback connection is not configured.")
    opener = opener or urllib.request.build_opener(GoogleContentRedirect())
    for attempt in range(2):
        records, aliases, cursors = [], set(), set()
        cursor = revision = total = read_at = None
        restart = False
        while True:
            body = {"action": "discovery.feedback.read", "readToken": token}
            if cursor:
                body["cursor"] = cursor
            request = urllib.request.Request(url, data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json", "Accept": "application/json"}, method="POST")
            try:
                with opener.open(request, timeout=30) as response:
                    data = response.read(2_000_001)
                if len(data) > 2_000_000:
                    raise FeedbackError("The feedback page exceeded its expected size.")
                page = json.loads(data)
            except (urllib.error.URLError, json.JSONDecodeError):
                raise FeedbackError("The Apps Script feedback service could not be read.") from None
            if not isinstance(page, dict):
                raise FeedbackError("The feedback service did not return a JSON object.")
            if page.get("error") == "Discovery decisions changed during pagination. Restart the snapshot.":
                restart = True
                break
            if (page.get("ok") != "yes" or page.get("feedbackVersion") != 1
                    or page.get("provider") != "apps_script" or not isinstance(page.get("records"), list)
                    or not re.fullmatch(r"[a-f0-9]{64}", str(page.get("revision", "")))
                    or type(page.get("total")) is not int or page["total"] < 0):
                raise FeedbackError("The Apps Script deployment did not return a complete decision snapshot.")
            if revision is None:
                revision, total = page["revision"], page["total"]
            if revision != page["revision"] or total != page["total"]:
                raise FeedbackError("The feedback snapshot changed while reading it.")
            for record in page["records"]:
                if (not isinstance(record, dict) or not re.fullmatch(r"[a-f0-9]{64}", str(record.get("alias", "")))
                        or not re.fullmatch(r"[a-f0-9]{64}", str(record.get("id", "")))
                        or record.get("kind") not in ("event", "correction")
                        or record.get("decision") not in ("INCLUDE", "WAIT", "EXCLUDE")):
                    raise FeedbackError("A decision alias is invalid.")
                try:
                    datetime.date.fromisoformat(record.get("date", ""))
                    datetime.datetime.fromisoformat(record.get("updatedAt", "").replace("Z", "+00:00"))
                except (ValueError, TypeError, AttributeError):
                    raise FeedbackError("A feedback decision has an invalid date or timestamp.") from None
                if record["alias"] in aliases:
                    raise FeedbackError("The feedback snapshot contains repeated aliases.")
                aliases.add(record["alias"])
                records.append(record)
            read_at = page.get("readAt")
            try:
                datetime.datetime.fromisoformat(read_at.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                raise FeedbackError("The feedback snapshot has no valid read timestamp.") from None
            next_cursor = page.get("cursor")
            if next_cursor is None:
                if page.get("complete") is not True or len(records) != total:
                    raise FeedbackError("The feedback snapshot is incomplete.")
                return {"records": records, "source": "apps_script", "complete": True,
                    "revision": revision, "lastLiveSyncAt": read_at, "total": total}
            if (page.get("complete") is not False or not isinstance(next_cursor, str)
                    or not page["records"] or next_cursor in cursors or len(records) >= total
                    or len(next_cursor) > 100):
                raise FeedbackError("Feedback pagination stalled or is incomplete.")
            cursors.add(next_cursor)
            cursor = next_cursor
        if not restart or attempt:
            break
    raise FeedbackError("The feedback snapshot kept changing. Reuse the saved decisions and retry later.")


def read_decisions(state, opener=None, cached=False):
    daily = state.get("daily_discovery", {})
    records = daily.get("decisions", [])
    if not isinstance(records, list):
        raise FeedbackError("Saved decisions must be an array; preserve and recover the existing state.")
    result = {"records": records, "source": "saved_state", "complete": False,
        "lastLiveSyncAt": daily.get("decisionReadAt"),
        "liveAdminFeedback": "Cached decisions; no live feedback was read this run."}
    settings = daily.get("appsScriptFeedback", {})
    if not cached and settings.get("provider") == "apps_script" and settings.get("enabled", True):
        try:
            return fetch_snapshot(settings, opener)
        except FeedbackError as error:
            result["feedbackReadError"] = str(error)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--cached", action="store_true", help="Explicitly reuse saved decisions without a live read.")
    args = parser.parse_args()
    with open(args.state) as stream:
        state = json.load(stream)
    result = read_decisions(state, cached=args.cached)
    with open(args.output, "w") as stream:
        json.dump(result, stream)
    print(json.dumps({"decisionRecords": len(result["records"]), "source": result["source"],
        "complete": result["complete"], "feedbackReadError": result.get("feedbackReadError")}))
