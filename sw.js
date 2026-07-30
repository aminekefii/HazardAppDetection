/* sw.js — cache-first so the app boots and detects with no network.
 * Bump SHELL_VERSION whenever any shell file changes.
 * MODEL_VERSION only changes when model/best.onnx is re-exported. */
const SHELL_VERSION = 'shell-v2';
const MODEL_VERSION = 'model-v1';

// The ORT runtime is fetched lazily by ort.min.js, so on a first visit those
// requests race the worker's own registration and escape the fetch handler
// below. Left out of here they never reach the Cache API at all, and the app
// boots offline only for as long as the browser's HTTP cache happens to still
// hold them — once that is evicted (iOS does it aggressively to home-screen
// apps) the model fails with "no available backend found". Precaching is what
// makes offline boot a guarantee rather than a race against eviction.
// Both variants ship: detector.js prefers the WebGPU (jsep) build and falls
// back to the plain wasm one, and which path a phone takes is not knowable here.
const ORT_RUNTIME = [
  './vendor/ort.min.js',
  './vendor/ort-wasm-simd-threaded.mjs',
  './vendor/ort-wasm-simd-threaded.wasm',
  './vendor/ort-wasm-simd-threaded.jsep.mjs',
  './vendor/ort-wasm-simd-threaded.jsep.wasm',
];

const SHELL = [
  './', './index.html', './manifest.json',
  './css/style.css',
  './js/main.js', './js/detector.js', './js/gemini.js',
  './js/speech.js', './js/settings.js', './js/ui.js',
  ...ORT_RUNTIME,
  './icons/icon-192.png', './icons/icon-512.png',
];

const MODEL = ['./model/best.onnx', './model/labels.json'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL_VERSION);
    await shell.addAll(SHELL);
    const model = await caches.open(MODEL_VERSION);
    await model.addAll(MODEL);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL_VERSION, MODEL_VERSION]);
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
      // ORT fetches its .wasm lazily — cache whatever else we end up needing
      if (res.ok && url.pathname.includes('/vendor/')) {
        (await caches.open(SHELL_VERSION)).put(e.request, res.clone());
      }
      return res;
    } catch (err) {
      if (e.request.mode === 'navigate') return caches.match('./index.html');
      throw err;
    }
  })());
});
