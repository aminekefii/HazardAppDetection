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

Gemini is called at most once per 8 seconds and never blocks the render loop.

### A note on the free-tier quota

The Gemini free tier for `gemini-2.5-flash` allows **20 requests per day**, not
per minute (quota id `GenerateRequestsPerDayPerProjectPerModel-FreeTier`). At
the 8-second cooldown the daily allowance is therefore spent after roughly two
and a half minutes of continuous detection, after which verification returns
`Rate limited` and only the on-device boxes keep working. This is a deliberate
trade-off for demo use; raise `COOLDOWN_MS` in `js/main.js`, or move to a paid
key, if you need longer sessions.

## If the warnings are not spoken

Tap ⚙. The sheet has **Test voice** and a diagnostics block showing the build,
whether the app was launched from the home screen or a Safari tab, and what the
synthesiser is actually doing. Speech and camera behave differently in those two
launch modes, and iOS gives each its own storage, so check the one that is
failing rather than the one that is convenient.

Worth knowing:

- iOS grants speech only inside a tap. **Test voice** works for that reason;
  a warning spoken later borrows the session that tap opened.
- The Ring/Silent switch mutes speech synthesis with no error of any kind.
- `voices 0` means iOS has not finished building its voice list yet.
- If `build` is not the build you deployed, the phone is running cached code —
  see the note in `sw.js`.

## Development

    python -m http.server 8000     # Chrome allows the camera on localhost
    node tools/test/run.js         # no dependencies, nothing to install

The tests cover the rules WebKit enforces and desktop Chrome does not (speech
must be unlocked inside the tap; a paused synthesiser silently swallows every
utterance), plus the service worker's update and offline guarantees, and a
headless boot of the whole module graph.

- `tools/test/` — the test suite
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
| `js/main.js` | Camera, render loop, cooldown, diagnostics |
| `sw.js` | Offline caching; shell network-first, big files cache-first |
