import { pathToFileURL } from 'node:url';
import { publicEvent } from '../functions/api/archive.js';
import { validEventId } from '../functions/event-records.js';
import { shareArtifact, SHARE_REPOSITORY } from '../functions/share-image-artifact.js';
import { fetchFlyer } from '../functions/share-image-source.js';
import { renderShareImage } from './render-share-image.mjs';

const meta = globalThis.QDPEventMetadata;
const API = `https://api.github.com/repos/${SHARE_REPOSITORY}`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function collectPublicEvents(site, fetcher = fetch) {
  const read = async path => {
    const response = await fetcher(new URL(path, site), {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Public feed returned ${response.status}.`);
    return response.json();
  };
  const found = new Map();
  const add = rows => {
    if (!Array.isArray(rows)) throw new Error('Invalid public event feed.');
    for (const raw of rows) {
      // These endpoints have already applied the public gate. Respect any
      // explicit withdrawal flag as well, and apply their usual field cleaner.
      const event = publicEvent({ ...raw, public: raw.public ?? true });
      if (event && validEventId(event.eventId) && meta.image(event) && !found.has(event.eventId)) {
        found.set(event.eventId, event);
      }
    }
  };
  // Upcoming events have first priority; remaining slots backfill the archive.
  add((await read('/api/events')).events);
  const directory = await read('/api/archive?resource=months');
  if (!Array.isArray(directory.months)) throw new Error('Invalid public month directory.');
  const months = [...new Set(directory.months.map(item => item.month))]
    .filter(month => /^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)).sort().reverse();
  for (const month of months) {
    const payload = await read(`/api/archive?resource=month&month=${month}`);
    if (!Array.isArray(payload.events)) throw new Error('Invalid public month feed.');
    add(payload.events.sort((a, b) => Date.parse(b.start) - Date.parse(a.start)));
  }
  return [...found.values()];
}

export class GitHubImageStore {
  constructor(token, { fetcher = fetch, gap = 1100, commit = 'main' } = {}) {
    if (!token) throw new Error('GITHUB_TOKEN is required to prepare share images.');
    this.token = token; this.fetcher = fetcher; this.gap = gap; this.commit = commit;
    this.releases = new Map(); this.queue = Promise.resolve(); this.lastWrite = 0;
  }

  async request(path, { method = 'GET', body, type = 'application/json', missing = false } = {}) {
    const url = new URL(path.startsWith('https:') ? path : `${API}${path}`);
    if (!['api.github.com', 'uploads.github.com'].includes(url.hostname) ||
        !url.pathname.startsWith(`/repos/${SHARE_REPOSITORY}/`)) throw new Error('Invalid asset destination.');
    const response = await this.fetcher(url.href, { method, redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`,
        'Content-Type': type, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'QDP-Share-Images' },
      ...(body === undefined ? {} : { body: type === 'application/json' ? JSON.stringify(body) : body }),
      signal: AbortSignal.timeout(30000) });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub asset operation failed (${response.status}).`);
    return response.status === 204 ? null : response.json();
  }

  write(operation) {
    const next = this.queue.then(async () => {
      await pause(Math.max(0, this.lastWrite + this.gap - Date.now()));
      this.lastWrite = Date.now();
      return operation();
    });
    this.queue = next.catch(() => {});
    return next;
  }

  inventory(tag) {
    if (!this.releases.has(tag)) this.releases.set(tag, (async () => {
      const release = await this.request(`/releases/tags/${tag}`, { missing: true });
      const assets = new Map();
      if (release) for (let page = 1; ; page++) {
        const batch = await this.request(`/releases/${release.id}/assets?per_page=100&page=${page}`);
        for (const asset of batch) if (asset.state === 'uploaded') assets.set(asset.name, asset.id);
        if (batch.length < 100) break;
      }
      return { release, assets };
    })());
    return this.releases.get(tag);
  }

  async upload(artifact, png) {
    const inventory = await this.inventory(artifact.tag);
    return this.write(async () => {
      if (inventory.assets.has(artifact.name)) return;
      if (!inventory.release) {
        inventory.release = await this.request('/releases', { method: 'POST', body: {
          tag_name: artifact.tag, target_commitish: this.commit,
          name: `QDP share images — ${artifact.tag.slice(-7)}`, draft: false,
          prerelease: true, make_latest: 'false',
          body: 'Automatically prepared event link-preview images from the published QDP website. No spreadsheet or private source data is included.'
        } });
      }
      const upload = new URL(inventory.release.upload_url.replace(/\{.*$/, ''));
      upload.searchParams.set('name', artifact.name);
      const asset = await this.request(upload.href, { method: 'POST', body: png, type: 'image/png' });
      inventory.assets.set(asset.name, asset.id);
    });
  }

  async remove(tag, name) {
    const inventory = await this.inventory(tag);
    const id = inventory.assets.get(name);
    if (id) await this.write(async () => {
      await this.request(`/releases/assets/${id}`, { method: 'DELETE' });
      inventory.assets.delete(name);
    });
  }
}

export async function prepareImages({ events, store, limit = 250, fetcher = fetch,
  render = renderShareImage, log = console.log }) {
  const groups = new Map(), pending = [];
  const stats = { prepared: 0, reused: 0, unavailable: 0, pending: 0, removed: 0 };
  for (const event of events) {
    const artifact = await shareArtifact(event);
    if (!groups.has(artifact.tag)) groups.set(artifact.tag, new Set());
    groups.get(artifact.tag).add(artifact.name);
    if ((await store.inventory(artifact.tag)).assets.has(artifact.name)) stats.reused++;
    else pending.push({ event, artifact });
  }
  stats.pending = Math.max(0, pending.length - limit);
  const queue = pending.slice(0, limit);
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const { event, artifact } = queue.shift();
      let png;
      try { png = await render(event, await fetchFlyer(meta.image(event), fetcher)); }
      catch (error) {
        stats.unavailable++;
        log(`Could not prepare ${event.eventId}: ${error.message}`);
        continue;
      }
      // An upload/authentication failure stops the job, rather than attempting
      // hundreds more writes with the same unavailable token or rate limit.
      await store.upload(artifact, png);
      stats.prepared++;
      log(`Prepared ${event.eventId}`);
    }
  }));
  // Clean only assets created by this job. Event lookups independently block
  // withdrawn events immediately, including while a background run is pending.
  for (const [tag, wanted] of groups) {
    const { assets } = await store.inventory(tag);
    for (const name of [...assets.keys()]) if (/^event-[a-f0-9]{64}\.png$/.test(name) && !wanted.has(name)) {
      await store.remove(tag, name); stats.removed++;
    }
  }
  return stats;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const events = await collectPublicEvents('https://queerdancephilly.com');
  const store = new GitHubImageStore(process.env.GITHUB_TOKEN, { commit: process.env.GITHUB_SHA || 'main' });
  const stats = await prepareImages({ events, store });
  console.log(JSON.stringify({ publicFlyers: events.length, ...stats }));
}
