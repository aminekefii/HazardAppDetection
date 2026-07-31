/* sw-cache.test.js — the service worker's update and offline guarantees.
 *
 * These exist because of a real bug: commit 940ef24 fixed iOS speech in
 * js/speech.js without touching sw.js. No sw.js change means no install event,
 * which means the shell cache was never rebuilt, which means every already
 * installed phone kept running the *pre-fix* speech.js indefinitely. The fix
 * was deployed and no device received it.
 *
 * The invariant that would have caught it: a shell asset must never be served
 * from cache while the network can supply a newer one. */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ok, eq, suite } from './assert.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCOPE = 'https://example.test/app/';
const SW_URL = `${SCOPE}sw.js`;

const abs = (u) => new URL(typeof u === 'string' ? u : u.url, SW_URL).href;

function makeCacheStorage() {
  const store = new Map();               // cacheName -> Map(url -> Response)
  const cacheFor = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name);
    return {
      async addAll(urls) {
        // real addAll is atomic: fetch everything, only then commit
        const got = [];
        for (const u of urls) {
          const res = await globalThis.fetch(new Request(abs(u)));
          if (!res.ok) throw new TypeError(`addAll failed for ${u}`);
          got.push([abs(u), res]);
        }
        for (const [k, v] of got) m.set(k, v);
      },
      async put(req, res) {
        if (req.mode === 'navigate') throw new TypeError('Request mode must not be navigate');
        m.set(abs(req), res);
      },
      async match(req) { return m.get(abs(req)); },
    };
  };
  return {
    _store: store,
    open: async (name) => cacheFor(name),
    keys: async () => [...store.keys()],
    delete: async (name) => store.delete(name),
    match: async (req) => {
      for (const m of store.values()) if (m.has(abs(req))) return m.get(abs(req));
      return undefined;
    },
  };
}

function loadSW({ network }) {
  const handlers = {};
  const caches = makeCacheStorage();
  const calls = [];

  const sandbox = {
    console, URL, Request, Response, Headers, TypeError, Promise, Error,
    setTimeout, clearTimeout, caches,
    fetch: async (req) => {
      const url = abs(req);
      calls.push(url);
      const entry = network[url.replace(SCOPE, './')] ?? network[url];
      if (entry === undefined) return new Response('not found', { status: 404 });
      if (entry instanceof Error) throw entry;
      return new Response(entry, { status: 200 });
    },
    self: {
      addEventListener: (t, fn) => { (handlers[t] ||= []).push(fn); },
      location: { origin: 'https://example.test', href: SW_URL },
      skipWaiting: () => {},
      clients: { claim: async () => {} },
    },
  };
  sandbox.globalThis = sandbox;
  globalThis.fetch = sandbox.fetch;      // the cache stub's addAll uses it too
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(root, 'sw.js'), 'utf8'), sandbox, { filename: 'sw.js' });
  return { handlers, caches, calls, sandbox };
}

const dispatchInstall = async (handlers) => {
  let p;
  for (const h of handlers.install || []) h({ waitUntil: (x) => { p = x; } });
  return p;
};

const dispatchFetch = async (handlers, request) => {
  let p;
  for (const h of handlers.fetch || []) h({ request, respondWith: (x) => { p = x; } });
  return p ? await p : undefined;
};

/* A page load. The Request constructor refuses mode:'navigate' — only the
 * browser may set it — so model the shape the worker actually receives. */
const navigation = (url) => ({ method: 'GET', url, mode: 'navigate' });

/* Every shell asset, as the worker itself lists them. */
const FRESH_NETWORK = {
  './': '<!doctype html>fresh', './index.html': '<!doctype html>fresh',
  './manifest.json': '{}', './css/style.css': 'css',
  './js/main.js': 'FRESH', './js/detector.js': 'FRESH', './js/gemini.js': 'FRESH',
  './js/speech.js': 'FRESH', './js/settings.js': 'FRESH', './js/ui.js': 'FRESH',
  './icons/icon-192.png': 'png', './icons/icon-512.png': 'png',
  './vendor/ort.min.js': 'ORT', './vendor/ort-wasm-simd-threaded.mjs': 'ORT',
  './vendor/ort-wasm-simd-threaded.wasm': 'ORT',
  './vendor/ort-wasm-simd-threaded.jsep.mjs': 'ORT',
  './vendor/ort-wasm-simd-threaded.jsep.wasm': 'ORT',
  './model/best.onnx': 'MODEL', './model/labels.json': '{}',
};

await suite('a deployed js fix reaches an already installed app', async () => {
  const { handlers, caches, sandbox } = loadSW({ network: FRESH_NETWORK });
  await dispatchInstall(handlers);

  // the phone installed the app before the fix: its cache holds the old file
  const shellName = (await caches.keys()).find((k) => k.startsWith('shell'));
  (await caches.open(shellName))._ = null;
  caches._store.get(shellName).set(`${SCOPE}js/speech.js`, new Response('STALE'));

  const res = await dispatchFetch(handlers, new Request(`${SCOPE}js/speech.js`));
  eq(await res.text(), 'FRESH', 'shell js is served from the network, not the stale cache');
  void sandbox;
});

await suite('the app still boots with no network', async () => {
  const offline = { ...FRESH_NETWORK };
  const { handlers, caches } = loadSW({ network: offline });
  await dispatchInstall(handlers);

  // now the network dies
  for (const k of Object.keys(offline)) offline[k] = new TypeError('offline');

  const res = await dispatchFetch(handlers, new Request(`${SCOPE}js/speech.js`));
  ok(res, 'a response is produced offline');
  eq(await res.text(), 'FRESH', 'the cached copy is served when the network is gone');

  const nav = await dispatchFetch(handlers, navigation(SCOPE));
  ok((await nav.text()).includes('fresh'), 'navigation falls back to the cached shell');
  void caches;
});

await suite('the 33MB runtime and 38MB model are never re-fetched', async () => {
  const { handlers, calls } = loadSW({ network: FRESH_NETWORK });
  await dispatchInstall(handlers);
  const before = calls.length;

  const res = await dispatchFetch(handlers, new Request(`${SCOPE}vendor/ort.min.js`));
  eq(await res.text(), 'ORT', 'the vendored runtime is served from cache');
  eq(calls.length, before, 'and cost no network request at all');

  const m = await dispatchFetch(handlers, new Request(`${SCOPE}model/best.onnx`));
  eq(await m.text(), 'MODEL', 'the model is served from cache');
  eq(calls.length, before, 'and cost no network request either');
});

await suite('one failed precache does not cost the other two', async () => {
  const net = { ...FRESH_NETWORK, './vendor/ort-wasm-simd-threaded.wasm': new TypeError('connection lost') };
  const { handlers, caches } = loadSW({ network: net });

  let threw = null;
  try { await dispatchInstall(handlers); } catch (e) { threw = e; }
  ok(!threw, 'install completes even though the runtime precache failed');

  const names = await caches.keys();
  const shell = names.find((k) => k.startsWith('shell'));
  const model = names.find((k) => k.startsWith('model'));
  ok(await (await caches.open(shell)).match('./js/speech.js'), 'the shell was still cached');
  ok(await (await caches.open(model)).match('./model/best.onnx'), 'the model was still cached');
});

await suite('cross-origin and non-GET traffic is left alone', async () => {
  const { handlers } = loadSW({ network: FRESH_NETWORK });
  await dispatchInstall(handlers);

  const gem = await dispatchFetch(handlers, new Request(
    'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent', { method: 'POST' }));
  eq(gem, undefined, 'the Gemini call is not intercepted');

  const post = await dispatchFetch(handlers, new Request(`${SCOPE}anything`, { method: 'POST' }));
  eq(post, undefined, 'POSTs are not intercepted');
});

console.log('\n  sw-cache: all assertions passed');
