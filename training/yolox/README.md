# YOLOX-Nano hoop detector (Apache-2.0) — validated, ready to wire

This is the **license-clean, Metal-safe** replacement for the AGPL YOLO11 detector.
Recovered from the `hoopai-train-yolox` v4 Kaggle run (cancelled at the wall, but the
live checkpoint-promoter had already saved epoch-20 weights).

## Why this matters
- **Apache-2.0** (YOLOX + CC-BY data) → removes the AGPL monetisation blocker that
  YOLO11 imposed. Can ship in a closed-source paid app.
- **Standard-conv graph** → the iOS Metal/CoreML GPU delegate does **not** corrupt it
  the way it corrupts YOLO11 (the whole reason the self-healing delegate exists). So on
  iPhone this should run **fast *and* correct** on the GPU, not fall back to slow CPU.
- Clean, stable output — one high-confidence rim box per frame, no "一堆爛框" garbage.

## Validation (offline, on the user's real test video)
`copy_D34A5520….mov`, 8 frames @ 0.5 fps, ONNX and TFLite **numerically identical**:

| frame | rim score | ball |
|------|-----------|------|
| f_01 | 0.76 | — |
| f_03 | 0.59 | — |
| f_04 | 0.65 | — |
| f_05 | 0.47 | 0.28 (small/distant) |
| f_06 | 0.68 | — |
| f_07 | 0.69 | — |
| f_08 | 0.67 | — |

Rim is rock-stable at ~[20,258,67,300]. Ball fires at lower confidence (small, fast —
the Kalman tracker bridges gaps in-app). COCO val at epoch 20: **AP50 0.873**, AP50:95
0.649, AP75 0.718, large-object AP 0.787.

## Model I/O (verified with ai_edge_litert)
- **Input**  `[1, 416, 416, 3]` float32, **NHWC (interleaved RGB)**, range **0..1**
  (the `*255` YOLOX rescale is **baked into the graph**, so the app resizer's 0..1
  float32 output drops straight in — no per-frame scaling).
- **Output** `[1, 3549, 9]` float32, **channels-last**, decode **folded in** →
  `[cx, cy, w, h, obj, cls0..3]` in **416-px space**. score = `obj * max(cls)`.
- classes (index order): `["ball", "rim", "ball_in_basket", "person"]`.
- Anchors 3549 = 52²+26²+13² (strides 8/16/32 at 416).

## Files
- `yolox_nano_hoop.pth` — source weights (irreplaceable; also on Kaggle output).
- `hoopai-yolox_float32.tflite` (3.5 MB) — the app-ready model.
- `hoopai-yolox_float16.tflite` (1.8 MB) — smaller alt (validate before use).
- `export_onnx_local.py` — .pth → ONNX (decode folded, `*255` wrapper, opset 12).
- `validate.py` — YOLOX letterbox preproc + decode + NMS over frames (ONNX or TFLite).

## Remaining wiring (NEEDS AN ON-DEVICE TEST — do behind an opt-in, default-off toggle)
The live camera path currently feeds the detector **planar NCHW 0..1 at 640/320** with
`scaleMode:'cover'`. YOLOX needs a different feed, so wire it as a reversible opt-in:

1. **Settings** `detectorEngine: 'yolo' | 'yolox'` (default `'yolo'` → zero regression).
2. **Resizer** when yolox: `width/height = 416`, `pixelLayout: 'interleaved'`.
   ⚠️ Wrong pixelLayout silently zeroes ALL detections (documented past bug) — this is
   the #1 thing to confirm on device.
3. **Preproc mismatch to check on device**: this model was validated with **letterbox**
   (aspect-preserving pad to 114). The app resizer does `cover` (crop). YOLOX is fairly
   robust to this, but confirm rim/ball still track under `cover`; if not, switch that
   resizer to a `contain`/letterbox mode.
4. **Parser** add `hasObjectness` to `parseYoloOutput`: rows = `5 + nc`, score =
   `obj * cls`, layout known channels-last (skip the auto-detect for yolox). A unit test
   with a captured `[1,3549,9]` slice pins the decode.
5. **Model asset** `require('assets/models/hoopai-yolox.tflite')`, input size 416.
6. Metal should run it correctly — verify the smoke-test `corrupt` flag stays false on
   GPU (unlike YOLO11). If it does, the self-heal never trips and you get full GPU speed.
