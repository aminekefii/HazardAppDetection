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
names = {i: n.lstrip("﻿") for i, n in model.names.items()}

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
