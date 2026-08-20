# Hoopilot

On-device basketball shot tracking for iOS and Android: a custom-trained detector finds the ball and rim in the camera feed, a Kalman filter tracks the flight, and a state machine decides make or miss. No frame ever leaves the phone.

Phone-camera shot trackers are easy to demo and hard to trust. The failure that matters is not a missed shot, it is a *fabricated* one: the app awards a basket that never went in, the user notices, and every other number in the app loses its credibility. Hoopilot is built around the opposite bias. Every gate in the decision path can remove a make or refuse to decide, and none of them can invent one. `unsure` is a normal, shipped outcome rather than an embarrassment to be hidden.

This repository holds the full React Native app plus the training, export and validation tooling for its detector.

Project site: **https://hoopilot.pages.dev**

> Naming: the Expo app ships as **Hoopilot** (`app.json`); the repository kept its original `HoopAi` name.

## The rule: never fabricate a make

Three independent signals decide each attempt, and two of them are three-valued (`true`, `false`, or `null` for "this channel had nothing to say"):

| Signal | Source | What `null` means |
| --- | --- | --- |
| `geo` | Interpolated x where the ball crosses the rim plane on its final descending pass, tested against the central rim span. A crossing whose two samples are both real detections is preferred over a later Kalman-coasted one, so an extrapolated position cannot silently misplace the crossing. | No downward crossing was recorded at all, which happens routinely on genuine makes because the rim and net hide the ball at exactly that moment. |
| `net` | A net-motion burst near the crossing time, inside `SHOT_FSM.netWindowSec` (`netBurstInWindow`), with the window extended forward only after a rim bounce. | Every net-motion score during the live shot was zero: a netless outdoor hoop, or no net ROI was being monitored. |
| `cls` | The detector's `ball_in_basket` class firing at or above its score floor. | Boolean only; this channel has no unavailable state. |

`fuse()` in [`src/core/shotFsm.ts`](src/core/shotFsm.ts) is the entire decision:

```
geo === false                     -> miss     (a clean crossing outside the span)

net === null (netless hoop):
  geo === true                    -> make
  cls && occludedAtRim            -> make
  otherwise                       -> unsure

net available:
  (geo && net) || (net && cls)    -> make
  geo === true && !net            -> miss
  otherwise                       -> unsure
```

The load-bearing asymmetry is on the last branch. When a net is available, `cls` can only contribute to a make by *agreeing* with `net`; it cannot override `net === false`. An earlier revision let `(cls && occludedAtRim)` mint a make on its own, so a single false `ball_in_basket` blip near the rim was enough to award a basket to a ball that flew a metre in front of the hoop. That term was removed, and [`src/core/__tests__/fuse.test.ts`](src/core/__tests__/fuse.test.ts) pins its absence as a truth table.

Everything layered on top of `fuse()` obeys the same direction rule:

- **Vetoes only subtract.** [`src/core/depthRatioGate.ts`](src/core/depthRatioGate.ts) compares ball depth to rim depth using apparent pixel size. Because `Z = f·W/w_px`, the ratio `Z_ball/Z_rim` cancels focal length, so the test needs no camera intrinsics, only the user's ball-size setting. It may flip `geo` from `true` to `false` when the ball was clearly in front of or behind the hoop. It never confirms a make, never flips miss to make, and below its pixel-size and noise floors it stays silent and reports why in `disableReason`. Even the veto is kill-switched (`useDepthVeto`), so it can be disabled without touching the fusion path.
- **Corroborators only upgrade `null`.** Three of them may raise `geo` from `null` to `true`, and none may touch an explicit `false`. `geoExitObserved()` reads a real, non-predicted sample proven to reach below the rim *bottom* (not merely its top), in-span, with no later re-ascent, and applies only while `net` is not actively reporting "no swish". The virtual-crossing projection and the reappearance test in [`src/core/reappearance.ts`](src/core/reappearance.ts) (flag-gated, see Status) both demand more: `net === true`, or `net` unavailable with `cls` firing. Because they move `geo` rather than adding a new make term, `fuse()`'s guarantee still holds above them.
- **The offline pass never argues.** [`src/core/recheck.ts`](src/core/recheck.ts) re-examines unsure shots against the recorded video, but only `unsure -> make` and `unsure -> miss` count. A shot the live pass already decided is never flipped.

The decision core is pure TypeScript with no I/O and no wall-clock reads: time comes exclusively from camera frame timestamps. That is what makes the same code replayable offline in `recheck.ts` and testable frame-by-frame in unit tests.

## How it works

### Camera worklet (hot path)

[`src/camera/useShotEngine.ts`](src/camera/useShotEngine.ts) runs a VisionCamera frame processor entirely on the worklet runtime:

1. `react-native-vision-camera-resizer` letterbox-resizes the frame to the detector's square input. The 416 px model is the Speed path (`YOLOX_INPUT = 416`); a 640 px build of the same weights is the Quality path.
2. Channel order is **BGR** for the YOLOX models, interleaved NHWC. YOLOX is trained on OpenCV BGR frames, and the offline validation that confirmed this checkpoint detects at all used BGR, so feeding RGB inverts ball and rim colours on device.
3. `react-native-fast-tflite` runs `runSync` on the resized buffer.
4. [`src/ml/yoloParser.ts`](src/ml/yoloParser.ts) decodes the output tensor and applies class-wise NMS. It handles channels-first and channels-last layouts by parsing both and keeping whichever yields more valid boxes, with a sticky hint from the previous frame to stop noise from flipping the choice, plus optional YOLOX objectness and an undecoded raw-head path for quantised exports.
5. The same worklet samples a 12x12 green-channel grid inside the net ROI and diffs it against the previous frame to produce `netMotionScore` in 0..1.
6. One small payload per analysed frame crosses to the JS thread via `scheduleOnRN`.

The four detector classes are fixed by the trained model and pinned in `CLASS_ORDER`: `ball`, `rim`, `ball_in_basket`, `person`.

### Decision core (JS thread, pure TypeScript)

[`src/pipeline/shotPipeline.ts`](src/pipeline/shotPipeline.ts) consumes those payloads and drives the core modules in order:

| Module | Responsibility |
| --- | --- |
| [`src/core/rimLock.ts`](src/core/rimLock.ts) | The rim is nearly static, so it is *locked* rather than tracked: three mutually consistent detections form a lock, held under a heavy EMA damp. Five consecutive rejects flag a camera bump (`driftDetected`) and a fresh cluster re-locks automatically. |
| [`src/core/ballTracker.ts`](src/core/ballTracker.ts) | Class and confidence gating (relaxed inside the hoop ROI and while continuing a fresh flight), shape and teleport cleaning gates, then best-candidate selection weighted by inverse distance to the Kalman prediction. |
| [`src/core/kalman.ts`](src/core/kalman.ts) | 2D constant-acceleration filter over `[x, y, vx, vy]` with gravity as a *known* control input on y. Modelling the dominant acceleration explicitly lets process noise stay small, so the filter smooths hard and still follows a fast parabola. Inlined 4x4 matrix math, preallocated scratch buffers, covariance re-symmetrised each update. |
| [`src/core/trajectory.ts`](src/core/trajectory.ts) | Weighted quadratic fit of y over t and linear fit of x over t across the whole flight, returning `r2y`, the apex vertex, entry and release angles, and a predicted landing point. |
| [`src/core/shotFsm.ts`](src/core/shotFsm.ts) | `IDLE -> SHOT_LIVE -> resolve -> COOLDOWN`, with four arming paths: jump, layup, descending entry (seeded retroactively from a rolling pre-arm buffer), and a pose-gated release event. Buffers the live trajectory and net samples, then resolves through `fuse()`. |

Supporting gates and estimators live alongside: `viewBand.ts` classifies the camera placement, `lightProfile.ts` relaxes the cold-acquisition score gate in dark gyms, `courtGeometric.ts` and `ftCalibration.ts` estimate 2 vs 3 point value, and `evidence.ts` turns the three fused channels into the per-shot receipt chips the UI shows so the app never asks to be trusted blindly.

### Demo mode

[`src/ml/mockDetector.ts`](src/ml/mockDetector.ts) scripts a synthetic scene (static rim, shooter, projectile ball) looping make, front-rim miss, make, rim-rattler make, miss. It drives the full pipeline with no model file and no camera, which is how the app runs in a simulator and how the pipeline is exercised end to end.

### Model tooling

`training/yolox/` holds the YOLOX checkpoints and export metadata for the shipped detectors. The training kernels are one script per host: `hoopai-train-yolox.py` (Kaggle), `hoopai_train_lightning.py` (Lightning.ai) and `hoopai_train_colab.py` (Colab). All three train YOLOX on a merged multi-dataset Roboflow corpus remapped onto the four classes, then export checkpoint, ONNX and TFLite in that order, with the checkpoint written first so a failed conversion never costs a training run.

[`tools/validate_model.py`](tools/validate_model.py) is the measurement gate: it runs a candidate model over frames extracted from a real video, reports ball and rim recall at the app's actual cold (0.2) and tracking (0.12) score gates, and exits non-zero if `--compare` shows the candidate regressing ball recall. Its preprocessing deliberately mirrors the app exactly (contain-letterbox, BGR, float32 0..1) and its parsing mirrors `yoloParser.ts`, so an offline number means the same thing as an on-device one.

## Repository layout

```
src/core/       Pure-TS decision core: shotFsm, ballTracker, kalman, rimLock,
                trajectory, depthRatioGate, reappearance, recheck, stats, evidence
src/ml/         Output parsing (worklet-safe): yoloParser, poseParser,
                letterboxCull, roiTransform, mockDetector
src/camera/     useShotEngine (VisionCamera + fast-tflite worklet), sounds, voice
src/pipeline/   shotPipeline: JS-thread orchestrator joining core to the camera
src/data/       expo-sqlite schema, backup/restore, offline recheck runner
src/app/        expo-router screens (tabs, live session, summary, coach, history)
src/components/ HUD overlays (Skia), charts, share cards, UI primitives
assets/models/  TFLite detector + MoveNet pose weights
training/       YOLOX checkpoints and export metadata
tools/          validate_model.py, quantize_tflite.py
docs/           ARCHITECTURE, API-REFERENCE, MODELS, BUILDING, MASTER-PLAN
modules/        video-stitcher (local Expo native module, Swift + Kotlin)
```

`src/` is 261 TypeScript and TSX files totalling 72,675 lines, of which 76 files are test files holding roughly 1,080 cases. Most of that test weight sits on the pure core: `shotFsm`, `ballTracker`, `rimLock`, `trajectory`, `depthRatioGate`, `reappearance` and `recheck`, which is the part that can be tested honestly without a camera.

## Tech stack

| Layer | What is used |
| --- | --- |
| App | React Native 0.86, React 19, Expo SDK 57, expo-router, TypeScript |
| Camera and inference | react-native-vision-camera 5 (+ resizer, skia, worklets), react-native-fast-tflite |
| Rendering | @shopify/react-native-skia, react-native-reanimated 4, react-native-worklets |
| State and storage | zustand, expo-sqlite |
| Media | expo-video, expo-media-library, expo-video-thumbnails, a local video-stitcher native module |
| Tests | jest with jest-expo |
| Model tooling | Python: onnxruntime or tensorflow, numpy, ffmpeg for frame extraction |

## Getting started

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # jest
```

The app depends on native modules, so Expo Go cannot run it. Build a dev client or a store build:

```bash
npx expo start        # dev client; demo mode works without a model or camera
npx expo run:ios
npx expo run:android
```

CI builds live in `.github/workflows/` (`ios-ipa.yml`, `android-apk.yml`, plus model export workflows). See [`docs/BUILDING.md`](docs/BUILDING.md) for the EAS path.

To measure a detector before shipping it:

```bash
python tools/validate_model.py --model candidate.onnx --video court.mp4 \
    --fps 6 --size 416 --compare assets/models/hoopai-yolox-nano.tflite
```

## Status and limitations

This is a solo side project, not a released product. It is not on the App Store or Google Play. Builds come from the GitHub Actions workflows in `.github/workflows/` and are installed by hand.

Known limits, stated plainly:

- **No published accuracy numbers.** The repository contains no committed evaluation set and no confusion matrix, so this README quotes none. `tools/validate_model.py` measures per-frame detection recall on a single video, which is a detector metric, not an end-to-end make/miss accuracy. Building a labelled per-condition evaluation set and a replay harness is the next real milestone.
- **Single camera, monocular geometry.** A carom that drops straight down directly in front of the rim, viewed head-on, is genuinely ambiguous in 2D. The depth-ratio veto is the main defence, and it is structurally blind at long range, where the rim occupies too few pixels for the size ratio to discriminate. The honest outcome in that regime is `unsure`.
- **Some gates are conservative by default.** `SHOT_FSM.useDepthRatioVeto` and `SHOT_FSM.useReappearance` are `false` in `src/core/config.ts`, so the offline recheck and the unit suite always run against the plain baseline. The live app opts in per instance through `settingsStore` (both are on there, and both are user-visible switches). Keeping the library default conservative is what lets the pinned truth-table tests and the offline replay describe a single, known baseline.
- **Camera screens cannot be tested on Windows.** The unit suite covers the pure core and component logic; anything touching VisionCamera, the TFLite runtime or Skia overlays is verified only by hand on a device.
- **Unmeasured:** on-device frame rate, thermal behaviour over a long session, and battery cost. No figures appear anywhere in this README because none have been measured and recorded in the repository.

Branch state: `main` is the stable line. Later work, including a pose-only Form Check mode that reads shooting motion with no ball and no hoop in frame, sits on the `lightning-nano-model` branch; open PR #1 proposes an earlier part of that same line.

## Licences and credits

Project code is MIT, see [LICENSE](LICENSE). It does not cover the bundled model weights, the training data or the fonts, which carry their own terms; those are set out in [NOTICE](NOTICE).

Third-party terms are also tracked by hand in [`src/core/legalCredits.ts`](src/core/legalCredits.ts), which is the single source for the in-app credits screen (`src/app/legal/licenses.tsx`). A build-time dependency scan was rejected for this on purpose, because the entries that matter here are model weights and datasets, which a package scan does not see.

| Bundled model | Licence | Role |
| --- | --- | --- |
| YOLOX detectors, Tiny small-ball finetune plus Nano fallbacks | Apache-2.0 | Default detector |
| MoveNet SinglePose Lightning | Apache-2.0 | Optional 2D pose for form analysis |
| YOLO11 detectors | AGPL-3.0 | User-selectable fallback, not the default, flagged in `legalCredits.ts` for removal from any paid build |

Training images come from Roboflow Universe datasets under CC BY 4.0. Algorithm references are `josephattalla/Basketball-Shot-Detection` and `Ed-Zh/Basketball-Analytics`, both MIT. Fonts are Barlow Condensed and Inter under OFL-1.1. [`docs/MODELS.md`](docs/MODELS.md) lists every shipped model file with its architecture, input size and licence, plus the dataset, training and export detail.
