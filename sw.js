/* sw.js — offline operation without ever pinning the app to stale code.
 *
 * Two routing rules, chosen by what the asset costs to re-fetch:
 *
 *   shell (html/css/js/icons, a few KB)   network-first, cache as fallback
 *   runtime + model (~71 MB together)     cache-first, network only on a miss
 *
 * The shell rule is not a preference, it is a bug fix. Under the previous
 * cache-first rule a JS change only reached a phone if sw.js *also* changed and
 * SHELL_VERSION was bumped by hand. Commit 940ef24 fixed iOS speech in
 * js/speech.js and touched neither, so no install event ever fired, the shell
 * cache was never rebuilt, and every phone that had already added the app to
 * its home screen went on running the broken speech.js forever. Because iOS
 * gives a home-screen web app its own storage, separate from Safari's, the same
 * deployed build could speak in a tab and stay silent in the installed app.
 * Serving the shell network-first removes the whole class of failure: a fix
 * ships by being deployed, not by remembering to bump a constant.
 *
 * The big files keep the old rule — they are the reason offline works at all,
 * and they only change when deliberately re-exported or re-vendored. Bump those
 * versions when you replace them. */
const SHELL_VERSION = 'shell-v5';
const RUNTIME_VERSION = 'ort-v1';
const MODEL_VERSION = 'model-v1';

// Long enough not to trip on a slow cellular hop, short enough that a phone in
// a dead zone reaches the cached copy quickly rather than staring at a blank
// screen. Only ever paid on the shell's few KB.
const NETWORK_TIMEOUT_MS = 3000;

const SHELL = [
  './', './index.html', './manifest.json',
  './css/style.css',
  './js/main.js', './js/detector.js', './js/gemini.js',
  './js/speech.js', './js/settings.js', './js/ui.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

// The ORT runtime is fetched lazily by ort.min.js, so on a first visit those
// requests race the worker's own registration and escape the fetch handler
// below. Left out of here they never reach the Cache API at all, and the app
// boots offline only for as long as the browser's HTTP cache happens to still
// hold them — once that is evicted (iOS does it aggressively to home-screen
// apps) the model fails with "no available backend found". Precaching is what
// makes offline boot a guarantee rather than a race against eviction.
// Both variants ship: detector.js prefers the WebGPU (jsep) build and falls
// back to the plain wasm one, and which path a phone takes is not knowable here.
const RUNTIME = [
  './vendor/ort.min.js',
  './vendor/ort-wasm-simd-threaded.mjs',
  './vendor/ort-wasm-simd-threaded.wasm',
  './vendor/ort-wasm-simd-threaded.jsep.mjs',
  './vendor/ort-wasm-simd-threaded.jsep.wasm',
];

const MODEL = ['./model/best.onnx', './model/labels.json'];

const isRuntime = (url) => url.pathname.includes('/vendor/');
const isModel = (url) => url.pathname.includes('/model/');
const isHeavy = (url) => isRuntime(url) || isModel(url);

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    // Each cache is filled independently. Awaiting them in sequence, as this
    // once did, means a dropped connection during the 33 MB runtime download
    // rejects the whole install: the worker never activates, the model is never
    // fetched, and the retry starts again from zero. addAll is atomic per
    // cache, so a failure here costs exactly the one cache it belongs to, and
    // the fetch handler backfills whatever is missing on first use.
    const precache = async (version, urls) => {
      try {
        await (await caches.open(version)).addAll(urls);
      } catch (err) {
        console.warn(`[sw] ${version} precache failed, will backfill on demand`, err);
      }
    };
    await Promise.all([
      precache(SHELL_VERSION, SHELL),
      precache(RUNTIME_VERSION, RUNTIME),
      precache(MODEL_VERSION, MODEL),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL_VERSION, RUNTIME_VERSION, MODEL_VERSION]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('network timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// cache.put rejects a request whose mode is 'navigate', so store navigations
// under a plain request for the same URL.
const cacheKey = (request) =>
  (request.mode === 'navigate' ? new Request(request.url) : request);

async function shellFirst(request) {
  let res = null;
  try {
    res = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
  } catch {
    // offline, or the network is answering too slowly to wait for
  }
  if (res && res.ok) {
    try {
      (await caches.open(SHELL_VERSION)).put(cacheKey(request), res.clone());
    } catch (err) {
      console.warn('[sw] could not cache', request.url, err);
    }
    return res;
  }
  const hit = await caches.match(request);
  if (hit) return hit;
  if (res) return res;                      // a real 404/500 with nothing cached
  if (request.mode === 'navigate') {
    const index = await caches.match('./index.html');
    if (index) return index;
  }
  return new Response('offline and not cached', { status: 503 });
}

async function cacheFirst(request, url) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) {
    const version = isRuntime(url) ? RUNTIME_VERSION : MODEL_VERSION;
    try {
      (await caches.open(version)).put(cacheKey(request), res.clone());
    } catch (err) {
      console.warn('[sw] could not cache', request.url, err);
    }
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;              // never cache POSTs
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;     // never touch Gemini

  e.respondWith(isHeavy(url) ? cacheFirst(e.request, url) : shellFirst(e.request));
});
