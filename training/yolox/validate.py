#!/usr/bin/env python3
"""Validate an exported hoop detector (ONNX or TFLite) on real video frames.

Runs YOLOX letterbox preproc, decodes [1,N,4+1+nc] (obj*cls score), NMS, and
prints per-frame detections so we can confirm the model actually finds the
ball/rim before wiring it into the app.
"""
import glob
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "hoopai-yolox.onnx")
INPUT = 416
CLASSES = ["ball", "rim", "ball_in_basket", "person"]
SCORE_THR = 0.30
NMS_IOU = 0.45


def preproc(img, size):
    """YOLOX letterbox: pad to 114, keep aspect, HWC->CHW. Output 0..1 because
    the exported model bakes in the *255 rescale (matches the app resizer)."""
    padded = np.ones((size, size, 3), dtype=np.float32) * 114.0
    r = min(size / img.shape[0], size / img.shape[1])
    nw, nh = int(round(img.shape[1] * r)), int(round(img.shape[0] * r))
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    padded[:nh, :nw] = resized
    return padded / 255.0, r


def nms(boxes, scores, iou_thr):
    x1, y1 = boxes[:, 0], boxes[:, 1]
    x2, y2 = boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1)
        h = np.maximum(0.0, yy2 - yy1)
        inter = w * h
        ovr = inter / (areas[i] + areas[order[1:]] - inter + 1e-9)
        order = order[np.where(ovr <= iou_thr)[0] + 1]
    return keep


def run_onnx(model_path, chw):
    import onnxruntime as ort
    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    name = sess.get_inputs()[0].name
    inp = chw[None].astype(np.float32)  # [1,3,416,416]
    return sess.run(None, {name: inp})[0]


def run_tflite(model_path, chw):
    from ai_edge_litert.interpreter import Interpreter
    it = Interpreter(model_path=model_path)
    it.allocate_tensors()
    di = it.get_input_details()[0]
    do = it.get_output_details()[0]
    # onnx2tf makes input NHWC [1,416,416,3]
    hwc = np.transpose(chw, (1, 2, 0))[None].astype(np.float32)
    if tuple(di["shape"][1:]) == (3, INPUT, INPUT):
        hwc = chw[None].astype(np.float32)
    it.set_tensor(di["index"], hwc)
    it.invoke()
    return it.get_tensor(do["index"]), di, do


def decode_and_report(out, r, tag):
    out = np.asarray(out)
    if out.ndim == 3:
        out = out[0]  # [N, 9]
    boxes_xywh = out[:, 0:4]
    obj = out[:, 4]
    cls = out[:, 5:5 + len(CLASSES)]
    cls_id = cls.argmax(1)
    cls_score = cls.max(1)
    scores = obj * cls_score
    m = scores > SCORE_THR
    if not m.any():
        print("  %s: NO detections > %.2f (max score %.3f)" % (tag, SCORE_THR, scores.max()))
        return 0
    b = boxes_xywh[m]
    s = scores[m]
    cid = cls_id[m]
    # cx,cy,w,h -> x1,y1,x2,y2 (416 space), then / r back to original px
    xyxy = np.stack([
        (b[:, 0] - b[:, 2] / 2) / r, (b[:, 1] - b[:, 3] / 2) / r,
        (b[:, 0] + b[:, 2] / 2) / r, (b[:, 1] + b[:, 3] / 2) / r,
    ], 1)
    total = 0
    per_class = {}
    for c in np.unique(cid):
        idx = np.where(cid == c)[0]
        keep = nms(xyxy[idx], s[idx], NMS_IOU)
        kept = idx[keep]
        per_class[CLASSES[c]] = [(round(float(s[k]), 2),
                                  [int(v) for v in xyxy[k]]) for k in kept[:4]]
        total += len(kept)
    print("  %s: %d dets | max %.3f" % (tag, total, scores.max()))
    for name, dets in per_class.items():
        print("     %-15s %s" % (name, dets))
    return total


def main():
    frames = sorted(glob.glob(os.path.join(HERE, "frames", "*.jpg")))
    is_tfl = MODEL.endswith(".tflite")
    print("MODEL: %s (%s)" % (os.path.basename(MODEL), "tflite" if is_tfl else "onnx"))
    if is_tfl:
        import ai_edge_litert  # noqa
    printed_io = False
    grand = 0
    for f in frames:
        img = cv2.imread(f)
        chw = np.transpose(preproc(img, INPUT)[0], (2, 0, 1))
        r = min(INPUT / img.shape[0], INPUT / img.shape[1])
        if is_tfl:
            out, di, do = run_tflite(MODEL, chw)
            if not printed_io:
                print("  TFLITE IO: in=%s %s  out=%s %s" %
                      (di["shape"], di["dtype"], do["shape"], do["dtype"]))
                printed_io = True
        else:
            out = run_onnx(MODEL, chw)
        grand += decode_and_report(out, r, os.path.basename(f))
    print("TOTAL detections across %d frames: %d" % (len(frames), grand))


if __name__ == "__main__":
    main()
