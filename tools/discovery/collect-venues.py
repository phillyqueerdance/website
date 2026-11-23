"""Read the three authorized public venue schedules without a paid scraper."""
import argparse
import concurrent.futures
import html
import hashlib
import threading
from html.parser import HTMLParser
import json
import re
import urllib.parse
import urllib.request
import urllib.error


_METER = None
_METER_LOCK = threading.Lock()

def meter(requests=0, size=0):
    if _METER is not None:
        with _METER_LOCK:
            _METER['venueRequests'] = _METER.get('venueRequests', 0) + requests
            _METER['venueBytes'] = _METER.get('venueBytes', 0) + size

def fetch(url, headers=None):
    request = urllib.request.Request(url, headers={"User-Agent": "QDP event discovery (public schedules)", **(headers or {})})
    meter(requests=1)
    with urllib.request.urlopen(request, timeout=25) as response:
        raw = response.read(5 * 1024 * 1024 + 1)
    meter(size=len(raw))
    if len(raw) > 5 * 1024 * 1024:
        raise ValueError("Public schedule exceeded the retrieval limit; review coverage is incomplete.")
    return raw.decode("utf-8")


def vals():
    url = "https://valslesbianbar.com/events"
    page = fetch(url)
    asset = re.search(r'src=["\'](/assets/index-[^"\']+\.js)["\']', page)
    if not asset:
        raise ValueError("The public calendar app asset was not found.")
    source = fetch(urllib.parse.urljoin(url, asset[1]))
    origin = re.search(r'VITE_SUPABASE_URL:["\'](https://[^"\']+)["\']', source)
    key = re.search(r'VITE_SUPABASE_ANON_KEY:["\']([^"\']+)["\']', source)
    if not origin or not key:
        raise ValueError("The published calendar data route changed; use the public venue page.")
    # The exact published-document query used by the public venue app. No staff/draft data.
    endpoint = origin[1] + "/rest/v1/vals_site_documents?select=content,revision&id=eq.published"
    documents = json.loads(fetch(endpoint, {"apikey": key[1], "Accept": "application/json"}))
    if len(documents) != 1 or "content" not in documents[0]:
        raise ValueError("The published calendar document is unavailable.")
    content = documents[0]["content"]
    events = content.get("events")
    if not isinstance(events, list):
        raise ValueError("The public calendar schema changed.")
    return {"venue": "Val's", "source": url, "status": "collected", "events": events,
            "note": "Raw public schedule entries require edition-specific lineup, flyer and QDP comparison review."}


def dolphin():
    url = "https://www.dolphinphillyinfo.com/upcoming-events"
    page = fetch(url)
    widgets = list(dict.fromkeys(re.findall(r"elfsight-app-([a-f0-9-]{36})", page)))
    links = list(dict.fromkeys(html.unescape(link) for link in re.findall(r'href=["\'](https?://[^"\']+)["\']', page)
                               if re.search(r"instagram\.com|ticket|eventbrite|ra\.co", link, re.I)))
    return {"venue": "Dolphin Tavern", "source": url, "status": "embedded_feed" if widgets else "needs_review",
            "widgetIds": widgets, "eventLinks": links,
            "note": "The official events page embeds a feed. Review the venue's new posts in the approved Instagram collection; do not count an unreadable embed as an empty schedule."}


def wow(previous=None):
    url = "https://www.wowphilly.com/events"
    page = fetch(url)
    links = list(dict.fromkeys(html.unescape(link).replace("\\", "") for link in
        re.findall(r'https://www\.tixr\.com/groups/wowphilly/events/[^\s"\'<>\\]+', page)))
    if not links:
        raise ValueError("No event links could be extracted; do not treat this as an empty calendar.")
    return {"venue": "Warehouse on Watts", "source": url, "status": "collected", "events": detail_pages(links, previous or {}),
            "note": "Review linked event dates, named lineups, room, and flyer. The schedule also contains live shows and past events."}


class ScheduleText(HTMLParser):
    def __init__(self):
        super().__init__(); self.hidden = 0; self.parts = []; self.json_script = False
    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag in ('style', 'script'):
            self.hidden += 1
            self.json_script = tag == 'script' and (attributes.get('type') in ('application/ld+json','application/json') or attributes.get('id') == '__NEXT_DATA__')
        if tag == 'meta' and attributes.get('property','').startswith('og:'):
            self.parts.append(attributes.get('content',''))
    def handle_endtag(self, tag):
        if tag in ('style', 'script'):
            self.hidden = max(0, self.hidden - 1); self.json_script = False
    def handle_data(self, data):
        if not self.hidden or self.json_script:
            self.parts.append(data)


def detail_page(url, previous):
    old = previous.get('entries', {}).get(url, {})
    conditional = old.get('entry', {}).get('conditional', {}) if old.get('reviewed') else {}
    headers = {'User-Agent': 'QDP event discovery (public schedules)'}
    if conditional.get('etag'): headers['If-None-Match'] = conditional['etag']
    if conditional.get('modified'): headers['If-Modified-Since'] = conditional['modified']
    meter(requests=1)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=25) as response:
            raw = response.read(5 * 1024 * 1024 + 1)
            meter(size=len(raw))
            if len(raw) > 5 * 1024 * 1024: raise ValueError('Detail page exceeds the safe retrieval bound.')
            parser = ScheduleText(); parser.feed(raw.decode('utf-8'))
            text = ' '.join(' '.join(parser.parts).split())
            if not text: raise ValueError('No readable schedule data; use targeted public discovery.')
            return {'url': url, 'contentHash': hashlib.sha256(text.encode()).hexdigest(), 'detailContent': text,
                    'conditional': {'etag': response.headers.get('ETag'), 'modified': response.headers.get('Last-Modified')}, 'status': 'collected',
                    'retrieval': {'requests': 1, 'bytes': len(raw)}}
    except urllib.error.HTTPError as error:
        if error.code == 304 and old.get('reviewed'):
            return {**old['entry'], 'notModified': True, 'retrieval': {'requests': 1, 'bytes': 0}}
        return {'url': url, 'status': 'incomplete', 'error': 'HTTP ' + str(error.code), 'retrieval': {'requests': 1, 'bytes': 0}}
    except Exception as error:
        return {'url': url, 'status': 'incomplete', 'error': str(error), 'retrieval': {'requests': 1, 'bytes': 0}}


def detail_pages(links, previous):
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(lambda url: detail_page(url, previous), links))


def collect_all(previous=None, stats=None):
    global _METER
    _METER = stats
    previous = previous or {}
    sources = [('vals', "Val's", vals), ('dolphin', 'Dolphin Tavern', dolphin),
               ('wow', 'Warehouse on Watts', lambda: wow(previous.get('wow', {})))]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        rows = list(pool.map(lambda item: {'key': item[0], **collect(item[1], item[2])}, sources))
    return {'venues': rows}

def collect(name, adapter):
    try:
        return adapter()
    except Exception as error:
        return {"venue": name, "status": "incomplete", "error": str(error)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda item: collect(*item), [("Val's", vals), ("Dolphin Tavern", dolphin), ("Warehouse on Watts", wow)]))
    with open(args.output, "w") as stream:
        json.dump({"venues": results}, stream, ensure_ascii=False, indent=2)
    print(json.dumps([{key: row[key] for key in ["venue", "status"]} for row in results]))
