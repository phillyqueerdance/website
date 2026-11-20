"""Read only the discovery feedback feed; no Google or index access."""
import argparse
import json
import urllib.parse
import urllib.request


def read_decisions(settings):
    url = settings["url"]
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != "queerdancephilly.com" or parsed.path != "/api/discovery-decisions":
        raise ValueError("Use the configured QDP discovery-only feed.")
    records = []
    cursor = None
    seen = set()
    while True:
        target = url + ("?" + urllib.parse.urlencode({"cursor": cursor}) if cursor else "")
        request = urllib.request.Request(target, headers={"Authorization": "Bearer " + settings["token"], "Accept": "application/json"})
        # Never forward this credential to a redirect destination.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            page = json.load(response)
        if not isinstance(page.get("records"), list):
            raise ValueError("Decision feed is incomplete; do not prepare an unfiltered review.")
        records.extend(page["records"])
        cursor = page.get("cursor")
        if not cursor:
            return {"records": records}
        if cursor in seen:
            raise ValueError("Decision pagination stalled; do not assume all exclusions were loaded.")
        seen.add(cursor)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    with open(args.state) as stream:
        settings = json.load(stream)["daily_discovery"]["decisionFeed"]
    result = read_decisions(settings)
    with open(args.output, "w") as stream:
        json.dump(result, stream)
    print(json.dumps({"decisionRecords": len(result["records"])}))
