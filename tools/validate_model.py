#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
validate_model.py -- the offline measurement gate for Hoopilot detectors.

Runs a YOLOX-family model over frames extracted from a real video and reports
per-frame ball/rim detection so model changes are MEASURED, not felt:

    python tools/validate_model.py --model hoopai-yolox-640.onnx \
        --video court.mp4 --fps 6 [--size 640] [--compare other.onnx]

Outputs per model: frames with a ball >= .2 / >= .12 (the app's cold/tracking
gates), rim coverage, score histograms -- and a side-by-side delta table with
--compare. Exit code 1 if --compare and the candidate REGRESSES ball recall.

Backends: .onnx via onnxruntime (pip install onnxruntime -- light, Windows-OK)
or .tflite via tensorflow (heavy; prefer onnx locally). Preprocessing matches
the app exactly: contain-letterbox to SxS, BGR channel order, float32 0..1.
Parsing matches src/ml/yoloParser.ts: folded decode [1, N, 4+1+nc]
channels-last, score = obj * max(cls).
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np

CLASSES = ["ball", "rim", "ball_in_basket", "person"]
BALL, RIM = 0, 1


def extract_frames(video, fps, out_dir):
    if shutil.which("ffmpeg") is None:
        sys.exit("ffmpeg not on PATH -- required for frame extraction")
    pattern = os.path.join(out_dir, "f_%05d.png")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-i", video, "-vf", f"fps={fps}", pattern],
        check=True,
    )
    return sorted(
        os.path.join(out_dir, f) for f in os.listdir(out_dir) if f.endswith(".png")
    )


def letterbox_bgr(img_rgb, size):
    """Contain-letterbox to size x size, RGB->BGR, float32 0..1, NHWC."""
    h, w = img_rgb.shape[:2]
    s = min(size / w, size / h)
    nw, nh = round(w * s), round(h * s)
    # nearest-neighbor resize via integer indexing (no cv2 dependency)
    yi = (np.arange(nh) / s).astype(np.int64).clip(0, h - 1)
    xi = (np.arange(nw) / s).astype(np.int64).clip(0, w - 1)
    resized = img_rgb[yi][:, xi]
    canvas = np.zeros((size, size, 3), dtype=np.float32)
    oy, ox = (size - nh) // 2, (size - nw) // 2
    canvas[oy : oy + nh, ox : ox + nw] = resized.astype(np.float32) / 255.0
    return canvas[:, :, ::-1].copy()  # RGB -> BGR


def load_png_rgb(path):
    try:
        from PIL import Image
    except ImportError:
        sys.exit("pip install Pillow")
    return np.asarray(Image.open(path).convert("RGB"))


class OnnxModel:
    def __init__(self, path):
        import onnxruntime as ort

        self.sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        inp = self.sess.get_inputs()[0]
        self.name = inp.name
        shape = inp.shape  # [1, S, S, 3] (NHWC) or [1, 3, S, S] (NCHW)
        self.nchw = shape[1] == 3
        self.size = int(shape[2] if self.nchw else shape[1])

    def run(self, nhwc):
        x = np.transpose(nhwc, (2, 0, 1))[None] if self.nchw else nhwc[None]
        return self.sess.run(None, {self.name: x.astype(np.float32)})[0]


class TfliteModel:
    def __init__(self, path):
        import tensorflow as tf  # heavy; onnx preferred locally

        self.itp = tf.lite.Interpreter(model_path=path)
        self.itp.allocate_tensors()
        self.inp = self.itp.get_input_details()[0]
        self.out = self.itp.get_output_details()[0]
        self.size = int(self.inp["shape"][1])
        self.nchw = False

    def run(self, nhwc):
        self.itp.set_tensor(self.inp["index"], nhwc[None].astype(np.float32))
        self.itp.invoke()
        return self.itp.get_tensor(self.out["index"])


def parse_folded(out):
    """[1, N, 4+1+nc] folded decode -> best score per class over the frame."""
    a = np.asarray(out)
    if a.ndim == 3:
        a = a[0]
    if a.shape[0] < a.shape[1]:  # tolerate [rows, N] transpose
        a = a.T
    obj = a[:, 4]
    cls = a[:, 5 : 5 + len(CLASSES)]
    scores = obj[:, None] * cls
    return scores.max(axis=0)  # per-class best


def evaluate(model_path, frames, size_override):
    model = (
        OnnxModel(model_path)
        if model_path.lower().endswith(".onnx")
        else TfliteModel(model_path)
    )
    size = size_override or model.size
    per_frame = []
    for i, f in enumerate(frames):
        best = parse_folded(model.run(letterbox_bgr(load_png_rgb(f), size)))
        per_frame.append(best)
        if (i + 1) % 25 == 0:
            print(f"  {i + 1}/{len(frames)} frames", flush=True)
    m = np.stack(per_frame)  # [F, nc]
    stats = {
        "frames": len(frames),
        "ball>=0.20": float((m[:, BALL] >= 0.20).mean()),
        "ball>=0.12": float((m[:, BALL] >= 0.12).mean()),
        "ball_median": float(np.median(m[:, BALL])),
        "rim>=0.35": float((m[:, RIM] >= 0.35).mean()),
        "rim_median": float(np.median(m[:, RIM])),
    }
    return stats


def report(tag, s):
    print(f"\n== {tag} ==")
    print(f"  frames             : {s['frames']}")
    print(f"  ball >=0.20 (cold) : {s['ball>=0.20'] * 100:5.1f}% of frames")
    print(f"  ball >=0.12 (track): {s['ball>=0.12'] * 100:5.1f}% of frames")
    print(f"  ball median score  : {s['ball_median']:.3f}")
    print(f"  rim  >=0.35        : {s['rim>=0.35'] * 100:5.1f}% of frames")
    print(f"  rim  median score  : {s['rim_median']:.3f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--video", required=True)
    ap.add_argument("--fps", type=float, default=6)
    ap.add_argument("--size", type=int, default=None)
    ap.add_argument("--compare", default=None, help="baseline model to beat")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as td:
        print(f"extracting frames @ {args.fps}fps ...", flush=True)
        frames = extract_frames(args.video, args.fps, td)
        print(f"{len(frames)} frames")

        cand = evaluate(args.model, frames, args.size)
        report(os.path.basename(args.model), cand)

        if args.compare:
            base = evaluate(args.compare, frames, args.size)
            report(f"BASELINE {os.path.basename(args.compare)}", base)
            d20 = cand["ball>=0.20"] - base["ball>=0.20"]
            d12 = cand["ball>=0.12"] - base["ball>=0.12"]
            print("\n== DELTA (candidate - baseline) ==")
            print(f"  ball >=0.20 : {d20 * 100:+.1f} pts")
            print(f"  ball >=0.12 : {d12 * 100:+.1f} pts")
            if d12 < -0.02:
                print("REGRESSION: candidate loses ball recall -- do not ship")
                sys.exit(1)


if __name__ == "__main__":
    main()
