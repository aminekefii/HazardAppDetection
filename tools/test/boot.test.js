/* boot.test.js — does the app actually come up?
 *
 * Every other test here exercises one module. This one imports main.js, which
 * pulls in the whole graph and runs all of its top-level wiring, so a renamed
 * export or a button that is not in the HTML fails here instead of on a phone
 * with no console. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ok, eq, suite } from './assert.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ---- the ids the real page defines, read from the real page ---- */
const html = readFileSync(join(root, 'index.html'), 'utf8');
const PAGE_IDS = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

const listeners = [];
function makeEl(id) {
  const classes = new Set();
  return {
    id, textContent: '', disabled: false, value: '', width: 0, height: 0,
    videoWidth: 0, videoHeight: 0, readyState: 0, srcObject: null,
    style: { setProperty() {} },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    addEventListener: (type, fn) => listeners.push({ id, type, fn }),
    removeEventListener() {},
    getContext: () => ({
      drawImage() {}, clearRect() {}, fillRect() {}, strokeRect() {}, fillText() {},
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    }),
    toBlob: (cb) => cb({ size: 1 }),
    play: async () => {},
  };
}

const nodes = {};
const missing = [];
globalThis.document = {
  getElementById(id) {
    if (!PAGE_IDS.has(id)) missing.push(id);
    return (nodes[id] ||= makeEl(id));
  },
  createElement: () => makeEl('created'),
};

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};

globalThis.SpeechSynthesisUtterance = class {
  constructor(t) { this.text = t; this.volume = 1; }
};
globalThis.window = {
  addEventListener: (type, fn) => listeners.push({ id: 'window', type, fn }),
  matchMedia: () => ({ matches: false }),
  navigator: { standalone: false },
  speechSynthesis: {
    speaking: false, pending: false, paused: false,
    speak() {}, cancel() {}, resume() {}, getVoices: () => [{ name: 'Samantha' }],
  },
  AudioContext: class {
    constructor() { this.state = 'running'; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
    createBuffer() { return {}; }
  },
};
// Node ships its own read-only navigator, so replace the property outright
Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: true, gpu: null }, configurable: true, writable: true,
});
globalThis.performance = { now: () => 0 };
globalThis.requestAnimationFrame = () => 0;

const labels = JSON.parse(readFileSync(join(root, 'model', 'labels.json'), 'utf8'));
globalThis.fetch = async () => ({ ok: true, json: async () => labels });

let sessionCreated = false;
globalThis.ort = {
  env: { wasm: {} },
  Tensor: class {},
  InferenceSession: {
    create: async () => { sessionCreated = true; return { inputNames: ['images'], outputNames: ['output0'] }; },
  },
};

await suite('the whole app wires up without throwing', async () => {
  let err = null;
  try {
    await import('../../js/main.js');
  } catch (e) { err = e; }
  ok(!err, `main.js and everything it imports loaded${err ? `: ${err.message}` : ''}`);
  eq(missing.length, 0, `every element main.js reaches for exists in index.html${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
});

await suite('the model starts loading and the controls are live', async () => {
  await new Promise((r) => setImmediate(r));
  ok(sessionCreated, 'the ONNX session was created on load');
  eq(nodes.startBtn.textContent, 'Start camera', 'the Start button is offered once the model is ready');
  eq(nodes.startBtn.disabled, false, 'and is enabled');

  const wired = (id, type) => listeners.some((l) => l.id === id && l.type === type);
  ok(wired('startBtn', 'click'), 'Start is wired');
  ok(wired('muteBtn', 'click'), 'Mute is wired');
  ok(wired('testVoice', 'click'), 'Test voice is wired');
  ok(wired('gearBtn', 'click'), 'Settings is wired');
});

await suite('opening settings renders diagnostics on the device', async () => {
  const gear = listeners.find((l) => l.id === 'gearBtn' && l.type === 'click');
  gear.fn();
  const text = nodes.diag.textContent;
  ok(text.length > 0, 'the diagnostics block is filled in');
  for (const field of ['build', 'launched', 'speech', 'voices', 'synth', 'audio', 'camera']) {
    ok(text.includes(field), `it reports ${field}`);
  }
  ok(/launched\s+browser tab/.test(text), 'and says which way the app was launched');
});

await suite('Test voice speaks from inside the tap', async () => {
  const spoken = [];
  globalThis.window.speechSynthesis.speak = (u) => spoken.push(u.text);

  const btn = listeners.find((l) => l.id === 'testVoice' && l.type === 'click');
  btn.fn();
  ok(spoken.length > 0, 'tapping Test voice produces an utterance synchronously');
  ok(spoken.some((t) => t.trim().length > 0), `and it has real text: ${JSON.stringify(spoken)}`);
});

console.log('\n  boot: all assertions passed');
