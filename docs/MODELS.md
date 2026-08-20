# Models

What ships in `assets/models/`, where the weights came from, and how to train
and export a replacement. Licence terms for every file below are in
[`NOTICE`](../NOTICE) and, machine-readable, in
[`src/core/legalCredits.ts`](../src/core/legalCredits.ts).

## 1. What ships

Every asset is loaded in [`src/camera/useShotEngine.ts`](../src/camera/useShotEngine.ts);
the names below are exactly the keys in its `MODEL_ASSETS` map.

| Asset | Key | Architecture | Input | Licence | Role |
| --- | --- | --- | --- | --- | --- |
| `hoopai-yolox.tflite` | `yolox` | YOLOX-Tiny small-ball finetune | 416 | Apache-2.0 | Default detector, Speed path |
| `hoopai-yolox-640.tflite` | `yolox640` | same weights, larger export | 640 | Apache-2.0 | Quality path |
| `hoopai-yolox-nano.tflite` | `yoloxNano` | YOLOX-Nano | 416 | Apache-2.0 | Lighter fallback for slow devices |
| `hoopai-yolox-nano-640.tflite` | `yoloxNano640` | YOLOX-Nano | 640 | Apache-2.0 | Lighter fallback, Quality path |
| `hoopai-yolox-nano-v2.tflite` | `yoloxNanoV2` | YOLOX-Nano small-ball finetune | 416 | Apache-2.0 | Experimental, Settings toggle |
| `hoopai-yolox-nano-v2-640.tflite` | `yoloxNanoV2_640` | same, larger export | 640 | Apache-2.0 | Experimental, Quality path |
| `hoopai-det.tflite` | `standard` | YOLO11n | 640 | **AGPL-3.0** | Legacy fallback, not the default |
| `hoopai-det-precise.tflite` | `precise` | YOLO11s | 640 | **AGPL-3.0** | Legacy fallback, more scenes, slower |
| `hoopai-det-fast.tflite` | `fast` | YOLO11 nano, 320 export | 320 | **AGPL-3.0** | Legacy `speed` perf mode |
| `movenet-pose.tflite` | `POSE_ASSET` | MoveNet SinglePose Lightning | 192 | Apache-2.0 | Opt-in form analysis, 17 COCO keypoints |

Defaults, from [`src/state/settingsStore.ts`](../src/state/settingsStore.ts):
`detectorEngine: 'yolox'`, `perfMode: 'speed'`, which resolves to the 416 px
YOLOX path (`YOLOX_INPUT = 416`; `YOLOX_INPUT_HQ = 640`). The loader
speed-budgets the heavier YOLOX rungs against `YOLOX_TINY_MAX_MS = 120` and
steps down to the Nano assets on devices that miss the budget, because a model
that runs at 2 fps starves the tracker of arc samples and makes detection worse
overall, not better.

### The AGPL position

The `hoopai-det*.tflite` files are Ultralytics YOLO11 exports and are AGPL-3.0.
They are in the repository and they are selectable in Settings, but they are not
the default engine and they are not covered by the MIT grant in `LICENSE`. They
are flagged in `legalCredits.ts` so the credits screen can mark them and so any
closed-source or paid build drops them. Moving the default to YOLOX is what
removed the AGPL blocker; see `docs/MASTER-PLAN.md` B08 for the removal plan.

## 2. Class and tensor contract

Four classes, fixed by the trained weights and pinned in
[`src/ml/yoloParser.ts`](../src/ml/yoloParser.ts):

```ts
export const CLASS_ORDER: readonly DetClass[] = ['ball', 'rim', 'ball_in_basket', 'person'];
```

The verified YOLOX export contract (`training/yolox/hoopai-yolox.meta.json`):

- Input `[1, S, S, 3]` float32, NHWC interleaved, range 0..1. The YOLOX `*255`
  rescale is baked into the graph, so the resizer's float output drops straight
  in with no per-frame scaling.
- Output `[1, A, 9]` float32, channels-last, decode folded in, fields
  `[cx, cy, w, h, obj, cls0..3]` in input-pixel space, score `obj * max(cls)`.
  At 416 the anchor count `A` is 3549 (52² + 26² + 13², strides 8/16/32).

`parseYoloOutput` does not trust that layout blindly. It parses both
channels-first and channels-last and keeps whichever yields more valid boxes,
with a sticky hint from the previous frame; picking the wrong one produces
thousands of garbage boxes. Channel order fed on device is **BGR**, not RGB, as
described in the README's camera-worklet section: the checkpoints were validated
against OpenCV BGR frames, and RGB inverts ball and rim colours at runtime.

A replacement model must either match this contract or get its own parser in
`src/ml/`.

## 3. Training data

All Roboflow Universe, all CC BY 4.0, so commercial use is fine with
attribution. Attribution is discharged by this file and by the in-app credits
screen.

| Dataset | Classes taken |
| --- | --- |
| "Basketball and rim" (`basketball-hoop-tsdku`) | ball, rim |
| "Basketball Detection" (`basketball-detection-b977c` / `sskux`) | ball, hoop variants |
| `basketball-player-detection-3` (roboflow-jvuqo) | ball_in_basket, rim, player |

Class names from all three are remapped onto the four-class scheme above.
Person boxes can also come from any COCO-person subset.

What the augmentation recipe actually targets, per
`training/yolox/smallball-meta.json`: multiscale 416 to 640, mosaic (0.1, 2.0)
at p 0.7, and oversampling of small-ball instances below 0.25% relative area
with a +30% cap. The ball is the hard class because it is small, fast and
motion-blurred; heavy motion blur, low light, and an indoor/outdoor mix are the
augmentations that move the number.

## 4. Train

Three training kernels sit at the repository root, one per host, all training
YOLOX on the merged corpus: `hoopai-train-yolox.py` (Kaggle),
`hoopai_train_lightning.py` (Lightning.ai) and `hoopai_train_colab.py` (Colab).
Each writes the checkpoint first, then ONNX, then TFLite, so a failed conversion
never costs the training run.

Checkpoints and export metadata are kept in `training/yolox/`.

## 5. Export

`training/yolox/export_onnx_local.py` takes `.pth` to ONNX with the decode
folded in and the `*255` wrapper attached, opset 12. ONNX then goes to TFLite
float32 via `onnx2tf`. The GPU delegate cannot run int8, so int8 or QAT is only
worth it when targeting an NPU.

Put the file in `assets/models/` and add it to `MODEL_ASSETS` in
`useShotEngine.ts` with its input size. Metro is already configured for
`.tflite` assets.

## 6. Validate before shipping

Validation is on real video, not on the val split. A curated-Tiny checkpoint
scored 0.922 on event val and was measurably worse on real footage, which is
why `docs/MASTER-PLAN.md` makes this a hard gate.

```bash
python tools/validate_model.py \
  --model assets/models/<new>.tflite \
  --video <clip>.mov \
  --fps 6 --size 416 \
  --compare assets/models/hoopai-yolox-nano.tflite
```

`tools/validate_model.py` measures per-frame detection recall on one video.
That is a detector metric, not end-to-end make/miss accuracy, and this
repository publishes no accuracy figure because no labelled per-condition
evaluation set exists yet. Do not trust an accuracy claim that was not measured
on your own benchmark.

`training/yolox/validate.py` is the offline equivalent used during export: YOLOX
letterbox preprocessing, decode and NMS over extracted frames, runnable against
either the ONNX or the TFLite file to confirm they are numerically equivalent.

## 7. Pose

MoveNet SinglePose Lightning, 192 px square input, 17 COCO keypoints matching
`PoseKeypointName` in `src/core/types.ts`. It runs only when form analysis is
turned on, and it is parsed by [`src/ml/poseParser.ts`](../src/ml/poseParser.ts).
MediaPipe BlazePose FULL (33 points, including hands) is the upgrade path for
better follow-through metrics, but it needs the MediaPipe Tasks runtime, so it
is not a drop-in.

## 8. Running without a model

[`src/ml/mockDetector.ts`](../src/ml/mockDetector.ts) scripts a synthetic scene
and drives the whole pipeline with no model file and no camera. That is how the
app runs in a simulator and how the pipeline is exercised end to end. Select it
with `EngineMode = 'demo'`.
