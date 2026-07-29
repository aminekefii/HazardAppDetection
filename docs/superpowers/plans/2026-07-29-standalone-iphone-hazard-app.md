# Standalone iPhone Hazard Detector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hazard-detection web app that installs to an iPhone home screen, runs the 29-class YOLO model on the phone's own processor, and calls Gemini directly from the phone to confirm hazards and speak a warning aloud — with no server of the user's running anywhere.

**Architecture:** Plain ES modules, no build step. `detector.js` owns ONNX inference and returns boxes in video-pixel coordinates; `gemini.js` owns the REST call; `ui.js` owns all DOM drawing; `main.js` wires them together and owns the render loop and cooldown state. ONNX Runtime Web is vendored (not CDN) so the app boots offline. The API key is pasted once by the user and stored in `localStorage`, never in source or git.

**Tech Stack:** ONNX Runtime Web 1.20.1 (vendored), Web Speech API, Service Worker + Cache API, Gemini `gemini-2.5-flash` REST API, GitHub Pages hosting. Python 3.14 + ultralytics 8.4.60 for the one-time ONNX export and the parity reference.

**Spec:** `docs/superpowers/specs/2026-07-29-standalone-iphone-hazard-app-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **No build step.** Plain ES modules loaded with `<script type="module">`. No bundler, no `node_modules` in the shipped app, no transpilation.
- **ORT is vendored, including its `.wasm` binaries**, into `vendor/`. Never load ORT from a CDN. Always set `ort.env.wasm.wasmPaths = 'vendor/'`.
- **`ort.env.wasm.numThreads = 1`.** GitHub Pages cannot send COOP/COEP headers, so `SharedArrayBuffer` is unavailable and any higher value silently collapses to 1.
- **Cooldown is exactly 8000 ms and must never go below 3500 ms.** The key is on the Gemini free tier: 20 requests/minute. 8s yields 7.5/min.
- **The Gemini prompt string is copied verbatim** from `Model-v4.2/detect_and_verify.py` `PROMPT_TEMPLATE`. Do not reword it — verdicts must stay comparable to the desktop results.
- **Detection thresholds:** `CONF_TH = 0.5`, `IOU_TH = 0.45`. NMS is class-wise.
- **Danger colours:** high `#ff3b30`, medium `#ff8c00`, low `#34c759`, not-confirmed `#8e8e93`.
- **Gemini model id:** `gemini-2.5-flash` (`gemini-2.0-flash` has no quota on this key).
- **The API key is never written to any file in the repo.** It lives only in `localStorage` on the device.
- **Always `await` the video's `loadedmetadata` before sizing any canvas** from `videoWidth`/`videoHeight`.
- **29 classes**, ids in the order given by `model/labels.json`.
- Repo root is `C:\Users\amine\Desktop\Model-Prog\HazardApp-iphone`. All paths below are relative to it.

## File Structure

| File | Responsibility |
|---|---|
| `index.html` | App shell — video, overlay canvas, top bar, banner, settings sheet, Start button |
| `css/style.css` | Layout, danger colours, iOS safe-area insets, banner fade |
| `js/detector.js` | ONNX session; letterbox → tensor → run → decode → NMS; returns video-pixel boxes |
| `js/gemini.js` | Prompt template, REST call, response parsing, typed error classes |
| `js/speech.js` | iOS audio unlock, speak, mute toggle |
| `js/settings.js` | Key persistence in `localStorage`, settings sheet open/close |
| `js/ui.js` | Draws boxes, banner (+30s fade), status chip, FPS |
| `js/main.js` | Orchestration: camera, rAF loop, cooldown, verification trigger, error routing |
| `sw.js` | Service worker — cache-first for shell + model |
| `manifest.json` | PWA metadata for Add to Home Screen |
| `vendor/` | `ort.min.js` + ORT `.wasm`/`.mjs` binaries |
| `model/best.onnx`, `model/labels.json` | The model and its class names |
| `tools/export_onnx.py` | Re-export from `best.pt` (dev only) |
| `tools/parity/` | Two sample images, `make_expected.py`, `expected.json`, `parity.html` (dev only) |
| `tools/cors-check.html` | Task 1 spike, kept as a diagnostic |

---

### Task 1: Prove the browser can call Gemini directly (CORS spike)

Nothing else in this plan matters until this passes. If Gemini rejects cross-origin browser requests, the entire serverless design is void and we fall back to the options in spec §6.2.

**Files:**
- Create: `tools/cors-check.html`

- [ ] **Step 1: Write the spike page**

Create `tools/cors-check.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>Gemini CORS check</title>
<body style="font-family:system-ui;padding:16px;max-width:600px">
<h3>Gemini CORS check</h3>
<p>Proves a browser page can call the Gemini REST API directly, with no server.</p>
<input id="key" type="password" placeholder="paste Gemini API key" style="width:100%;padding:8px">
<input id="file" type="file" accept="image/*" style="margin:8px 0">
<button id="go" style="padding:8px 16px">Send to Gemini</button>
<pre id="out" style="white-space:pre-wrap;background:#f4f4f4;padding:12px;margin-top:12px"></pre>
<script>
const out = document.getElementById('out');
document.getElementById('go').onclick = async () => {
  const key = document.getElementById('key').value.trim();
  const file = document.getElementById('file').files[0];
  if (!key || !file) { out.textContent = 'Need a key and an image.'; return; }
  out.textContent = 'calling…';
  const b64 = await new Promise(res => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result.split(',')[1]);
    fr.readAsDataURL(file);
  });
  const t0 = performance.now();
  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [
            { inline_data: { mime_type: file.type || 'image/jpeg', data: b64 } },
            { text: 'Reply ONLY with JSON: {"seen":"<one word for the main object>"}' }
          ]}],
          generationConfig: { response_mime_type: 'application/json' }
        }) });
    const body = await r.text();
    out.textContent = `HTTP ${r.status} in ${Math.round(performance.now()-t0)} ms\n\n${body}`;
  } catch (e) {
    out.textContent = 'FETCH FAILED (likely CORS):\n' + e;
  }
};
</script>
</body>
```

- [ ] **Step 2: Serve it and open it**

```bash
cd /c/Users/amine/Desktop/Model-Prog/HazardApp-iphone
python -m http.server 8000
```

Open `http://localhost:8000/tools/cors-check.html` in Chrome. Open DevTools ▸ Console and Network before clicking.

- [ ] **Step 3: Run the check**

Paste the key from `Model-v4.2/.env` (`GEMINI_API_KEY=`), choose any photo, click **Send to Gemini**.

Expected: `HTTP 200` and a JSON body containing `"seen"`. The Network tab shows the request with no CORS error.

**Decision gate:**
- `HTTP 200` → the design holds. Continue to Task 2.
- Console shows `blocked by CORS policy` or `FETCH FAILED` → **stop and report.** Do not continue. Fall back per spec §6.2, in order: the official `@google/generative-ai` browser SDK, then a Cloudflare Worker proxy.
- `HTTP 429` → quota, not CORS. Wait 60 seconds and retry; a 429 still proves CORS works, because the response reached the page.

- [ ] **Step 4: Commit**

```bash
git add tools/cors-check.html
git commit -m "test: add Gemini CORS spike page

Proves a browser can call the Gemini REST API directly with no backend.
Kept as a diagnostic for key/quota problems."
```

---

### Task 2: Scaffold + vendored ONNX Runtime + model files

**Deliverable:** a page that creates an ONNX session from the local model with no network access, and prints the model's real input/output names and dimensions.

**Files:**
- Create: `vendor/` (ORT dist files), `model/best.onnx`, `model/labels.json`, `tools/export_onnx.py`, `index.html`, `css/style.css`, `.gitattributes`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `model/labels.json` shaped `{ "imgsz": 640, "names": [ ...29 strings... ] }`, consumed by Task 3.

- [ ] **Step 1: Copy the model source and the export script**

```bash
cd /c/Users/amine/Desktop/Model-Prog/HazardApp-iphone
mkdir -p model tools vendor js css
cp ../Model-v4.2/best.pt ./best.pt
cp ../Model-v4.2-mobile/export_onnx.py tools/export_onnx.py
```

- [ ] **Step 2: Point the export script at the new layout**

In `tools/export_onnx.py`, the script resolves paths from its own directory. Change the two path lines so it reads `best.pt` from the repo root and writes into `model/`:

Replace:
```python
HERE = os.path.dirname(os.path.abspath(__file__))
```
with:
```python
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # repo root: best.pt lives here
```

Replace `default=os.path.join(HERE, "best.pt")` with `default=os.path.join(ROOT, "best.pt")`.

Replace:
```python
    web = os.path.join(HERE, "web")
    os.makedirs(web, exist_ok=True)
    dst = os.path.join(web, "best.onnx")
```
with:
```python
    web = os.path.join(ROOT, "model")
    os.makedirs(web, exist_ok=True)
    dst = os.path.join(web, "best.onnx")
```

And change the two later references from `os.path.join(web, "labels.json")` — that path already uses `web`, so it now correctly writes `model/labels.json`. Update the final print string from `web/labels.json` to `model/labels.json`.

- [ ] **Step 3: Export the model**

```bash
python tools/export_onnx.py
```

Expected: prints `exported: …best.onnx`, `copied -> …model\best.onnx`, and `wrote model/labels.json (29 classes, imgsz 640)`.

Verify:
```bash
ls -la model/
python -c "import json;m=json.load(open('model/labels.json'));print(m['imgsz'],len(m['names']),m['names'][:3],m['names'][-1])"
```
Expected: `best.onnx` around 36 MB, and `640 29 ['batteries', 'cigarettes', 'coin'] electrical_panel`.

- [ ] **Step 4: Vendor ONNX Runtime Web including its wasm binaries**

The `.wasm` filenames differ between ORT releases, so copy whatever the package actually ships rather than guessing names.

```bash
cd /c/Users/amine/AppData/Local/Temp/claude
mkdir -p ortpull && cd ortpull
npm install onnxruntime-web@1.20.1 --no-save --silent
cd /c/Users/amine/Desktop/Model-Prog/HazardApp-iphone
DIST=/c/Users/amine/AppData/Local/Temp/claude/ortpull/node_modules/onnxruntime-web/dist
cp "$DIST/ort.min.js" vendor/
cp "$DIST"/ort-wasm-simd-threaded*.wasm vendor/
cp "$DIST"/ort-wasm-simd-threaded*.mjs vendor/
ls -la vendor/
```

Copy **only** the runtime-reachable artifacts. `index.html` loads `vendor/ort.min.js` as a classic script, and that bundle dynamically loads the `ort-wasm-simd-threaded.*` pair. A blanket `cp dist/*.mjs` drags in ~18 MB of unreachable build variants (`ort.all.*`, `ort.webgl.*`, `ort.node.*`, ESM duplicates) permanently into the history of a public repo.

Expected: exactly five files — `ort.min.js`, `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm`, `ort-wasm-simd-threaded.jsep.mjs`, `ort-wasm-simd-threaded.jsep.wasm`. If `vendor/` has no `.wasm` file, stop — the app cannot run offline without it.

Keep **both** `.jsep.*` files. JSEP is the WebGPU execution path, and `detector.js` requests the `webgpu` provider whenever `navigator.gpu` exists — precisely the iOS 18+ target. Deleting them silently forces the phone onto the slower WASM path.

- [ ] **Step 5: Keep large binaries sane in git**

Overwrite `.gitignore`:

```gitignore
# local only — the phone needs best.onnx, not best.pt
best.pt

# OS junk
Thumbs.db
desktop.ini
.DS_Store

# scratch
node_modules/
```

Create `.gitattributes` so git does not mangle binaries:

```gitattributes
*.onnx binary
*.wasm binary
*.jpg binary
*.png binary
```

- [ ] **Step 6: Write the app shell**

Create `index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <title>Hazard Detector</title>
  <link rel="manifest" href="manifest.json" />
  <link rel="stylesheet" href="css/style.css" />
</head>
<body>
  <div id="stage">
    <video id="video" playsinline muted autoplay></video>
    <canvas id="overlay"></canvas>

    <div id="topbar">
      <span id="status">loading model…</span>
      <span id="right">
        <span id="fps"></span>
        <button id="muteBtn" title="Mute spoken warnings">🔊</button>
        <button id="gearBtn" title="Settings">⚙</button>
      </span>
    </div>

    <div id="chip" class="hidden"></div>

    <div id="banner" class="hidden">
      <div id="banner-head"></div>
      <div id="banner-warn"></div>
    </div>

    <button id="startBtn">Start camera</button>

    <div id="sheet" class="hidden">
      <h2>Gemini API key</h2>
      <p>Stored only on this device. Never uploaded, never in the app's source.</p>
      <input id="keyInput" type="password" placeholder="paste your key" autocomplete="off" />
      <div class="row">
        <button id="saveKey">Save</button>
        <button id="clearKey" class="ghost">Remove</button>
        <button id="closeSheet" class="ghost">Close</button>
      </div>
      <p id="sheetMsg"></p>
    </div>
  </div>

  <script src="vendor/ort.min.js"></script>
  <script type="module" src="js/main.js"></script>
</body>
</html>
```

- [ ] **Step 7: Write the stylesheet**

Create `css/style.css`:

```css
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: #000; color: #fff;
  font-family: -apple-system, system-ui, sans-serif; overscroll-behavior: none; }
#stage { position: relative; width: 100vw; height: 100dvh; overflow: hidden; }
#video, #overlay { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
#video { background: #111; }

#topbar { position: absolute; top: env(safe-area-inset-top, 0); left: 0; right: 0;
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 10px 12px; font-size: 13px; text-shadow: 0 1px 3px #000; z-index: 3; }
#right { display: flex; align-items: center; gap: 8px; }
#topbar button { background: rgba(0,0,0,.45); color: #fff; border: 0; border-radius: 8px;
  font-size: 16px; padding: 4px 8px; }

#chip { position: absolute; top: calc(env(safe-area-inset-top, 0) + 44px); left: 12px;
  background: rgba(0,0,0,.6); border: 1px solid #ff8c00; color: #ffd9a0;
  padding: 6px 10px; border-radius: 999px; font-size: 12px; z-index: 3; }

#startBtn { position: absolute; left: 50%; bottom: 12%; transform: translateX(-50%);
  padding: 14px 28px; font-size: 17px; border: 0; border-radius: 999px;
  background: #fff; color: #000; z-index: 4; }

#banner { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3;
  padding: 12px 14px calc(12px + env(safe-area-inset-bottom, 0));
  background: rgba(20,20,20,.82); border-top: 4px solid var(--accent, #8e8e93);
  transition: opacity .6s ease, filter .6s ease; }
#banner.stale { opacity: .45; filter: grayscale(.6); }
#banner-head { font-weight: 700; font-size: 14px; letter-spacing: .04em; color: var(--accent, #8e8e93); }
#banner-warn { margin-top: 4px; font-size: 15px; line-height: 1.35; }

#sheet { position: absolute; inset: auto 0 0 0; z-index: 5; background: #1c1c1e;
  padding: 18px 16px calc(18px + env(safe-area-inset-bottom, 0));
  border-radius: 16px 16px 0 0; }
#sheet h2 { margin: 0 0 6px; font-size: 17px; }
#sheet p { margin: 0 0 10px; font-size: 13px; color: #9a9a9e; }
#keyInput { width: 100%; padding: 12px; font-size: 16px; border-radius: 10px;
  border: 1px solid #3a3a3c; background: #2c2c2e; color: #fff; }
#sheet .row { display: flex; gap: 8px; margin-top: 12px; }
#sheet button { flex: 1; padding: 12px; font-size: 15px; border: 0; border-radius: 10px;
  background: #0a84ff; color: #fff; }
#sheet button.ghost { background: #3a3a3c; }
.hidden { display: none !important; }
```

- [ ] **Step 8: Write a temporary probe to prove the session creates**

Create `js/main.js` with a probe-only body (it is replaced in Task 4):

```js
// Temporary probe — replaced in Task 4.
const status = document.getElementById('status');

async function probe() {
  const meta = await fetch('model/labels.json').then(r => r.json());
  ort.env.wasm.wasmPaths = 'vendor/';
  ort.env.wasm.numThreads = 1;             // GitHub Pages has no COOP/COEP
  const providers = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
  const t0 = performance.now();
  const session = await ort.InferenceSession.create('model/best.onnx', {
    executionProviders: providers, graphOptimizationLevel: 'all',
  });
  const dt = Math.round(performance.now() - t0);
  const dummy = new ort.Tensor('float32', new Float32Array(3 * meta.imgsz * meta.imgsz),
                               [1, 3, meta.imgsz, meta.imgsz]);
  const out = await session.run({ [session.inputNames[0]]: dummy });
  const o = out[session.outputNames[0]];
  status.textContent =
    `OK in ${dt}ms | in=${session.inputNames} out=${session.outputNames} ` +
    `dims=[${o.dims}] classes=${meta.names.length}`;
  console.log('providers tried', providers, 'output dims', o.dims);
}

probe().catch(e => { status.textContent = 'FAILED: ' + e.message; console.error(e); });
```

- [ ] **Step 9: Run it**

```bash
python -m http.server 8000
```

Open `http://localhost:8000/` in Chrome.

Expected in the top bar: `OK in <n>ms | in=images out=output0 dims=[1,33,8400] classes=29`.

`33` must equal `4 + 29`. If it is not 33, the wrong `best.pt` was exported — stop and re-check Step 3.

- [ ] **Step 10: Prove it works with no network**

In DevTools ▸ Network, set throttling to **Offline**, then hard-reload. The session must still create (files come from disk, not a CDN). If it fails, a `.wasm` file is missing from `vendor/` or `wasmPaths` is wrong.

- [ ] **Step 11: Commit**

```bash
git add .gitignore .gitattributes index.html css/style.css js/main.js model/ vendor/ tools/export_onnx.py
git commit -m "feat: scaffold app shell with vendored ONNX Runtime and 29-class model

ORT and its wasm binaries are vendored so the app boots with no network.
numThreads pinned to 1 because GitHub Pages cannot send COOP/COEP."
```

---

### Task 3: `detector.js` + parity harness against Python

The riskiest code in the project. A wrong tensor index or letterbox offset produces boxes that look *almost* right. The parity harness is written **first** and must fail before `detector.js` exists.

**Files:**
- Create: `tools/parity/make_expected.py`, `tools/parity/parity.html`, `tools/parity/a.jpg`, `tools/parity/b.jpg`, `tools/parity/expected.json`, `js/detector.js`

**Interfaces:**
- Consumes: `model/labels.json`, `model/best.onnx` from Task 2.
- Produces:
  - `init(modelUrl?, labelsUrl?) -> Promise<{names: string[], imgsz: number}>`
  - `detect(source: CanvasImageSource, sw: number, sh: number) -> Promise<Array<{cls:number, name:string, conf:number, box:[x1,y1,x2,y2]}>>` — **box coordinates are in source pixels**, not letterboxed 640-space.
  - `names() -> string[]`

- [ ] **Step 1: Take two sample images**

```bash
cd /c/Users/amine/Desktop/Model-Prog/HazardApp-iphone
mkdir -p tools/parity
cp "$(ls ../Model-v4.2/test_images/07_scissors/* | head -1)" tools/parity/a.jpg
cp "$(ls ../Model-v4.2/test_images/00_batteries/* | head -1)" tools/parity/b.jpg
ls -la tools/parity/
```

These two files are the only image data in the repo. They are dev-only and never cached by the service worker.

- [ ] **Step 2: Write the Python reference generator**

Create `tools/parity/make_expected.py`. It runs **the ONNX model** through ultralytics — not `best.pt` — so the reference uses the same fixed 640×640 square input the browser uses.

```python
"""Generate the expected detections for the JS parity check.

Runs model/best.onnx through ultralytics (which handles the fixed 640x640 square
letterbox the ONNX export bakes in) and records boxes in ORIGINAL image pixels.
js/detector.js must reproduce these numbers in the browser.
"""
import os, json
from ultralytics import YOLO

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
CONF = 0.5

model = YOLO(os.path.join(ROOT, "model", "best.onnx"), task="detect")
names = {i: n.lstrip("\ufeff") for i, n in model.names.items()}

out = {}
for img in ("a.jpg", "b.jpg"):
    res = model(os.path.join(HERE, img), verbose=False, conf=CONF)[0]
    dets = []
    for b in res.boxes:
        x1, y1, x2, y2 = (round(v, 1) for v in b.xyxy[0].tolist())
        cls = int(b.cls.item())
        dets.append({"cls": cls, "name": names[cls],
                     "conf": round(b.conf.item(), 3),
                     "box": [x1, y1, x2, y2]})
    dets.sort(key=lambda d: -d["conf"])
    out[img] = {"w": res.orig_shape[1], "h": res.orig_shape[0], "dets": dets}
    print(f"{img}: {len(dets)} detections -> " +
          ", ".join(f"{d['name']} {d['conf']}" for d in dets))

with open(os.path.join(HERE, "expected.json"), "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=2)
print("wrote expected.json")
```

- [ ] **Step 3: Generate the reference**

```bash
python tools/parity/make_expected.py
cat tools/parity/expected.json
```

Expected: each image reports at least one detection (`a.jpg` should find `scissors`, `b.jpg` should find `batteries`). If either finds zero detections at conf 0.5, swap in a different sample image and regenerate — the harness is useless with an empty reference.

- [ ] **Step 4: Write the parity page (the failing test)**

Create `tools/parity/parity.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>detector.js parity check</title>
<body style="font-family:system-ui;padding:16px;background:#111;color:#eee">
<h3>detector.js vs Python parity</h3>
<pre id="out" style="white-space:pre-wrap;font-size:13px"></pre>
<script src="../../vendor/ort.min.js"></script>
<script type="module">
import * as detector from '../../js/detector.js';

const TOL_BOX = 5.0;    // px, fp32 differences between runtimes
const TOL_CONF = 0.05;
const out = document.getElementById('out');
const log = (s) => { out.textContent += s + '\n'; };

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = src;
  });
}

(async () => {
  const expected = await fetch('expected.json').then(r => r.json());
  await detector.init('../../model/best.onnx', '../../model/labels.json');
  let failures = 0;

  for (const [file, ref] of Object.entries(expected)) {
    const im = await loadImage(file);
    const got = await detector.detect(im, im.naturalWidth, im.naturalHeight);
    log(`\n=== ${file} (${im.naturalWidth}x${im.naturalHeight}) ===`);
    log(`python: ${ref.dets.length} dets | js: ${got.length} dets`);

    if (got.length !== ref.dets.length) { failures++; log('  FAIL: detection count differs'); }

    const n = Math.min(got.length, ref.dets.length);
    for (let i = 0; i < n; i++) {
      const e = ref.dets[i], g = got[i];
      const dBox = e.box.map((v, k) => Math.abs(v - g.box[k]));
      const dConf = Math.abs(e.conf - g.conf);
      const ok = g.cls === e.cls && dConf <= TOL_CONF && dBox.every(d => d <= TOL_BOX);
      if (!ok) failures++;
      log(`  ${ok ? 'PASS' : 'FAIL'} #${i} py=${e.name} ${e.conf} [${e.box}]`);
      log(`         js=${g.name} ${g.conf.toFixed(3)} [${g.box.map(v => v.toFixed(1))}]`);
      log(`         dconf=${dConf.toFixed(4)} dbox=[${dBox.map(v => v.toFixed(1))}]`);
    }
  }
  log(`\n${failures === 0 ? '*** PARITY PASS ***' : `*** PARITY FAIL (${failures}) ***`}`);
})().catch(e => { log('ERROR: ' + e.message); console.error(e); });
</script>
</body>
```

- [ ] **Step 5: Run it and confirm it fails**

With `python -m http.server 8000` running, open `http://localhost:8000/tools/parity/parity.html`.

Expected: `ERROR: Failed to fetch dynamically imported module … js/detector.js` — the module does not exist yet. This confirms the harness actually exercises the code under test.

- [ ] **Step 6: Implement `detector.js`**

Create `js/detector.js`:

```js
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
```

- [ ] **Step 7: Run the parity check and confirm it passes**

Reload `http://localhost:8000/tools/parity/parity.html`.

Expected: every line `PASS`, ending in `*** PARITY PASS ***`.

If boxes are offset by a constant → the `padX`/`padY` un-mapping is wrong. If classes are shifted by one → the `4 + k` offset is wrong. If confidences are wildly low → the RGB channel order or the `/255` scaling is wrong. Fix `detector.js` and re-run until it passes; do not proceed with failures.

- [ ] **Step 8: Commit**

```bash
git add js/detector.js tools/parity/
git commit -m "feat: add detector.js with Python parity harness

Boxes are returned in source-pixel coordinates so consumers never see the
letterbox. Parity page compares JS output against ultralytics running the
same ONNX file; both sample images match within 5px / 0.05 conf."
```

---

### Task 4: Camera + live boxes

**Deliverable:** live webcam detection at a measured FPS on desktop Chrome, with the `loadedmetadata` fix that the old PWA lacked.

**Files:**
- Create: `js/ui.js`
- Modify: `js/main.js` (replaces the Task 2 probe entirely)

**Interfaces:**
- Consumes: `detector.init`, `detector.detect` from Task 3.
- Produces:
  - `ui.initCanvas() -> void` (takes no arguments; it reads the `#video`/`#overlay` elements itself)
  - `ui.drawBoxes(dets) -> void`
  - `ui.setStatus(text) -> void`
  - `ui.setFps(n) -> void`
  - `ui.showChip(text|null) -> void`

- [ ] **Step 1: Write `ui.js` (boxes, status, FPS, chip)**

Create `js/ui.js`. The banner functions are added in Task 5.

```js
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
```

- [ ] **Step 2: Replace `main.js` with the real loop**

Overwrite `js/main.js`:

```js
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
```

- [ ] **Step 3: Run it on the desktop webcam**

Open `http://localhost:8000/` in Chrome, click **Start camera**, allow access, hold scissors or a battery to the webcam.

Expected: boxes track the object with correct labels; the FPS readout is non-zero and stable; the status line switches between `watching…` and `N detection(s)`.

- [ ] **Step 4: Verify the metadata fix**

In DevTools ▸ Console, immediately after clicking Start, run:

```js
document.getElementById('overlay').width
```

Expected: a non-zero value matching the camera width (e.g. `1280`). A `0` here means `waitForMetadata` was bypassed.

- [ ] **Step 5: Verify the model-load retry path**

```bash
mv model/best.onnx model/best.onnx.hidden
```

Reload the page. Expected: status reads `model load failed: …` and the button reads **Retry loading model**. Restore the file and click the button:

```bash
mv model/best.onnx.hidden model/best.onnx
```

Expected: clicking Retry loads the model without a page reload, and the button returns to **Start camera**.

- [ ] **Step 6: Commit**

```bash
git add js/main.js js/ui.js
git commit -m "feat: live camera detection with boxes and FPS

Waits for loadedmetadata before sizing canvases, fixing the 0x0 overlay
race present in Model-v4.2-mobile/web/app.js."
```

---

### Task 5: Gemini verification + banner + spoken warning

**Deliverable:** holding a hazard to the camera produces a colour-coded banner and a spoken sentence, at most once per 8 seconds.

For this task the key is read from `localStorage` directly; the settings UI arrives in Task 6. Set it once by hand in DevTools ▸ Console:
`localStorage.setItem('gemini_key', '<your key>')`

**Files:**
- Create: `js/gemini.js`, `js/speech.js`
- Modify: `js/ui.js` (add banner), `js/main.js` (add trigger)

**Interfaces:**
- Consumes: `ui.setStatus`, `ui.showChip` from Task 4.
- Produces:
  - `gemini.verify(jpegBlob, findingText, apiKey) -> Promise<{detected_class, confirmed, danger_level, warning}>`
  - `gemini.GeminiError` with `.kind` of `'auth' | 'quota' | 'network' | 'http'` and `.retryAfterMs` (number, 0 when unknown)
  - `speech.unlock()`, `speech.say(text)`, `speech.setMuted(bool)`, `speech.isMuted()`
  - `ui.showBanner(verdict)`, `ui.markBannerStale()`, `ui.showBannerMessage(text, accent?)`

- [ ] **Step 1: Write `gemini.js`**

Create `js/gemini.js`. The prompt is copied verbatim from `Model-v4.2/detect_and_verify.py`.

```js
/* gemini.js — the "double-check" call, straight from the phone. No backend.
 * Prompt copied verbatim from Model-v4.2/detect_and_verify.py so verdicts stay
 * comparable with the desktop results. */

const MODEL = 'gemini-2.5-flash';
const ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const PROMPT_TEMPLATE = `You are a safety assistant that double-checks an object detector.

An object detector flagged this image and reported: {yolo_finding}.

Look at the image yourself and respond ONLY with JSON in exactly this shape:
{
  "detected_class": "<the main hazard class the detector reported, echoed back>",
  "confirmed": <true if that hazard is really visible in the image, false if the detector was wrong>,
  "danger_level": "<one of: low, medium, high>",
  "warning": "<ONE short, natural sentence to be read ALOUD to warn a person nearby. Calm, clear, specific. Max ~15 words.>"
}

Rules:
- "confirmed" is your honest verdict on whether the detector was right. If you do NOT
  see that hazard, set it to false (this filters the detector's false positives).
- If confirmed is false, still write a warning field but keep it neutral (e.g. "No clear hazard detected.").
- The "warning" is spoken to a human, so make it sound natural, not robotic.
- If you can see WHO or WHAT is at risk (a child, a hand), mention it briefly.
- Do not add any text outside the JSON.
`;

export class GeminiError extends Error {
  constructor(kind, message, retryAfterMs = 0) {
    super(message);
    this.name = 'GeminiError';
    this.kind = kind;                 // 'auth' | 'quota' | 'network' | 'http'
    this.retryAfterMs = retryAfterMs;
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result.split(',')[1]);
    fr.onerror = () => reject(new Error('could not read frame'));
    fr.readAsDataURL(blob);
  });
}

export function buildPrompt(finding) {
  return PROMPT_TEMPLATE.replace('{yolo_finding}', finding);
}

export async function verify(jpegBlob, finding, apiKey) {
  const data = await blobToBase64(jpegBlob);

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: 'image/jpeg', data } },
          { text: buildPrompt(finding) },
        ]}],
        generationConfig: { response_mime_type: 'application/json' },
      }),
    });
  } catch (e) {
    throw new GeminiError('network', 'no connection to Gemini');
  }

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new GeminiError('auth', 'API key rejected');
    }
    if (res.status === 429) {
      // free tier is 20 req/min; the body carries "Please retry in 57.8s"
      const m = body.match(/retry in ([\d.]+)s/i);
      throw new GeminiError('quota', 'rate limited',
        m ? Math.ceil(parseFloat(m[1]) * 1000) : 60000);
    }
    throw new GeminiError('http', `Gemini HTTP ${res.status}`);
  }

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    // same degradation as the Python client
    return { detected_class: '?', confirmed: null, danger_level: '?',
             warning: text || '(Gemini returned no text)' };
  }
}
```

- [ ] **Step 2: Write `speech.js`**

Create `js/speech.js`:

```js
/* speech.js — reads the warning aloud.
 * iOS only permits speech synthesis after a user gesture, so unlock() must be
 * called from inside a real tap handler (the Start button). */

let muted = false;
let unlocked = false;

export function unlock() {
  if (unlocked || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance('');
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
```

- [ ] **Step 3: Add the banner to `ui.js`**

Append to `js/ui.js`:

```js
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
```

- [ ] **Step 4: Wire the trigger into `main.js`**

In `js/main.js`, add to the imports:

```js
import * as gemini from './gemini.js';
import * as speech from './speech.js';
```

Add module-level state below `const fpsBuf = [];`:

```js
const COOLDOWN_MS = 8000;        // 7.5 calls/min, inside the 20/min free tier
let cooldownMs = COOLDOWN_MS;    // temporarily raised after a 429
let lastCheck = 0;
let inFlight = false;
const snap = document.createElement('canvas');
```

In `startCamera()`, after `ui.initCanvas();` add:

```js
  snap.width = els.video.videoWidth;
  snap.height = els.video.videoHeight;
  speech.unlock();                // must happen inside the Start tap
```

Add the verification functions above `loop()`:

```js
function grabFrame() {
  snap.getContext('2d').drawImage(els.video, 0, 0, snap.width, snap.height);
  return new Promise((res) => snap.toBlob(res, 'image/jpeg', 0.85));
}

async function verify(dets) {
  const key = localStorage.getItem('gemini_key');
  if (!key) { ui.showChip('Tap ⚙ to add your Gemini key'); return; }

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
```

Inside `loop()`, immediately after `ui.drawBoxes(dets);`:

```js
  const now = performance.now();
  if (dets.length && !inFlight && now - lastCheck > cooldownMs && navigator.onLine) {
    lastCheck = now;
    verify(dets);                 // fire-and-forget: the loop never awaits it
  }
```

And change the status line so an in-flight check is not overwritten:

```js
  if (!inFlight) ui.setStatus(dets.length ? `${dets.length} detection(s)` : 'watching…');
```

- [ ] **Step 5: Add the mute button handler**

At the bottom of `js/main.js`:

```js
const muteBtn = document.getElementById('muteBtn');
muteBtn.addEventListener('click', () => {
  speech.setMuted(!speech.isMuted());
  muteBtn.textContent = speech.isMuted() ? '🔇' : '🔊';
});
```

- [ ] **Step 6: Test the happy path**

Set the key once in DevTools ▸ Console:
```js
localStorage.setItem('gemini_key', '<paste key>')
```
Reload, Start camera, hold scissors to the webcam.

Expected within ~10 seconds: status shows `Gemini: checking…`; a banner appears with an orange or red accent reading e.g. `SCISSORS · MEDIUM DANGER`; the warning sentence is **spoken aloud**; the console logs `[gemini] {…}`. Keep the object in view: a new verdict arrives roughly every 8 seconds, never more often.

- [ ] **Step 7: Test each failure path**

| Test | How | Expected |
|---|---|---|
| Bad key | `localStorage.setItem('gemini_key','bogus')`, reload | Banner: `API key rejected — tap ⚙ to fix it`; boxes keep drawing |
| No key | `localStorage.removeItem('gemini_key')`, reload | Chip: `Tap ⚙ to add your Gemini key`; no call attempted |
| Offline | DevTools ▸ Network ▸ Offline, hold a hazard up | Banner: `Offline — detection only`; boxes keep drawing; no crash |
| Mute | Tap 🔊 then hold a hazard up | Banner appears, nothing is spoken; icon reads 🔇 |
| Stale fade | Leave a banner on screen 30s | It dims and desaturates |

In every case the render loop must keep running. If detection stops, the error escaped the `try/catch`.

- [ ] **Step 8: Commit**

```bash
git add js/gemini.js js/speech.js js/ui.js js/main.js
git commit -m "feat: Gemini verification with spoken warnings and banner

Direct browser call, no backend. Typed errors drive the UI: 429 stretches
the cooldown to the API's own retry hint, auth and network failures never
stop the render loop."
```

---

### Task 6: Settings sheet + key persistence

**Deliverable:** the key can be pasted, saved, and removed from inside the app; a first-run user is guided to it.

**Files:**
- Create: `js/settings.js`
- Modify: `js/main.js`

**Interfaces:**
- Produces: `settings.getKey() -> string|null`, `settings.setKey(k)`, `settings.clearKey()`, `settings.open()`, `settings.close()`, `settings.onChange(cb)`
- Replaces every direct `localStorage.getItem('gemini_key')` call added in Task 5.

- [ ] **Step 1: Write `settings.js`**

Create `js/settings.js`:

```js
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

export function getKey() { return localStorage.getItem(KEY); }
export function onChange(cb) { listeners.push(cb); }
function fire() { for (const cb of listeners) cb(getKey()); }

export function setKey(k) { localStorage.setItem(KEY, k); fire(); }
export function clearKey() { localStorage.removeItem(KEY); fire(); }

export function open() {
  els.input.value = getKey() || '';
  els.msg.textContent = getKey() ? 'A key is saved on this device.' : '';
  els.sheet.classList.remove('hidden');
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
```

- [ ] **Step 2: Use it from `main.js`**

Add the import:
```js
import * as settings from './settings.js';
```

In `verify()`, replace:
```js
  const key = localStorage.getItem('gemini_key');
```
with:
```js
  const key = settings.getKey();
```

In the `'auth'` branch of the `catch`, after showing the banner, add:
```js
      settings.open();
```

At the bottom of `main.js`, add first-run guidance that updates live:

```js
function reflectKeyState(key) {
  ui.showChip(key ? null : 'Tap ⚙ to add your Gemini key');
}
settings.onChange(reflectKeyState);
reflectKeyState(settings.getKey());
```

- [ ] **Step 3: Test the full key lifecycle**

```js
localStorage.removeItem('gemini_key')
```
Reload. Then:

| Action | Expected |
|---|---|
| Load with no key | Chip visible: `Tap ⚙ to add your Gemini key` |
| Tap ⚙ | Sheet slides up, input empty |
| Type `short`, Save | `That does not look like a valid key.`, sheet stays open |
| Paste the real key, Save | `Saved on this device.`, sheet closes, **chip disappears immediately** |
| Hold a hazard up | Verification works |
| Tap ⚙ ▸ Remove | `Key removed from this device.`, chip returns |
| Reload the page | Key state persists as last set |

- [ ] **Step 4: Confirm the key is not in the repo**

```bash
git grep -inE "AIza[0-9A-Za-z_-]{30,}" -- . || echo "CLEAN: no API key in tracked files"
```

Expected: `CLEAN: no API key in tracked files`. If this prints a match, remove the key from that file before committing — it must never enter git history.

- [ ] **Step 5: Commit**

```bash
git add js/settings.js js/main.js
git commit -m "feat: in-app settings sheet for the Gemini key

Key is entered once per device and kept in localStorage, so it is never in
source or git and cannot be scanned and auto-revoked."
```

---

### Task 7: Service worker, manifest, offline boot

**Deliverable:** installed to the home screen, launching fullscreen, and detecting with the network fully off.

**Files:**
- Create: `manifest.json`, `sw.js`, `icons/icon-192.png`, `icons/icon-512.png`
- Modify: `js/main.js` (register the worker)

- [ ] **Step 1: Create the icons**

```bash
cd /c/Users/amine/Desktop/Model-Prog/HazardApp-iphone
mkdir -p icons
python - <<'PY'
from PIL import Image, ImageDraw
for size in (192, 512):
    im = Image.new("RGB", (size, size), "#111318")
    d = ImageDraw.Draw(im)
    pad, w = size // 8, max(2, size // 32)
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=size // 10,
                        outline="#44e0ff", width=w)
    d.ellipse([size * 0.42, size * 0.30, size * 0.58, size * 0.46], fill="#ff3b30")
    d.rectangle([size * 0.47, size * 0.52, size * 0.53, size * 0.72], fill="#ff3b30")
    im.save(f"icons/icon-{size}.png")
    print("wrote", f"icons/icon-{size}.png")
PY
```

If Pillow is missing: `pip install pillow` and re-run.

- [ ] **Step 2: Write `manifest.json`**

```json
{
  "name": "Hazard Detector",
  "short_name": "Hazards",
  "description": "On-device hazard detection with AI verification",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#000000",
  "theme_color": "#000000",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

- [ ] **Step 3: Write `sw.js`**

Create `sw.js` at the repo root. The model is cached separately from the shell so a code change does not force a 36 MB re-download.

```js
/* sw.js — cache-first so the app boots and detects with no network.
 * Bump SHELL_VERSION whenever any shell file changes.
 * MODEL_VERSION only changes when model/best.onnx is re-exported. */
const SHELL_VERSION = 'shell-v1';
const MODEL_VERSION = 'model-v1';

const SHELL = [
  './', './index.html', './manifest.json',
  './css/style.css',
  './js/main.js', './js/detector.js', './js/gemini.js',
  './js/speech.js', './js/settings.js', './js/ui.js',
  './vendor/ort.min.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

const MODEL = ['./model/best.onnx', './model/labels.json'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL_VERSION);
    await shell.addAll(SHELL);
    const model = await caches.open(MODEL_VERSION);
    await model.addAll(MODEL);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL_VERSION, MODEL_VERSION]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;              // never cache POSTs
  if (url.origin !== self.location.origin) return;     // never touch Gemini

  e.respondWith((async () => {
    const hit = await caches.match(e.request);
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      // ORT fetches its .wasm lazily — cache whatever else we end up needing
      if (res.ok && url.pathname.includes('/vendor/')) {
        (await caches.open(SHELL_VERSION)).put(e.request, res.clone());
      }
      return res;
    } catch (err) {
      if (e.request.mode === 'navigate') return caches.match('./index.html');
      throw err;
    }
  })());
});
```

- [ ] **Step 4: Register it from `main.js`**

Append to `js/main.js`:

```js
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .catch((e) => console.warn('service worker registration failed', e));
  });
}
```

- [ ] **Step 5: Verify caching on desktop**

Reload `http://localhost:8000/` twice (the first load installs the worker). Then DevTools ▸ Application ▸ Cache Storage.

Expected: a `shell-v1` cache with the HTML/CSS/JS/vendor entries, and a `model-v1` cache containing `best.onnx`.

- [ ] **Step 6: Verify a genuinely offline boot**

Stop the Python server entirely (Ctrl-C — not just DevTools offline mode, so nothing can serve a file), then reload the page.

Expected: the app loads, the model initialises, Start camera works, and boxes draw. Only Gemini is unavailable, showing `Offline — detection only`.

This is the decisive proof that inference runs on the device. If it fails, check which request 404s in the Network tab and add that path to `SHELL`.

- [ ] **Step 7: Commit**

```bash
git add manifest.json sw.js icons/ js/main.js
git commit -m "feat: PWA manifest and service worker for offline operation

Shell and model are cached separately so a code change does not force a
36MB re-download. Cross-origin requests bypass the worker entirely."
```

---

### Task 8: Deploy to GitHub Pages and verify on the iPhone

**Deliverable:** the app installed on the home screen of the actual phone, verified against the checklist in spec §9.

**Files:**
- Create: `README.md`
- Modify: none

- [ ] **Step 1: Write the README**

Create `README.md`:

```markdown
# Hazard Detector — standalone iPhone app

On-device hazard detection (29-class YOLO) with Gemini verification and spoken
warnings. Runs entirely in the phone's browser: **no server, no backend, no
video streamed anywhere.** Only the Gemini verification call leaves the device.

## Install on an iPhone

1. Open the deployed URL in Safari
2. Share ▸ **Add to Home Screen**
3. Launch it, tap ⚙, paste a [Gemini API key](https://aistudio.google.com/apikey)
4. Tap **Start camera**

The key is stored only on that device. It is never in this repository.

## How it works

    camera frame ─▶ YOLO (ONNX Runtime Web, on-device) ─▶ live boxes
                          │ hazard + 8s cooldown
                          ▼
                    one JPEG ─▶ Gemini 2.5 Flash ─▶ confirm + danger + warning
                                                     ▼
                                        colour-coded banner + spoken aloud

Gemini is called at most once per 8 seconds (7.5/min, inside the free tier's
20/min limit) and never blocks the render loop.

## Development

    python -m http.server 8000     # Chrome allows the camera on localhost

- `tools/parity/parity.html` — checks the JS tensor maths against Python
- `tools/cors-check.html` — checks the key and the direct browser→Gemini call
- `tools/export_onnx.py` — re-export the model (`--imgsz 320` for more speed)

Requires `best.pt` in the repo root to re-export; it is gitignored, copy it
from `../Model-v4.2/best.pt`.

## Files

| Path | Purpose |
|---|---|
| `js/detector.js` | ONNX session, letterbox, decode, NMS |
| `js/gemini.js` | Direct Gemini REST call + typed errors |
| `js/speech.js` | Spoken warnings, mute, iOS audio unlock |
| `js/settings.js` | API key storage on the device |
| `js/ui.js` | Boxes, banner, status |
| `js/main.js` | Camera, render loop, cooldown |
| `sw.js` | Offline caching |
```

- [ ] **Step 2: Commit and confirm the tree is clean**

```bash
git add README.md
git commit -m "docs: add README with install and development instructions"
git status --short
git grep -inE "AIza[0-9A-Za-z_-]{30,}" -- . || echo "CLEAN: no API key in tracked files"
du -sh .git
```

Expected: clean status, `CLEAN`, and a `.git` well under 100 MB.

- [ ] **Step 3: Create the GitHub repo**

`gh` is not installed on this machine, so use the website: github.com ▸ **New repository** ▸ name `hazard-detector` ▸ **Public** ▸ do **not** add a README or `.gitignore` ▸ Create.

- [ ] **Step 4: Push**

```bash
cd /c/Users/amine/Desktop/Model-Prog/HazardApp-iphone
git branch -M main
git remote add origin https://github.com/aminekefii/hazard-detector.git
git push -u origin main
```

If the push is rejected for size, confirm `best.pt` is not tracked: `git ls-files | grep best.pt` must print nothing (only `model/best.onnx` at ~36 MB should be tracked).

- [ ] **Step 5: Enable Pages**

Repo ▸ Settings ▸ Pages ▸ Source: **Deploy from a branch** ▸ Branch `main`, folder `/ (root)` ▸ Save. Wait for the green check (1–2 minutes).

- [ ] **Step 6: Verify in desktop Chrome first**

Open `https://aminekefii.github.io/hazard-detector/`.

Expected: model loads, camera works, detection works, verification works. If the model 404s, the `.onnx` did not push — check `git ls-files model/`.

- [ ] **Step 7: Install and verify on the iPhone**

Open the same URL in **Safari** on the iPhone, then work through spec §9 in order:

| # | Check | Expected |
|---|---|---|
| 1 | Share ▸ Add to Home Screen | Icon appears on the home screen |
| 2 | Launch from the icon | Fullscreen, **no address bar** |
| 3 | Tap ⚙, paste the key, Start camera | Rear camera fills the screen |
| 4 | Point at scissors | Live boxes track the object; FPS is displayed |
| 5 | Hold it in view | Banner appears **and the warning is spoken aloud** |
| 6 | **Airplane mode, force-quit, relaunch** | App still loads, **boxes still drawn** — proof the model runs on the phone |
| 7 | Airplane mode still on, hold a hazard up | Banner: `Offline — detection only` |
| 8 | Airplane mode off | Verification resumes within one cooldown |

Record the observed FPS from step 4. If it is below ~4 FPS the app will feel unusable — apply the spec §7 remedies in order: re-export at `imgsz 320` (`python tools/export_onnx.py --imgsz 320`, then bump `MODEL_VERSION` in `sw.js` and push), then the COOP/COEP service-worker technique.

- [ ] **Step 8: Record the result**

Append the measured numbers to `README.md` under a new `## Measured on device` heading — iPhone model, iOS version, observed FPS, and which execution provider was used (check the console via Safari ▸ Develop, or infer: WebGPU on iOS 18+).

```bash
git add README.md
git commit -m "docs: record measured on-device performance"
git push
```

---

## Verification Summary

| Task | Proof it works |
|---|---|
| 1 | `HTTP 200` from Gemini in a browser page with no server |
| 2 | Session creates offline; output dims `[1,33,8400]`; 29 classes |
| 3 | `*** PARITY PASS ***` — JS boxes match Python within 5px / 0.05 conf |
| 4 | Live boxes track a real object; `overlay.width` is non-zero |
| 5 | Banner + spoken warning within 10s; all five failure paths degrade safely |
| 6 | Full key lifecycle works; `git grep AIza` reports CLEAN |
| 7 | App boots and detects with the local server **stopped** |
| 8 | Home-screen icon, fullscreen, and detection in airplane mode on the iPhone |
