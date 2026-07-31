/* main.js — orchestration only: camera, render loop, state.
 * Verification (Gemini) is wired in Task 5. */
import * as detector from './detector.js';
import * as ui from './ui.js';
import * as gemini from './gemini.js';
import * as speech from './speech.js';
import * as settings from './settings.js';

// Shown in the settings sheet. Its only job is to answer "is this phone running
// the build I just deployed?" without guessing — the question that went
// unanswered while a stale service-worker cache pinned installed apps to old
// code. Bump it when you deploy something you need to confirm arrived.
const BUILD = '2026-07-31a';

const els = {
  video: document.getElementById('video'),
  overlay: document.getElementById('overlay'),
  startBtn: document.getElementById('startBtn'),
};

let running = false;
const fpsBuf = [];

// The free tier for gemini-2.5-flash is 20 requests PER DAY, not per minute
// (quota GenerateRequestsPerDayPerProjectPerModel-FreeTier), so this 8s gap
// spends the whole daily allowance in ~2.5 minutes of continuous detection.
// Raise it, or use a paid key, for anything longer than a demo. See README.
const COOLDOWN_MS = 8000;
let cooldownMs = COOLDOWN_MS;    // temporarily raised after a 429
let lastCheck = 0;
let inFlight = false;
let offlineChip = false;
const snap = document.createElement('canvas');

// iOS reports videoWidth as 0 until metadata arrives; sizing canvases before
// that yields a 0x0 overlay and an empty snapshot. Always wait — but never
// forever. Waiting on loadedmetadata alone hangs if the event already fired
// while videoWidth was still 0, and a hang here leaves the Start button
// disabled with the status stuck on "starting camera…" and no way back.
function waitForMetadata(video, timeoutMs = 8000) {
  if (video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (err) => {
      clearInterval(poll);
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onMeta);
      err ? reject(err) : resolve();
    };
    const onMeta = () => { if (video.videoWidth > 0) finish(); };
    const poll = setInterval(onMeta, 100);
    const timer = setTimeout(
      () => finish(new Error('the camera never reported a frame size')), timeoutMs);
    video.addEventListener('loadedmetadata', onMeta);
  });
}

// The overlay and the snapshot are both sized in source pixels, so they have to
// follow the track when it changes shape — rotating the phone in a Safari tab
// otherwise leaves every box drawn against stale dimensions and sends Gemini a
// mis-cropped frame.
function sizeToVideo() {
  if (!els.video.videoWidth) return;
  ui.initCanvas();
  snap.width = els.video.videoWidth;
  snap.height = els.video.videoHeight;
}

async function startCamera() {
  els.startBtn.disabled = true;
  ui.setStatus('starting camera…');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  els.video.srcObject = stream;
  await els.video.play();
  await waitForMetadata(els.video);
  sizeToVideo();
  els.video.addEventListener('resize', sizeToVideo);
  els.startBtn.classList.add('hidden');
  running = true;
  requestAnimationFrame(loop);
}

function grabFrame() {
  snap.getContext('2d').drawImage(els.video, 0, 0, snap.width, snap.height);
  return new Promise((res) => snap.toBlob(res, 'image/jpeg', 0.85));
}

async function verify(dets) {
  const key = settings.getKey();
  if (!key) return;                   // reflectKeyState already owns that chip

  inFlight = true;
  ui.setStatus('Gemini: checking…');
  try {
    const blob = await grabFrame();
    const finding = dets
      .map((d) => `${d.name} with ${Math.round(d.conf * 100)}% confidence`)
      .join('; ');
    const verdict = await gemini.verify(blob, finding, key);
    ui.showBanner(verdict);
    if (verdict.confirmed === true) speech.say(verdict.warning);
    cooldownMs = COOLDOWN_MS;
    console.log('[gemini]', verdict);
  } catch (e) {
    if (e.kind === 'quota') {
      cooldownMs = Math.max(e.retryAfterMs, 60000);
      ui.showBannerMessage(`Rate limited — pausing ${Math.round(cooldownMs / 1000)}s`);
    } else if (e.kind === 'auth') {
      ui.showBannerMessage('API key rejected — tap ⚙ to fix it');
      settings.open();
    } else if (e.kind === 'network') {
      ui.showBannerMessage('Offline — detection only');
    } else {
      ui.showBannerMessage(e.message);
    }
    console.warn(e);
  } finally {
    inFlight = false;
  }
}

async function loop() {
  if (!running) return;
  const t0 = performance.now();

  const dets = await detector.detect(els.video, els.video.videoWidth, els.video.videoHeight);
  ui.drawBoxes(dets);

  // Offline never reaches gemini.js: the guard below means verify() is not
  // called at all, so the 'network' branch cannot report it. Say so here
  // instead, or a hazard silently goes unverified with no explanation.
  const now = performance.now();
  if (!navigator.onLine) {
    if (dets.length && !offlineChip) {
      ui.setChip('offline', 'Offline — detection only');
      offlineChip = true;
    }
  } else {
    if (offlineChip) { ui.setChip('offline', null); offlineChip = false; }
    if (dets.length && !inFlight && now - lastCheck > cooldownMs) {
      lastCheck = now;
      verify(dets);               // fire-and-forget: the loop never awaits it
    }
  }

  fpsBuf.push(1000 / Math.max(performance.now() - t0, 1));
  if (fpsBuf.length > 30) fpsBuf.shift();
  ui.setFps(fpsBuf.reduce((a, b) => a + b, 0) / fpsBuf.length);
  if (!inFlight) ui.setStatus(dets.length ? `${dets.length} detection(s)` : 'watching…');

  requestAnimationFrame(loop);
}

// The Start button doubles as the retry affordance if the model fails to load,
// so a transient failure never leaves the app in a dead state.
let modelReady = false;

function loadModel() {
  els.startBtn.disabled = true;
  ui.setStatus('loading model…');
  detector.init()
    .then(() => {
      modelReady = true;
      els.startBtn.disabled = false;
      els.startBtn.textContent = 'Start camera';
      ui.setStatus('model ready — tap Start');
    })
    .catch((e) => {
      modelReady = false;
      els.startBtn.disabled = false;
      els.startBtn.textContent = 'Retry loading model';
      ui.setStatus('model load failed: ' + e.message);
      console.error(e);
    });
}

els.startBtn.addEventListener('click', () => {
  if (!modelReady) { loadModel(); return; }
  // iOS opens the speech audio session only for a speak() made during the
  // synchronous run of a tap handler. startCamera() awaits getUserMedia first,
  // so unlocking in there is already too late — the warnings then never play.
  speech.unlock();
  startCamera().catch((e) => {
    els.startBtn.disabled = false;
    els.startBtn.classList.remove('hidden');
    ui.setStatus('camera error: ' + e.message);
    if (e.name === 'NotAllowedError') {
      ui.setChip('camera', 'Camera blocked — allow it in Settings ▸ Safari ▸ Camera');
    }
  });
});

const muteBtn = document.getElementById('muteBtn');
muteBtn.addEventListener('click', () => {
  speech.setMuted(!speech.isMuted());
  muteBtn.textContent = speech.isMuted() ? '🔇' : '🔊';
});

/* ---- on-device diagnostics ----
 * A phone has no console. When a warning is not heard there is nothing to read
 * and nothing to compare, which is how "speaks in Safari, silent from the home
 * screen" stayed unexplained: the two are separate installs with separate
 * storage, and no way to see which code or which audio state either was in.
 * This reports both, and Test voice makes the check independent of whether a
 * hazard has happened to be confirmed yet. */
function refreshDiagnostics() {
  const d = speech.diagnostics();
  ui.setDiagnostics([
    `build      ${BUILD}`,
    `launched   ${d.mode}`,
    `speech     ${d.supported ? 'supported' : 'MISSING'}, ${d.unlocked ? 'unlocked' : 'NOT unlocked'}${d.muted ? ', muted' : ''}`,
    `voices     ${d.voices}`,
    `synth      speaking=${d.speaking} pending=${d.pending} paused=${d.paused}`,
    `audio      ${d.audioSession}`,
    `camera     ${running ? `running ${els.video.videoWidth}x${els.video.videoHeight}` : 'not started'}`,
    `last event ${d.lastEvent}`,
  ].join('\n'));
}

const testVoiceBtn = document.getElementById('testVoice');
testVoiceBtn.addEventListener('click', () => {
  // Inside the tap: iOS grants the audio session here and nowhere else.
  speech.testVoice();
  refreshDiagnostics();
  setTimeout(refreshDiagnostics, 1500);
});

settings.onOpen(refreshDiagnostics);

// A warning that is never heard looks identical to one that was never sent,
// so surface the reason on the phone rather than only in a console nobody has.
// It expires: it describes one warning, not a standing condition.
speech.onSpeechProblem((msg) => {
  ui.setChip('speech', msg, 12000);
  refreshDiagnostics();
});

function reflectKeyState(key) {
  ui.setChip('key', key ? null : 'Tap ⚙ to add your Gemini key');
}
settings.onChange(reflectKeyState);
reflectKeyState(settings.getKey());

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .catch((e) => console.warn('service worker registration failed', e));
  });
}

loadModel();
