/* ui.js — every DOM write lives here. No inference, no network. */

const els = {
  video: document.getElementById('video'),
  overlay: document.getElementById('overlay'),
  status: document.getElementById('status'),
  fps: document.getElementById('fps'),
  chip: document.getElementById('chip'),
  diag: document.getElementById('diag'),
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

/* ---- chip ----
 * There is one chip and several things that want to speak through it. Writing
 * to it directly meant whoever wrote last won, and a message with no owner
 * could never be taken back: a one-off speech failure sat there permanently,
 * having silently replaced the "add your key" prompt that was still true.
 * Each source now owns its own slot and the most urgent visible one shows. */
const CHIP_PRIORITY = ['camera', 'speech', 'offline', 'key'];
const chipText = new Map();
const chipTimers = new Map();

export function setChip(source, text, ttlMs = 0) {
  clearTimeout(chipTimers.get(source));
  chipTimers.delete(source);
  if (text) {
    chipText.set(source, text);
    // transient problems clear themselves; standing conditions do not
    if (ttlMs) chipTimers.set(source, setTimeout(() => setChip(source, null), ttlMs));
  } else {
    chipText.delete(source);
  }
  for (const s of CHIP_PRIORITY) {
    if (chipText.has(s)) {
      els.chip.textContent = chipText.get(s);
      els.chip.classList.remove('hidden');
      return;
    }
  }
  els.chip.classList.add('hidden');
}

export function setDiagnostics(text) {
  if (els.diag) els.diag.textContent = text;
}

/* ---- banner ---- */
const DANGER_ACCENT = { high: '#ff3b30', medium: '#ff8c00', low: '#34c759' };
const NOT_CONFIRMED_ACCENT = '#8e8e93';
const STALE_AFTER_MS = 30000;

const bannerEls = {
  banner: document.getElementById('banner'),
  head: document.getElementById('banner-head'),
  warn: document.getElementById('banner-warn'),
};
let staleTimer = null;

export function showBanner(verdict) {
  const confirmed = verdict.confirmed === true;
  const danger = String(verdict.danger_level || '').toLowerCase();
  const accent = confirmed ? (DANGER_ACCENT[danger] || '#ff8c00') : NOT_CONFIRMED_ACCENT;
  const cls = String(verdict.detected_class || '?').toUpperCase();

  bannerEls.banner.style.setProperty('--accent', accent);
  bannerEls.head.textContent = confirmed
    ? `${cls}  ·  ${(danger || '?').toUpperCase()} DANGER`
    : `${cls}  ·  NOT CONFIRMED`;
  bannerEls.warn.textContent = verdict.warning || '';
  bannerEls.banner.classList.remove('hidden', 'stale');

  // a stale verdict must never read as a live one
  clearTimeout(staleTimer);
  staleTimer = setTimeout(markBannerStale, STALE_AFTER_MS);
}

export function markBannerStale() { bannerEls.banner.classList.add('stale'); }

export function showBannerMessage(text, accent = NOT_CONFIRMED_ACCENT) {
  bannerEls.banner.style.setProperty('--accent', accent);
  bannerEls.head.textContent = 'GEMINI';
  bannerEls.warn.textContent = text;
  bannerEls.banner.classList.remove('hidden', 'stale');
  clearTimeout(staleTimer);
  staleTimer = setTimeout(markBannerStale, STALE_AFTER_MS);
}
