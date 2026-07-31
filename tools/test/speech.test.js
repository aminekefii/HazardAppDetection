/* speech.test.js — the invariants WebKit actually enforces.
 *
 * Desktop Chrome enforces none of these, which is why speech kept passing on a
 * laptop and failing on the phone. Each test encodes a rule iOS applies and
 * Chrome does not, so a regression is caught here rather than on a device. */
import { ok, eq, suite } from './assert.js';

/* ---- a controllable clock, so the 4s watchdog costs no wall time ---- */
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

/* ---- a WebKit-shaped speechSynthesis ---- */
let gestureOpen = false;

function makeWindow({ standalone = false, audioContextThrows = false } = {}) {
  const spoken = [];
  const synth = {
    speaking: false, pending: false, paused: false,
    _cancels: 0,
    speak(u) {
      // WebKit ignores a speak() issued while paused: it queues and never starts.
      spoken.push({ text: u.text, volume: u.volume, gestureOpen, paused: synth.paused, u });
      if (!synth.paused) { synth.speaking = true; u.onstart && u.onstart(); }
    },
    cancel() {
      synth._cancels++;
      synth.speaking = false; synth.pending = false;
      // Observed WebKit behaviour: cancel() can leave the synthesiser paused,
      // after which every later speak() is queued and silently dropped.
      synth.paused = true;
    },
    resume() { synth.paused = false; },
    getVoices: () => [{ name: 'Samantha' }],
  };
  return {
    _spoken: spoken,
    speechSynthesis: synth,
    navigator: { standalone },
    matchMedia: () => ({ matches: standalone }),
    AudioContext: class {
      constructor() {
        if (audioContextThrows) throw new Error('audio session unavailable');
        this.state = 'suspended';
        this.destination = {};
      }
      resume() { this.state = 'running'; return Promise.resolve(); }
      createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
      createBuffer() { return {}; }
    },
  };
}

globalThis.SpeechSynthesisUtterance = class {
  constructor(text) { this.text = text; this.volume = 1; this.rate = 1; this.pitch = 1; }
};

let v = 0;
async function freshSpeech(winOpts) {
  globalThis.window = makeWindow(winOpts);
  return { speech: await import(`../../js/speech.js?v=${++v}`), win: globalThis.window };
}

await suite('unlock happens inside the tap, which is the only moment iOS allows', async () => {
  const { speech, win } = await freshSpeech();
  gestureOpen = true;
  speech.unlock();          // must do its work with no await in front of it
  gestureOpen = false;

  eq(win._spoken.length, 1, 'unlock spoke exactly one priming utterance');
  ok(win._spoken[0].gestureOpen, 'it was spoken while the gesture was still open');
  ok(win._spoken[0].text.length > 0, 'the priming utterance is not empty — WebKit discards empty ones');
  eq(win._spoken[0].volume, 0, 'and it is inaudible');
});

await suite('a missing or broken audio session never blocks the unlock', async () => {
  const { speech, win } = await freshSpeech({ audioContextThrows: true });
  gestureOpen = true;
  speech.unlock();
  gestureOpen = false;
  eq(win._spoken.length, 1, 'speech is still unlocked when AudioContext cannot be opened');
  ok(win._spoken[0].gestureOpen, 'and still inside the gesture');
});

await suite('a warning is spoken even when the synthesiser was left paused', async () => {
  const { speech, win } = await freshSpeech();
  gestureOpen = true; speech.unlock(); gestureOpen = false;
  win._spoken.length = 0;

  // something is already playing, so say() will cancel first — and on WebKit
  // that cancel leaves the synthesiser paused.
  win.speechSynthesis.speaking = true;
  speech.say('Hot pan within reach of a child.');
  advance(1000);

  eq(win._spoken.length, 1, 'the warning was handed to the synthesiser');
  eq(win._spoken[0].text, 'Hot pan within reach of a child.', 'with the right text');
  ok(!win._spoken[0].paused, 'and the synthesiser was resumed first, so it actually starts');
});

await suite('the silent-failure watchdog reports only real silence', async () => {
  const { speech, win } = await freshSpeech();
  gestureOpen = true; speech.unlock(); gestureOpen = false;

  const problems = [];
  speech.onSpeechProblem((m) => problems.push(m));

  // two warnings in quick succession: the first is superseded, not lost
  speech.say('First warning.');
  speech.say('Second warning.');
  advance(10000);
  eq(problems.length, 0, 'superseding a warning does not raise a false alarm');
  void win;
});

await suite('genuinely swallowed speech is reported to the screen', async () => {
  const { speech, win } = await freshSpeech();
  gestureOpen = true; speech.unlock(); gestureOpen = false;

  const problems = [];
  speech.onSpeechProblem((m) => problems.push(m));

  // WebKit accepts the utterance and then fires nothing at all
  win.speechSynthesis.speak = (u) => { win._spoken.push({ text: u.text }); };
  speech.say('Sharp object on the floor.');
  advance(10000);
  eq(problems.length, 1, 'the user is told the warning never played');
  ok(/never started/i.test(problems[0]), `the message explains the silence: "${problems[0]}"`);
});

await suite('diagnostics can tell a home-screen launch from a Safari tab', async () => {
  const tab = await freshSpeech({ standalone: false });
  gestureOpen = true; tab.speech.unlock(); gestureOpen = false;
  eq(tab.speech.diagnostics().mode, 'browser tab', 'a tab reports itself as a tab');

  const app = await freshSpeech({ standalone: true });
  gestureOpen = true; app.speech.unlock(); gestureOpen = false;
  const d = app.speech.diagnostics();
  eq(d.mode, 'home-screen app', 'an installed app reports itself as one');
  eq(d.unlocked, true, 'diagnostics report the unlock state');
  eq(d.voices, 1, 'and how many voices iOS has actually handed over');
  ok('paused' in d, 'and whether the synthesiser is stuck paused');
});

await suite('muting stops speech and unmuting restores it', async () => {
  const { speech, win } = await freshSpeech();
  gestureOpen = true; speech.unlock(); gestureOpen = false;
  win._spoken.length = 0;

  speech.setMuted(true);
  speech.say('Ignored.');
  advance(1000);
  eq(win._spoken.length, 0, 'nothing is spoken while muted');

  speech.setMuted(false);
  speech.say('Heard.');
  advance(1000);
  eq(win._spoken.length, 1, 'speech resumes when unmuted');
});

console.log('\n  speech: all assertions passed');
