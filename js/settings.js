/* settings.js — the API key lives here and nowhere else.
 * Stored in localStorage on the device; never in the repo, never uploaded. */

const KEY = 'gemini_key';

const els = {
  sheet: document.getElementById('sheet'),
  input: document.getElementById('keyInput'),
  save: document.getElementById('saveKey'),
  clear: document.getElementById('clearKey'),
  close: document.getElementById('closeSheet'),
  msg: document.getElementById('sheetMsg'),
  gear: document.getElementById('gearBtn'),
};

const listeners = [];
const openListeners = [];

export function getKey() { return localStorage.getItem(KEY); }
export function onChange(cb) { listeners.push(cb); }
function fire() { for (const cb of listeners) cb(getKey()); }

// The sheet is also where the diagnostics live, so whoever renders them needs
// to know when it is about to be shown.
export function onOpen(cb) { openListeners.push(cb); }

export function setKey(k) { localStorage.setItem(KEY, k); fire(); }
export function clearKey() { localStorage.removeItem(KEY); fire(); }

export function open() {
  els.input.value = getKey() || '';
  els.msg.textContent = getKey() ? 'A key is saved on this device.' : '';
  els.sheet.classList.remove('hidden');
  for (const cb of openListeners) cb();
}

export function close() { els.sheet.classList.add('hidden'); }

els.gear.addEventListener('click', open);
els.close.addEventListener('click', close);

els.save.addEventListener('click', () => {
  const v = els.input.value.trim();
  if (v.length < 20) { els.msg.textContent = 'That does not look like a valid key.'; return; }
  setKey(v);
  els.msg.textContent = 'Saved on this device.';
  setTimeout(close, 600);
});

els.clear.addEventListener('click', () => {
  clearKey();
  els.input.value = '';
  els.msg.textContent = 'Key removed from this device.';
});
