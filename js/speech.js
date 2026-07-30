/* speech.js — reads the warning aloud.
 * iOS only permits speech synthesis after a user gesture, so unlock() must be
 * called from inside a real tap handler (the Start button). */

let muted = false;
let unlocked = false;

export function unlock() {
  if (unlocked || !('speechSynthesis' in window)) return;
  // The text must not be empty: WebKit discards an empty utterance without
  // ever starting the audio session, which leaves every later say() silently
  // ignored. A single space is inaudible but real enough to open the session.
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  window.speechSynthesis.speak(u);
  unlocked = true;
}

export function setMuted(v) {
  muted = v;
  if (muted && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

export function isMuted() { return muted; }

export function say(text) {
  if (muted || !text || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();          // never let warnings queue up
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.0;
  u.pitch = 1.0;
  window.speechSynthesis.speak(u);
}
