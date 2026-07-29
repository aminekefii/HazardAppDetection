"""
export_onnx.py
==============
One-time: convert the YOLO model (best.pt, 29 classes) to ONNX so it can run
on-device in the browser (ONNX Runtime Web) inside the mobile PWA.

    python export_onnx.py                 # imgsz 640 (default)
    python export_onnx.py --imgsz 320     # smaller/faster for phones

Outputs web/best.onnx and web/labels.json (the class names, in id order).
"""
import os
import json
import argparse
import shutil

from ultralytics import YOLO

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # repo root: best.pt lives here


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.path.join(ROOT, "best.pt"),
                    help="source .pt model (default: best.pt here)")
    ap.add_argument("--imgsz", type=int, default=640,
                    help="square input size baked into the ONNX (default 640)")
    args = ap.parse_args()

    if not os.path.exists(args.model):
        raise SystemExit(
            f"ERROR: {args.model} not found. Copy best.pt from ../Model-v4.2/ here first.")

    model = YOLO(args.model, task="detect")

    # opset 12 = broadly supported by onnxruntime-web; static imgsz keeps JS simple.
    out = model.export(format="onnx", imgsz=args.imgsz, opset=12, simplify=True)
    print("exported:", out)

    web = os.path.join(ROOT, "model")
    os.makedirs(web, exist_ok=True)
    dst = os.path.join(web, "best.onnx")
    shutil.copyfile(out, dst)
    print("copied ->", dst)

    labels = {i: n.lstrip("﻿") for i, n in model.names.items()}
    names = [labels[i] for i in range(len(labels))]
    meta = {"imgsz": args.imgsz, "names": names}
    with open(os.path.join(web, "labels.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2, ensure_ascii=False)
    print(f"wrote model/labels.json ({len(names)} classes, imgsz {args.imgsz})")


if __name__ == "__main__":
    main()
