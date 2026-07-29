/* detector.js — on-device YOLO via ONNX Runtime Web.
 * Owns every pixel/tensor transform. Returns boxes in SOURCE pixel coordinates,
 * so no consumer ever needs to know a letterbox happened.
 * Model output is [1, 4+nc, 8400]. */

const CONF_TH = 0.5;
const IOU_TH = 0.45;
const MAX_DETS = 100;

let session = null;
let NAMES = [];
let IMGSZ = 640;

const lb = document.createElement('canvas');
const lbCtx = lb.getContext('2d', { willReadFrequently: true });

export async function init(modelUrl = 'model/best.onnx', labelsUrl = 'model/labels.json') {
  const meta = await fetch(labelsUrl).then((r) => r.json());
  NAMES = meta.names;
  IMGSZ = meta.imgsz || 640;
  lb.width = IMGSZ;
  lb.height = IMGSZ;

  ort.env.wasm.wasmPaths = new URL('../vendor/', import.meta.url).href;
  ort.env.wasm.numThreads = 1;           // no COOP/COEP on GitHub Pages
  const providers = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
  try {
    session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: providers, graphOptimizationLevel: 'all',
    });
  } catch (e) {
    console.warn('preferred providers failed, falling back to wasm', e);
    session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
  }
  return { names: NAMES, imgsz: IMGSZ };
}

export function names() { return NAMES; }

// Draw the source into the IMGSZ square, preserving aspect. Returns the mapping
// needed to convert model-space boxes back to source pixels.
function letterbox(source, sw, sh) {
  const r = Math.min(IMGSZ / sw, IMGSZ / sh);
  const nw = Math.round(sw * r), nh = Math.round(sh * r);
  const padX = Math.floor((IMGSZ - nw) / 2), padY = Math.floor((IMGSZ - nh) / 2);
  lbCtx.fillStyle = 'rgb(114,114,114)';
  lbCtx.fillRect(0, 0, IMGSZ, IMGSZ);
  lbCtx.drawImage(source, padX, padY, nw, nh);
  return { r, padX, padY };
}

function toTensor() {
  const { data } = lbCtx.getImageData(0, 0, IMGSZ, IMGSZ);  // RGBA
  const n = IMGSZ * IMGSZ;
  const chw = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    chw[i]         = data[i * 4]     / 255;
    chw[n + i]     = data[i * 4 + 1] / 255;
    chw[2 * n + i] = data[i * 4 + 2] / 255;
  }
  return new ort.Tensor('float32', chw, [1, 3, IMGSZ, IMGSZ]);
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter + 1e-6);
}

function decode(output, dims, map) {
  const nc = dims[1] - 4;
  const N = dims[2];
  const cand = [];
  for (let i = 0; i < N; i++) {
    let best = 0, bestK = 0;
    for (let k = 0; k < nc; k++) {
      const s = output[(4 + k) * N + i];
      if (s > best) { best = s; bestK = k; }
    }
    if (best < CONF_TH) continue;
    const cx = output[i], cy = output[N + i], w = output[2 * N + i], h = output[3 * N + i];
    cand.push({ box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], cls: bestK, conf: best });
  }
  cand.sort((a, b) => b.conf - a.conf);

  const keep = [];
  for (const c of cand) {
    if (keep.some((k) => k.cls === c.cls && iou(k.box, c.box) > IOU_TH)) continue;
    keep.push(c);
    if (keep.length >= MAX_DETS) break;
  }

  // model space -> source pixels
  return keep.map((d) => ({
    cls: d.cls,
    name: NAMES[d.cls],
    conf: d.conf,
    box: [
      (d.box[0] - map.padX) / map.r,
      (d.box[1] - map.padY) / map.r,
      (d.box[2] - map.padX) / map.r,
      (d.box[3] - map.padY) / map.r,
    ],
  }));
}

export async function detect(source, sw, sh) {
  if (!session) throw new Error('detector.init() has not been called');
  const map = letterbox(source, sw, sh);
  const tensor = toTensor();
  const out = await session.run({ [session.inputNames[0]]: tensor });
  const o = out[session.outputNames[0]];
  return decode(o.data, o.dims, map);
}
