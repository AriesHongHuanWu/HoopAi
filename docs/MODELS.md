# Model acquisition & export

The app expects one detection model at `assets/models/hoopai-det.tflite`
(4 classes, see `src/ml/yoloParser.ts` CLASS_ORDER: `ball, rim, ball_in_basket, person`)
plus (Phase 2) a pose model. Until a model file exists, the app runs in
**demo mode** via `src/ml/mockDetector.ts` — the full pipeline, HUD, sounds and
stats work with a scripted scene.

## 1. Data (all CC BY 4.0 — commercial OK with attribution; verify in browser, the site blocks scripts)

| Dataset (Roboflow Universe) | Size | Classes we use |
|---|---|---|
| "Basketball and rim" (`basketball-hoop-tsdku`) | ~6.3k images | ball, rim (base set) |
| "Basketball Detection" (`basketball-detection-b977c` / `sskux`) | ~10k aggregate | ball, hoop variants |
| `basketball-player-detection-3` (roboflow-jvuqo) | 654 images | **ball-in-basket**, rim, player classes |

Merge in Roboflow: remap all class names onto our 4-class scheme. Person boxes can
also come from any COCO-person subset if the merged sets lack them.

**Augmentation that matters:** heavy motion-blur (label blurred streaks as ball),
brightness/low-light, indoor+outdoor mix. The ball at 640px is 15–40px — do NOT
train/infer below 640.

## 2. Architecture choice (license-clean)

- **Primary: RF-DETR Nano** (Apache-2.0, NMS-free, official CoreML export path).
- Backup: YOLOX-Nano / D-FINE (Apache-2.0).
- **Do NOT ship Ultralytics YOLO weights** (AGPL applies to weights; private
  benchmarking only). If you do want YOLO11n for comparison, keep it out of the repo.

## 3. Train (Colab or local GPU)

```bash
pip install rfdetr roboflow
# download merged dataset in COCO format from Roboflow, then:
python -m rfdetr.train --model nano --data ./dataset --epochs 150 --imgsz 640
```

Hold out a **video benchmark**: 200+ labeled shot clips (makes/misses/layups/
rim-rattlers, indoor+outdoor). Public repos claim 95–97% on ≤67 shots — do not
trust accuracy that isn't measured on your own benchmark.

## 4. Export

- **Android (TFLite FP16, GPU delegate):** RF-DETR → ONNX → `onnx2tf` → TFLite FP16.
  GPU delegate cannot run int8 — int8/QAT only if targeting Qualcomm NPU via QNN later.
- **iOS (CoreML FP16):** RF-DETR's official CoreML export (`.mlpackage`, ANE).
  fast-tflite also runs the TFLite file on iOS with the `core-ml` delegate as a
  simpler v1 path — ship the TFLite file first, adopt .mlpackage in v2 if ANE
  utilization disappoints.
- Output layout must match `parseYoloOutput` (`[1, 4+nc, N]`) or add a dedicated
  parser for RF-DETR's (boxes, logits) heads in `src/ml/`.

Put the file at `assets/models/hoopai-det.tflite`; metro is already configured
for `.tflite` assets. Switch `DetectorMode` in the camera layer from 'mock' to
'tflite' (src/camera/).

## 5. Pose model (Phase 2 — form analysis)

- **MoveNet Lightning int8 TFLite** (17 COCO keypoints — matches
  `PoseKeypointName` in `src/core/types.ts`) for v1 form analysis.
- MediaPipe BlazePose FULL (33 pts incl. hands) is the upgrade path (better
  follow-through metrics) but needs the MediaPipe Tasks runtime — evaluate
  `react-native-mediapipe` or ExecuTorch (`usePoseEstimation`, COCO-17) then.

## 6. Attribution

Ship a Credits screen entry: datasets from Roboflow Universe (CC BY 4.0, list the
three projects above), algorithm references: josephattalla/Basketball-Shot-Detection
(MIT), Ed-Zh/Basketball-Analytics (MIT). Idea-level references (no code copied):
avishah3, SwishAI, chonyy.
