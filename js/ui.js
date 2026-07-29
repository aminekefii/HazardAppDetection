/* ui.js — every DOM write lives here. No inference, no network. */

const els = {
  video: document.getElementById('video'),
  overlay: document.getElementById('overlay'),
  status: document.getElementById('status'),
  fps: document.getElementById('fps'),
  chip: document.getElementById('chip'),
};

const BOX_COLOR = '#44e0ff';
let ctx = null;

export function initCanvas() {
  els.overlay.width = els.video.videoWidth;
  els.overlay.height = els.video.videoHeight;
  ctx = els.overlay.getContext('2d');
}

export function drawBoxes(dets) {
  if (!ctx) return;
  const W = els.overlay.width, H = els.overlay.height;
  ctx.clearRect(0, 0, W, H);
  ctx.lineWidth = Math.max(2, W / 320);
  ctx.strokeStyle = BOX_COLOR;
  ctx.fillStyle = BOX_COLOR;
  ctx.font = `${Math.max(14, W / 40)}px system-ui, sans-serif`;
  for (const d of dets) {
    const [x1, y1, x2, y2] = d.box;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.fillText(`${d.name} ${Math.round(d.conf * 100)}%`, x1 + 4, Math.max(y1 - 6, 16));
  }
}

export function setStatus(text) { els.status.textContent = text; }
export function setFps(n) { els.fps.textContent = n ? `${n.toFixed(1)} FPS` : ''; }

export function showChip(text) {
  if (!text) { els.chip.classList.add('hidden'); return; }
  els.chip.textContent = text;
  els.chip.classList.remove('hidden');
}
