// Snapshot indexes grow with Events, Calendar and intake. Keep bounded immutable
// index pages outside the small, versioned head that publishes a complete sync.
import {meta} from './discovery-store.js';
import {digest} from '../shared/discovery-identity.js';

const INDEX_PAGE_LIMIT = 100000;
const incomplete = () => new Error('The matching snapshot index is incomplete. Synchronize it before claiming absence.');

export async function snapshotIndexPages(index) {
  const rows = [];let values = [], length = 2;
  const flush = async () => {
    if (!values.length) return;
    const key = 'snapshot:index:' + await digest(JSON.stringify(values));
    rows.push({key, value:values});values = [];length = 2;
  };
  for (const entry of index) {
    const size = JSON.stringify(entry).length;
    if (size + 2 > INDEX_PAGE_LIMIT) throw new Error('An individual snapshot index entry exceeds its bounded page size.');
    if (length + size + (values.length ? 1 : 0) > INDEX_PAGE_LIMIT) await flush();
    length += size + (values.length ? 1 : 0);values.push(entry);
  }
  await flush();
  return {manifest:{indexVersion:2,indexParts:rows.map(row=>row.key),indexCount:index.length},rows};
}

export async function readSnapshot(db) {
  const saved = await meta(db, 'snapshot-head');
  if (!saved) return null;
  const head = saved.value;
  // Existing inline heads remain readable until the next successful sync.
  if (head.indexVersion == null && Array.isArray(head.index)) return saved;
  if (head.indexVersion !== 2 || !Array.isArray(head.indexParts) || !Number.isInteger(head.indexCount) || head.indexCount < 0 ||
      head.indexParts.some(key=>typeof key!=='string'||!/^snapshot:index:[a-f0-9]{64}$/.test(key))) throw incomplete();
  const rows = head.indexParts.length ? await db.prepare('SELECT key,value FROM discovery_meta WHERE key IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(head.indexParts)).all() : {results:[]};
  const byKey = new Map(rows.results.map(row=>[row.key,row.value])), index = [];
  for (const key of head.indexParts) {
    const text = byKey.get(key);let page;
    try {page = JSON.parse(text);} catch (_) {throw incomplete();}
    if (!Array.isArray(page) || text.length > INDEX_PAGE_LIMIT || 'snapshot:index:' + await digest(JSON.stringify(page)) !== key) throw incomplete();
    index.push(...page);
  }
  if (index.length !== head.indexCount) throw incomplete();
  return {...saved,value:{...head,index}};
}
