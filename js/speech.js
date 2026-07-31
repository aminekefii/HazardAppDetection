/* speech.js — reads the warning aloud.
 * iOS only permits speech synthesis after a user gesture, so unlock() must be
 * called from inside a real tap handler (the Start button). */

let muted = false;
let unlocked = false;
let onProblem = null;
let state = 'nothing spoken yet';

// Identifies the newest utterance. Every callback and the silence watchdog
// check it before reporting, so a warning that was deliberately superseded by a
// newer one is not mistaken for a warning that failed.
let seq = 0;

const WATCHDOG_MS = 4000;

// Speech failing on a phone is invisible: no error, no console to read. Report
// it so the cause can be seen on the device instead of guessed at.
export function onSpeechProblem(cb) { onProblem = cb; }
export function status() { return state; }

function note(s, problem = false) {
  state = s;
  console.log('[speech]', s);
  if (problem && onProblem) onProblem(s);
}

export function isStandalone() {
  return window.navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches;
}

// Launched from the home screen, iOS does not hand speechSynthesis a working
// audio session; in a Safari tab it does, which is why the same build speaks in
// one and not the other. Opening a WebAudio context inside the tap and pushing
// one silent buffer through it starts a session the synthesiser can borrow.
// Kept in module scope so it is not garbage collected mid-session.
let audioCtx = null;
let audioSessionState = 'not opened';

function primeAudioSession() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) { audioSessionState = 'unsupported'; return; }
  try {
    audioCtx = new Ctx();
    const src = audioCtx.createBufferSource();
    src.buffer = audioCtx.createBuffer(1, 1, 22050);
    src.connect(audioCtx.destination);
    src.start(0);
    audioSessionState = audioCtx.state;
    if (audioCtx.state === 'suspended') {
      // resume() settles asynchronously: the state read on the next line is
      // still the old one, so record the real answer when it arrives rather
      // than reporting a value that is almost always wrong.
      Promise.resolve(audioCtx.resume())
        .then(() => { audioSessionState = audioCtx.state; })
        .catch((e) => { audioSessionState = `resume failed: ${e.message}`; });
    }
  } catch (e) {
    audioSessionState = `unavailable (${e.message})`;
    note(`audio session could not be opened: ${e.message}`);
  }
}

export function unlock() {
  if (unlocked || !('speechSynthesis' in window)) return;
  primeAudioSession();
  // The text must not be empty: WebKit discards an empty utterance without
  // ever starting the audio session, which leaves every later say() silently
  // ignored. A single space is inaudible but real enough to open the session.
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  window.speechSynthesis.speak(u);
  // iOS builds the voice list lazily. Asking for it inside the gesture starts
  // that work early, so the first real warning is not dropped for want of one.
  window.speechSynthesis.getVoices();
  unlocked = true;
  note(`unlocked inside the tap (${isStandalone() ? 'home-screen app' : 'browser tab'})`);
}

export function setMuted(v) {
  muted = v;
  if (muted && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

export function isMuted() { return muted; }

// Everything worth knowing about why a warning was or was not heard, in one
// object. Shown in the settings sheet, because the phone has no console and
// "it did not speak" is otherwise indistinguishable from "it never tried".
export function diagnostics() {
  const synth = window.speechSynthesis;
  return {
    mode: isStandalone() ? 'home-screen app' : 'browser tab',
    supported: !!synth,
    unlocked,
    muted,
    voices: synth ? synth.getVoices().length : 0,
    speaking: synth ? synth.speaking : false,
    pending: synth ? synth.pending : false,
    paused: synth ? synth.paused : false,
    audioSession: audioSessionState,
    lastEvent: state,
  };
}

// Speaks on demand from a tap, ignoring mute — the user asked for it directly.
// Exists to separate "speech is broken" from "no hazard has been confirmed
// yet", and to let the same check be run before and after the camera starts.
export function testVoice() {
  unlock();
  const wasMuted = muted;
  muted = false;
  say('Spoken warnings are working.');
  muted = wasMuted;
}

export function say(text) {
  if (muted || !text || !('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;
  const id = ++seq;

  const speakNow = () => {
    if (id !== seq) return;                 // a newer warning replaced this one

    // WebKit can leave the synthesiser paused — after a cancel(), or when a
    // home-screen app has been backgrounded and brought back. speak() then
    // queues the utterance and never starts it, with no error and no event:
    // exactly the silent failure the watchdog below was written to catch.
    if (synth.paused) synth.resume();

    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;
    u.onstart = () => { if (id === seq) note('speaking'); };
    u.onend = () => { if (id === seq) note('finished'); };
    u.onerror = (e) => {
      if (id === seq) note(`speech failed: ${(e && e.error) || 'unknown'}`, true);
    };
    synth.speak(u);

    // If none of those three ever fire, WebKit swallowed the utterance without
    // saying so — the one failure mode that leaves no trace anywhere.
    setTimeout(() => {
      if (id === seq && state === 'queued') {
        note('queued but never started — check the Ring/Silent switch', true);
      }
    }, WATCHDOG_MS);
  };

  note('queued');
  if (synth.speaking || synth.pending) {
    // WebKit drops a speak() issued in the same turn as a cancel(), so cancel
    // only when something is actually playing, and let it settle first.
    // Cancelling unconditionally here silenced every warning.
    synth.cancel();
    setTimeout(speakNow, 120);
  } else {
    speakNow();
  }
}
