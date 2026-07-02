# HoopAI 🏀

**Real-time basketball shot tracking on your phone.** Prop your phone against a
water bottle, point it at the hoop, and HoopAI counts every make and miss —
live trajectory overlay, swish/miss sounds, per-session shooting stats, and
auto-kept highlight clips. iPhone + Android, all inference on-device.

> Working title. Built with React Native / Expo SDK 57 · VisionCamera 5 ·
> TensorFlow Lite · Skia · Reanimated 4.

## Features

- **Live shot tracking** — ball + rim detection at 30fps, Kalman-filtered
  trajectory drawn over the camera feed as it happens.
- **Automatic make/miss** — three fused signals (rim-plane crossing geometry,
  net-motion burst, learned ball-in-basket class) with a state machine hardened
  against rim-rattlers, layups and double counts. Distinct sounds for makes
  (bright swish chime) and misses (soft neutral thud); streak stingers at 3/5/10.
- **Session stats** — FG%, streaks, shot chart, entry/release angle and
  consistency, per-zone splits; every shot correctable with one tap.
- **Recording & highlights** — record the session while tracking runs;
  keep-only-makes clip planning (export lands in Phase 2).
- **Form analysis** — pose-based metrics (set-point elbow, knee flexion,
  release time, follow-through) with one-cue-at-a-time coaching rules
  (engine complete; pose model wiring is Phase 2).
- **Demo mode** — no model file or camera? A scripted scene drives the entire
  pipeline end-to-end, so the whole app works in a simulator today.

## How it decides make vs miss

```
Camera ──► VisionCamera V5 frame output (yuv, preview-sized buffers)
             │  worklet: GPU resize 640² → TFLite runSync → parse + NMS
             ▼
        ShotPipeline (JS thread)
             │  BallTracker: cleaning gates + gravity-prior Kalman
             │  RimLock: damped lock, drift detection, tap-to-adjust
             ▼
        ShotFsm: IDLE → SHOT_LIVE → resolve
             │  geo: does the interpolated crossing land inside the rim span?
             │  net: motion burst in the net ROI within the crossing window?
             │  cls: did the 'ball_in_basket' class fire?
             ▼
        MAKE / MISS / UNSURE → sounds, HUD, SQLite, clip plan
```

Full architecture, budgets and risk register: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Project layout

```
src/core/        Pure-TS pipeline (Kalman, tracker, rim lock, shot FSM,
                 trajectory fit, stats, form analysis, clip planner) — 150 unit tests
src/ml/          YOLO-style output parser (workletized) + scripted mock detector
src/pipeline/    JS-thread orchestrator gluing core to the camera layer
src/camera/      useShotEngine (VisionCamera V5 + fast-tflite), sounds
src/data/        SQLite (sessions/shots), src/state/ Zustand stores
src/components/  UI primitives, HUD overlays (Skia), charts
src/app/         expo-router screens
assets/sounds/   Synthesized WAVs (scripts/generate-sounds.mjs — no licensing)
docs/            ARCHITECTURE / API-REFERENCE / MODELS / BUILDING
```

## Develop

```powershell
npm install
npm run typecheck   # tsc --noEmit
npm test            # jest — core pipeline suite
npx expo start      # demo mode works in a dev build / simulator
```

Native modules ⇒ Expo Go won't run this; see [docs/BUILDING.md](docs/BUILDING.md)
for EAS cloud builds (Android APK + iOS TestFlight, no Mac needed).

## Model

The repo ships a placeholder at `assets/models/hoopai-det.tflite` (the app
falls back to demo mode). Train the real 4-class detector (ball, rim,
ball_in_basket, person) on CC BY 4.0 Roboflow datasets with an Apache-2.0
architecture (RF-DETR Nano): [docs/MODELS.md](docs/MODELS.md).

## Credits & licenses

- Datasets: Roboflow Universe (CC BY 4.0) — see docs/MODELS.md.
- Algorithm references: josephattalla/Basketball-Shot-Detection (MIT),
  Ed-Zh/Basketball-Analytics (MIT); idea-level: avishah3, SwishAI, chonyy,
  HomeCourt (NEX Team) UX.
- Ultralytics YOLO is deliberately **not** used (AGPL-3.0 extends to weights).
