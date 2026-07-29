# Standalone iPhone Hazard Detector — Design

**Date:** 2026-07-29
**Status:** Approved, ready for implementation planning
**Supersedes:** `Model-v4.2-mobile` (PWA + PC-hosted FastAPI server)

## 1. Goal

A hazard-detection app that runs **entirely on an iPhone**. The YOLO model executes on the
phone's own processor; the only network dependency is the Gemini API call. No server of the
user's runs anywhere — no `server.py`, no tunnel, no video streamed to a PC.

The app opens the phone camera, draws live detection boxes, and when a hazard is detected
escalates one frame to Gemini, which confirms it, rates the danger, and writes a warning that
the phone then **speaks aloud** and shows as a colour-coded banner.

### Non-goals

- Not an App Store submission. No Xcode, no Mac, no Apple Developer account.
- No retraining. The 29-class v4 weights are used unchanged.
- No benchmark, evaluation, or report tooling in this folder — that stays in `Model-v4.2`.
  The one exception is the two-image parity harness of §9, which exists solely to prove the
  JS tensor math matches Python before anything runs on a phone.
- No background operation — the app detects only while open and on screen.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Platform | iPhone, installable PWA | Only free path to iOS from a Windows machine. Native iOS needs macOS + Xcode and $99/yr Apple Developer. |
| Inference | On-device, ONNX Runtime Web | Already proven in `Model-v4.2-mobile`. No frame leaves the phone for detection. |
| API key | Pasted once in-app, stored in `localStorage` | Keeps the key out of source and git, so GitHub secret scanning can't trigger Google's auto-revocation. Rotatable without redeploying. |
| Warning delivery | Spoken aloud + banner | The Gemini prompt has always asked for a sentence "to be read ALOUD"; the phone is the first platform that can deliver it. |
| Hosting | GitHub Pages, public repo | Free permanent HTTPS (required by iOS for camera). Public is safe because no key is in the source. |
| Code style | Plain ES modules, no build step | What is edited is what the phone runs. No toolchain, no `node_modules`, nothing to rebuild before deploying. |

### Accepted trade-off: the key lives on the device

Removing the backend necessarily means the key reaches the phone. Anyone with access to the
app or the device can extract it — this is equally true of a native app, where strings are
recoverable from the package. Acceptable for personal and academic demo use with a
restricted, rotatable key. **Not** acceptable for public distribution; that would require a
proxy holding the key (see §6.2).

### Accepted trade-off: frame rate

Browser inference gives roughly 5–15 FPS versus ~25–30 for a native Core ML build. Detection
*quality* is identical; only smoothness differs. Mitigations, in order of preference:
export at `imgsz 320`, then the service-worker COOP/COEP technique (§7).

## 3. File layout

New folder `Model-Prog/HazardApp-iphone/`, its own git repo, pushed to public GitHub repo
`hazard-detector`.

```
HazardApp-iphone/
├── index.html            app shell: video, overlay canvas, banner, settings sheet
├── manifest.json         PWA metadata (name, icons, display: standalone)
├── sw.js                 service worker — caches shell + model for offline use
├── css/style.css         layout, danger colours, iOS safe-area insets
├── js/
│   ├── main.js           orchestration: camera, rAF loop, cooldown, app state
│   ├── detector.js       ONNX session, letterbox, tensor, decode, NMS
│   ├── gemini.js         prompt template + REST call + response parsing
│   ├── speech.js         speaks the warning, mute toggle, iOS audio unlock
│   ├── settings.js       API key persistence + settings sheet
│   └── ui.js             box drawing, banner, status/FPS indicators
├── vendor/               ort.min.js AND its .wasm binaries (vendored, not CDN)
├── model/
│   ├── best.onnx         36 MB, 29 classes, exported from v4 best.pt
│   └── labels.json       class names in id order + imgsz
├── tools/
│   ├── export_onnx.py    re-export from best.pt (dev only, never shipped)
│   └── parity/           two sample images + expected Python output (dev only)
├── .gitignore            best.pt, OS junk
└── docs/superpowers/specs/    this document
```

### Carried over from v4.2

`best.onnx` + `labels.json`; the letterbox / decode / class-wise NMS logic; the **exact**
Gemini prompt string (unchanged, so verdicts stay comparable to the desktop results); the
banner colour scheme (red high / orange medium / green low / grey unconfirmed); the 8s
cooldown; `export_onnx.py`.

### Deliberately excluded

`server.py`, `gemini_verify.py`, `requirements.txt`, `.env`, `test_images/`,
`test_dataset.py`, `detect_and_verify.py`, `live_detect_verify.py`, all reports and result
JSON. `best.pt` is copied once from `Model-v4.2/best.pt` and kept locally for re-export, but is
gitignored — the phone only ever needs the `.onnx`.

## 4. Module interfaces

Each module has one responsibility and a narrow surface, so internals can change without
touching consumers.

| Module | Interface | Depends on |
|---|---|---|
| `detector.js` | `init(modelUrl, labelsUrl)` → session; `detect(videoEl)` → `[{box:[x1,y1,x2,y2], cls, conf}]` in **video pixel coordinates** | ORT only |
| `gemini.js` | `verify(jpegBlob, findingText, apiKey)` → `{detected_class, confirmed, danger_level, warning}` | fetch only |
| `speech.js` | `unlock()`, `say(text)`, `setMuted(bool)` | Web Speech API |
| `settings.js` | `getKey()`, `setKey(k)`, `clearKey()`, `open()`, `close()` | localStorage |
| `ui.js` | `drawBoxes(dets)`, `showBanner(verdict)`, `setStatus(text)`, `setFps(n)` | DOM only |
| `main.js` | wires the above; owns the loop and all mutable state | all |

`detector.js` returning **video-pixel** coordinates (not letterboxed 640-space) keeps the
un-letterbox math inside the module that created it; `ui.js` never needs to know a letterbox
happened.

## 5. Runtime flow

### Startup

1. Register the service worker.
2. Fetch `labels.json`; create the ORT session — WebGPU where available (iOS 18+), else WASM.
   Show explicit progress, since the 36 MB model download dominates first run.
3. Read the key from `localStorage`. **If absent the app still starts**: detection runs and a
   persistent chip reads "Tap ⚙ to add your Gemini key". Verification is simply disabled.
4. On **Start camera** tap: `getUserMedia({facingMode:'environment'})` →
   **await `loadedmetadata` before sizing the canvases** → prime `speechSynthesis` with a
   silent utterance (iOS unlocks audio only inside a user gesture; this tap is the one
   guaranteed gesture) → start the render loop.

> The `loadedmetadata` wait fixes a real defect in `Model-v4.2-mobile/web/app.js:79-82`, which
> sizes the overlay and snapshot canvases from `video.videoWidth` immediately after `play()`.
> When metadata has not yet arrived those are `0×0`, producing invisible boxes and an empty
> JPEG sent for verification.

### Per frame

`letterbox → tensor → session.run → decode + class-wise NMS → drawBoxes → update FPS`.
Nothing in this path awaits the network.

### Verification trigger

Fires when **all** hold: at least one detection; ≥ 8s since the last check; none in flight; a
key is set; `navigator.onLine`. It snapshots a full-resolution JPEG (quality 0.85) and calls
`gemini.verify()` **fire-and-forget** — the render loop never blocks, mirroring the background
thread in `live_detect_verify.py`.

On resolution: `ui.showBanner(verdict)`, and if `confirmed === true` and not muted,
`speech.say(verdict.warning)` (cancelling any utterance still playing).

### Banner lifetime

The banner persists until replaced, as on desktop, but **fades to a muted style after 30
seconds** so a stale HIGH DANGER verdict can never be mistaken for a live one.

## 6. Gemini integration

### 6.1 The call

```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent
x-goog-api-key: <key from localStorage>
{
  "contents": [{ "parts": [
      { "inline_data": { "mime_type": "image/jpeg", "data": "<base64 frame>" } },
      { "text": "<the v4.2 prompt, verbatim>" } ] }],
  "generationConfig": { "response_mime_type": "application/json" }
}
```

Response text is parsed as JSON into `{detected_class, confirmed, danger_level, warning}`.
A malformed body degrades to `{confirmed: null, warning: <raw text>}` — identical to the
Python fallback in `detect_and_verify.py`, so behaviour stays consistent across versions.

### 6.2 Primary risk — CORS

**The entire design assumes Google's endpoint permits cross-origin browser requests.**
Confidence is high (the official `@google/generative-ai` SDK is documented for browser use),
but this is an assumption, not a verified fact.

**Implementation step 1 is a ~20-line CORS spike** that calls the endpoint from a browser page
and prints a verdict. Nothing else is built until it passes. Documented fallbacks, in order:

1. Use the official `@google/generative-ai` browser SDK instead of raw `fetch`.
2. A free Cloudflare Worker proxy holding the key. Still nothing of the user's running, and it
   would remove the key from the device entirely — a strictly better security posture at the
   cost of one extra account and deploy step.

### 6.3 Rate limits

The key is on the Gemini **free tier: 20 requests per minute** (confirmed empirically on
2026-07-29, when a 280-image batch died at exactly 20 calls with
`429 RESOURCE_EXHAUSTED … Please retry in 57.8s`).

The 8s cooldown yields at most **7.5 calls/minute**, comfortably inside that limit. This is
the reason the cooldown is 8s and it must not be lowered below ~3.5s.

## 7. Performance constraints

- **GitHub Pages cannot set COOP/COEP headers**, so `SharedArrayBuffer` is unavailable and
  multi-threaded WASM silently collapses to a single thread. Expect WebGPU on iOS 18+, or
  single-threaded WASM otherwise. Do not set `numThreads > 1` and assume it took effect.
- If frame rate is poor: (1) re-export at `imgsz 320` via `tools/export_onnx.py --imgsz 320`,
  (2) apply the service-worker COOP/COEP technique to unlock threading.
- **ORT is vendored, including its `.wasm` binaries**, with `ort.env.wasm.wasmPaths` pointed at
  `vendor/`. The current PWA loads ORT from jsDelivr, which means its "offline" mode does not
  actually boot without internet. Missing the `.wasm` files is the easiest way to get this
  wrong.

## 8. Error handling

Every failure degrades to "detection keeps working".

| Situation | Behaviour |
|---|---|
| No key set | Chip "Tap ⚙ to add key"; boxes still drawn |
| Key rejected (400/403) | Grey banner "Key rejected"; settings sheet opens once |
| Quota exceeded (429) | Banner "Rate limited — pausing 60s"; cooldown stretched to 60s once, then normal |
| Offline / fetch failure | "Offline — detection only"; retried at the next cooldown |
| Malformed JSON | Raw text shown as the warning, `confirmed=null` → grey banner |
| Camera permission denied | Full-screen message with iOS re-enable steps |
| Model fails to load | Message + Retry button |

## 9. Testing

**Development loop.** Static server on `localhost` (`python -m http.server 8000`); Chrome
allows camera on localhost without HTTPS, so the app is fully testable on the PC webcam before
an iPhone sees it. Dev convenience only — the shipped app never contacts it.

**Parity harness.** The riskiest code is tensor math: the `[1, 4+nc, 8400]` output layout, the
letterbox coordinate mapping, and NMS. Errors there put boxes in the wrong place or shift
class ids, and the result looks *almost* correct. Procedure: run `best.pt` on the two images in
`tools/parity/` in Python, record boxes/classes/confidences, run the same two through the JS
ONNX path in a debug page, compare. Passing this means `detector.js` is correct and later bugs
lie elsewhere.

No test framework beyond that. The remaining surface — camera, network, iOS behaviour — is
hardware and browser reality a unit test cannot reach, and is covered by manual checks.

**Device verification, in order:**

1. Load the Pages URL in Safari → Add to Home Screen
2. Launch from the icon; confirm fullscreen with no address bar
3. Point at a hazard; confirm live boxes
4. Confirm banner appears and the warning is spoken
5. **Airplane mode, relaunch; confirm detection still works** — this is the proof that the
   model runs on the phone
6. Back online; confirm verification resumes

**Manual error checks:** bad key, no key, going offline mid-session, camera denied.

## 10. Deployment

`gh` CLI is **not** installed on this machine, so the repo is created through the GitHub
website.

1. `git init` in `HazardApp-iphone/`; `.gitignore` covering `best.pt` and OS junk
2. Create public repo `hazard-detector` on github.com
3. Push, then Settings ▸ Pages ▸ deploy from `main` / root
4. Open `https://aminekefii.github.io/hazard-detector` on the iPhone
5. Share ▸ Add to Home Screen
6. Launch, tap ⚙, paste the Gemini key
7. Start camera

## 11. Build order

1. **CORS spike** — prove a browser can call Gemini directly. Nothing else matters until this
   passes.
2. `detector.js` + parity harness against Python.
3. Camera + live boxes on desktop Chrome (includes the `loadedmetadata` fix).
4. `gemini.js` + banner + speech.
5. Settings sheet + key persistence.
6. Service worker + manifest + offline verification.
7. Deploy to Pages + iPhone verification checklist.

## 12. Open risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Gemini endpoint blocks browser origins | Low | Step 1 spike; fall back to the browser SDK, then a Cloudflare Worker proxy |
| Frame rate too low to feel live | Medium | `imgsz 320`; then COOP/COEP service worker for threads |
| iOS purges the cached model | Low | Reopening while online re-fetches it; 36 MB, one-time |
| Key extracted from the device | Accepted | Restricted, rotatable key; proxy option documented if distribution is ever needed |
