/* ui-chip.test.js — one chip, several sources.
 *
 * The old showChip(text) had no notion of who was speaking, so a one-off speech
 * failure overwrote the standing "add your key" prompt and nothing ever put it
 * back: the app then looked configured when it was not. */
import { ok, eq, suite } from './assert.js';

let now = 0;
let timers = [];
let nextId = 1;
globalThis.setTimeout = (fn, ms = 0) => { const id = nextId++; timers.push({ id, at: now + ms, fn }); return id; };
globalThis.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
function advance(ms) {
  const until = now + ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers = timers.filter((t) => t !== due);
    now = due.at;
    due.fn();
  }
  now = until;
}

const el = () => {
  const classes = new Set();
  return {
    textContent: '', style: { setProperty() {} },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    getContext: () => ({}),
  };
};
const nodes = {};
globalThis.document = {
  getElementById: (id) => (nodes[id] ||= el()),
};

const ui = await import('../../js/ui.js');
const chip = nodes.chip;
const visible = () => (chip.classList.contains('hidden') ? null : chip.textContent);

await suite('a standing prompt survives a transient problem', async () => {
  ui.setChip('key', 'Tap ⚙ to add your Gemini key');
  eq(visible(), 'Tap ⚙ to add your Gemini key', 'the key prompt shows');

  ui.setChip('speech', 'queued but never started', 12000);
  eq(visible(), 'queued but never started', 'the more urgent speech problem takes over');

  advance(12000);
  eq(visible(), 'Tap ⚙ to add your Gemini key',
    'and when it expires the key prompt comes back rather than being lost');
});

await suite('sources clear only their own message', async () => {
  ui.setChip('offline', 'Offline — detection only');
  eq(visible(), 'Offline — detection only', 'offline outranks the key prompt');

  ui.setChip('offline', null);
  eq(visible(), 'Tap ⚙ to add your Gemini key', 'clearing offline does not clear the key prompt');

  ui.setChip('key', null);
  eq(visible(), null, 'with nothing outstanding the chip hides');
});

await suite('the most urgent condition wins regardless of write order', async () => {
  ui.setChip('key', 'Tap ⚙ to add your Gemini key');
  ui.setChip('camera', 'Camera blocked — allow it in Settings ▸ Safari ▸ Camera');
  ui.setChip('offline', 'Offline — detection only');
  eq(visible(), 'Camera blocked — allow it in Settings ▸ Safari ▸ Camera',
    'a blocked camera is the most urgent thing on screen');

  ui.setChip('camera', null);
  eq(visible(), 'Offline — detection only', 'then offline');
  ui.setChip('offline', null);
  eq(visible(), 'Tap ⚙ to add your Gemini key', 'then the key prompt');
  ui.setChip('key', null);
  ok(visible() === null, 'then nothing');
});

console.log('\n  ui-chip: all assertions passed');
