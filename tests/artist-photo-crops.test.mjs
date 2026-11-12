import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost as save } from "../functions/admin/artist-photo-crop.js";
import { onRequestGet as archive } from "../functions/api/archive.js";
import { renderDirectory } from "../functions/directory-page.js";
import { renderProfileDrawer } from "../functions/profile-page.js";

const meta = globalThis.QDPProfileMetadata;
const origin = "https://qdp.example";
const issuer = "https://qdp-access.example";
const prefix = "qdp-artist-photo-crop:v1:";
const imageUrl = "https://drive.google.com/uc?export=view&id=PORTRAIT";
const src = "https://lh3.googleusercontent.com/d/PORTRAIT=w1600";
const crop = { x: .25, y: .75, zoom: 1.5, aspect: .5 };

test("portrait and landscape crops cover a square and use the same geometry across surfaces", () => {
  assert.deepEqual(meta.photoCropFrame(crop), { width: 1.5, height: 3, x: .125, y: 1.5 });
  assert.deepEqual(meta.photoCropFrame({ ...crop, aspect: 2, zoom: 1 }),
    { width: 2, height: 1, x: .25, y: 0 });
  for (const value of [null, {}, { ...crop, x: -1 }, { ...crop, y: "0.5" },
    { ...crop, aspect: 0 }, { ...crop, zoom: 4.01 }]) {
    assert.equal(meta.photoCropFrame(value), null);
  }
  const profile = { id: "A", name: "Alpha", imageUrl, imageCrop: crop };
  assert.match(renderDirectory("artists", [profile], origin),
    /archive-directory-photo" style="--photo-width:150%;--photo-height:300%;--photo-left:-12\.5%;--photo-top:-150%"/);
  assert.doesNotMatch(renderDirectory("parties", [profile], origin), /--photo-width/);
  assert.doesNotMatch(renderProfileDrawer("artist", profile), /--photo-width/);
});

async function accessSession(edge) {
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256",
    modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
  const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  edge.set(issuer + "/cdn-cgi/access/certs", Response.json({ keys: [{ ...jwk, kid: "fixture" }] }));
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = [
    encode({ alg: "RS256", kid: "fixture" }),
    encode({ iss: issuer, aud: ["qdp-admin"], email: "admin@example.com", exp: Date.now() / 1000 + 120 })
  ].join(".");
  const signature = await crypto.subtle.sign(algorithm, keys.privateKey, new TextEncoder().encode(token));
  return token + "." + Buffer.from(signature).toString("base64url");
}

test("admin saves and clears one public artist crop, with authorization and source matching", async t => {
  const previousCaches = globalThis.caches;
  const edge = new Map();
  globalThis.caches = { default: {
    match: async key => edge.get(key.url)?.clone(),
    put: async (key, response) => edge.set(key.url, response.clone()),
    delete: async key => edge.delete(key.url)
  } };
  t.after(() => { globalThis.caches = previousCaches; });
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected upstream request"); });
  const token = await accessSession(edge);
  const certsUrl = issuer + "/cdn-cgi/access/certs";
  const certs = edge.get(certsUrl);
  const profiles = [
    { id: "A", name: "Alpha", publicOk: true, imageUrl },
    { id: "B", name: "Beta", publicOk: true, imageUrl },
    { id: "PRIVATE", name: "Private", publicOk: false, imageUrl }
  ];
  const manifest = { schema: 1, revision: "one", artists: ["A", "B"] };
  const records = new Map();
  const lists = [];
  const kv = {
    get: async key => key.endsWith(":manifest") ? manifest : { revision: manifest.revision, payload: { artists: profiles } },
    list: async ({ prefix: requested, cursor }) => {
      lists.push({ requested, cursor });
      const keys = [...records].filter(([key]) => key.startsWith(requested)).map(([name, metadata]) => ({ name, metadata }));
      return cursor ? { list_complete: true, keys } : { list_complete: false, cursor: "next", keys: [] };
    },
    put: async (key, value, { metadata }) => {
      assert.deepEqual(JSON.parse(value), metadata);
      records.set(key, metadata);
    },
    delete: async key => records.delete(key)
  };
  const env = { QDP_PUBLIC_FEED_KV: kv, CF_ACCESS_TEAM_DOMAIN: issuer, CF_ACCESS_AUD: "qdp-admin",
    QDP_ADMIN_EMAILS: "admin@example.com" };
  const post = (body, assertion = token, from = origin) => save({
    request: new Request(origin + "/admin/artist-photo-crop", {
      method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", Origin: from, "Cf-Access-Jwt-Assertion": assertion }
    }), env
  });
  const directory = async () => {
    const response = await archive({ request: new Request(origin + "/api/archive?resource=artists"), env });
    assert.equal(response.status, 200);
    return (await response.json()).artists;
  };

  assert.equal((await post({ id: "A", src, crop }, "")).status, 403);
  assert.equal((await post({ id: "A", src, crop }, token, "https://elsewhere.example")).status, 403);
  assert.equal((await post({ id: "A", src, crop: { ...crop, zoom: 5 } })).status, 400);
  assert.equal((await post({ id: "PRIVATE", src, crop })).status, 409);
  assert.equal((await post({ id: "A", src: "https://example.com/old.jpg", crop })).status, 409);
  assert.equal(records.size, 0);
  assert.deepEqual(await directory().then(items => items.map(item => item.imageCrop)), [undefined, undefined]);
  assert.deepEqual(lists, [{ requested: prefix, cursor: undefined }, { requested: prefix, cursor: "next" }]);
  const directoryKey = origin + "/_qdp/directory-v2?kind=artists";
  edge.set(directoryKey, new Response("before save"));
  const saved = await post({ id: "A", src, crop });
  assert.equal(saved.status, 200);
  assert.match(saved.headers.get("Cache-Control"), /no-store/);
  assert.deepEqual(await saved.json(), { crop });
  assert.equal(edge.has(directoryKey), false);
  assert.deepEqual([...records.keys()], [prefix + "A"]);
  assert.deepEqual(await directory().then(items => items.map(item => item.imageCrop)), [crop, undefined]);

  profiles[0].imageUrl = "https://example.com/new.jpg";
  manifest.revision = "two";
  edge.clear();
  assert.equal((await directory())[0].imageCrop, undefined);
  profiles[0].imageUrl = imageUrl;
  manifest.revision = "three";
  edge.clear();
  edge.set(certsUrl, certs);
  assert.deepEqual((await directory())[0].imageCrop, crop);
  const cleared = await post({ id: "A", src, crop: null });
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { crop: null });
  assert.equal(records.size, 0);
  assert.equal((await directory())[0].imageCrop, undefined);
});
