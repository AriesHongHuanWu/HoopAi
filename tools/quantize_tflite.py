#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
quantize_tflite.py -- staged INT8 quantization for the Hoopilot detector.

STAGE 1 (this script, SAFE): dynamic-range quantization -- weights int8,
activations (and the folded YOLOX decode with its exp()) stay float32, so the
prior full-int8 exp-overflow failure is STRUCTURALLY impossible. Typical gain
on A12-class CPUs: ~1.5-2x with negligible accuracy loss. Full int8 (stage 2)
requires the raw-head export + worklet decode and lands separately.

    python tools/quantize_tflite.py --onnx hoopai-yolox-640.onnx \
        --out hoopai-yolox-640-int8dyn.tflite

Requires: pip install onnx2tf tensorflow-cpu onnx onnx_graphsurgeon sng4onnx
(heavy -- run where the training exports run, e.g. the Kaggle kernel or Colab;
locally works too, it is conversion only, no training).

ALWAYS gate the result with tools/validate_model.py --compare against the
float model before shipping it into the app.
"""

import argparse
import glob
import os
import shutil
import subprocess
import sys
import tempfile


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--onnx", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    try:
        import tensorflow as tf
    except ImportError:
        sys.exit("pip install tensorflow-cpu onnx2tf onnx onnx_graphsurgeon sng4onnx")

    with tempfile.TemporaryDirectory() as td:
        saved = os.path.join(td, "saved")
        # onnx2tf: ONNX -> TF SavedModel (same tool the training export uses).
        rc = subprocess.run(
            ["onnx2tf", "-i", args.onnx, "-o", saved, "-osd"],
        ).returncode
        if rc != 0 or not os.path.isdir(saved):
            sys.exit(f"onnx2tf failed (rc={rc})")

        conv = tf.lite.TFLiteConverter.from_saved_model(saved)
        # Dynamic-range: weights int8, activations float. NO representative
        # dataset on purpose -- that path (full int8) breaks the folded exp().
        conv.optimizations = [tf.lite.Optimize.DEFAULT]
        tfl = conv.convert()
        with open(args.out, "wb") as f:
            f.write(tfl)

    src = os.path.getsize(args.onnx) / 1e6
    dst = os.path.getsize(args.out) / 1e6
    print(f"SAVED {args.out}  ({src:.1f} MB onnx -> {dst:.1f} MB tflite)")
    print("Next: tools/validate_model.py --model", args.out,
          "--compare <float tflite/onnx> --video <real court clip>")


if __name__ == "__main__":
    main()
