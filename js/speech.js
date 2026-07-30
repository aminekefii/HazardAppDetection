/* speech.js — reads the warning aloud.
 * iOS only permits speech synthesis after a user gesture, so unlock() must be
 * called from inside a real tap handler (the Start button). */

let muted = false;
let unlocked = false;
let onProblem = null;
let state = 'nothing spoken yet';

// Speech failing on a phone is invisible: no error, no console to read. Report
// it so the cause can be seen on the device instead of guessed at.
export function onSpeechProblem(cb) { onProblem = cb; }
export function status() { return state; }

function note(s, problem = false) {
  state = s;
  console.log('[speech]', s);
  if (problem && onProblem) onProblem(s);
}

export function unlock() {
  if (unlocked || !('speechSynthesis' in window)) return;
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
  note('unlocked inside the tap');
}

export function setMuted(v) {
  muted = v;
  if (muted && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

export function isMuted() { return muted; }

export function say(text) {
  if (muted || !text || !('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;

  const speakNow = () => {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;
    u.onstart = () => note('speaking');
    u.onend = () => note('finished');
    u.onerror = (e) => note(`speech failed: ${(e && e.error) || 'unknown'}`, true);
    synth.speak(u);

    // If none of those three ever fire, WebKit swallowed the utterance without
    // saying so — the one failure mode that leaves no trace anywhere.
    setTimeout(() => {
      if (state === 'queued') {
        note('queued but never started — check the Ring/Silent switch', true);
      }
    }, 4000);
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
