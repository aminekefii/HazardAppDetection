/* main.js — orchestration only: camera, render loop, state.
 * Verification (Gemini) is wired in Task 5. */
import * as detector from './detector.js';
import * as ui from './ui.js';

const els = {
  video: document.getElementById('video'),
  overlay: document.getElementById('overlay'),
  startBtn: document.getElementById('startBtn'),
};

let running = false;
const fpsBuf = [];

// iOS reports videoWidth as 0 until metadata arrives; sizing canvases before
// that yields a 0x0 overlay and an empty snapshot. Always wait.
function waitForMetadata(video) {
  if (video.readyState >= 1 && video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
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
  ui.initCanvas();
  els.startBtn.classList.add('hidden');
  running = true;
  requestAnimationFrame(loop);
}

async function loop() {
  if (!running) return;
  const t0 = performance.now();

  const dets = await detector.detect(els.video, els.video.videoWidth, els.video.videoHeight);
  ui.drawBoxes(dets);

  fpsBuf.push(1000 / Math.max(performance.now() - t0, 1));
  if (fpsBuf.length > 30) fpsBuf.shift();
  ui.setFps(fpsBuf.reduce((a, b) => a + b, 0) / fpsBuf.length);
  ui.setStatus(dets.length ? `${dets.length} detection(s)` : 'watching…');

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
  startCamera().catch((e) => {
    els.startBtn.disabled = false;
    ui.setStatus('camera error: ' + e.message);
    if (e.name === 'NotAllowedError') {
      ui.showChip('Camera blocked — allow it in Settings ▸ Safari ▸ Camera');
    }
  });
});

loadModel();
