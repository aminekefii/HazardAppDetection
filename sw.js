/* sw.js — cache-first so the app boots and detects with no network.
 *
 * Three caches, versioned independently so a change to one does not re-download
 * the others. Bump only the one you actually changed:
 *   SHELL_VERSION    any html/css/js/icon change — a few KB, bump freely
 *   RUNTIME_VERSION  only when vendor/ is re-vendored — ~33 MB
 *   MODEL_VERSION    only when model/best.onnx is re-exported — ~38 MB
 * Keeping the ORT runtime out of the shell is what makes shipping a one-line
 * JS fix cost kilobytes instead of tens of megabytes. */
const SHELL_VERSION = 'shell-v4';
const RUNTIME_VERSION = 'ort-v1';
const MODEL_VERSION = 'model-v1';

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

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    // addAll is atomic per cache, so a failure only costs the one it belongs to
    await (await caches.open(SHELL_VERSION)).addAll(SHELL);
    await (await caches.open(RUNTIME_VERSION)).addAll(RUNTIME);
    await (await caches.open(MODEL_VERSION)).addAll(MODEL);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL_VERSION, RUNTIME_VERSION, MODEL_VERSION]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;              // never cache POSTs
  if (url.origin !== self.location.origin) return;     // never touch Gemini

  e.respondWith((async () => {
    const hit = await caches.match(e.request);
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      // belt and braces: anything under vendor/ that precaching somehow missed
      // still lands in the runtime cache rather than the shell
      if (res.ok && url.pathname.includes('/vendor/')) {
        (await caches.open(RUNTIME_VERSION)).put(e.request, res.clone());
      }
      return res;
    } catch (err) {
      if (e.request.mode === 'navigate') return caches.match('./index.html');
      throw err;
    }
  })());
});
