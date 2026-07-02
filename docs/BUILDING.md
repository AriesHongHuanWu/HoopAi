# Building HoopAI (from Windows)

Native modules (VisionCamera, fast-tflite, Skia) mean **Expo Go cannot run this
app** — you need a dev build. Both platforms build in the cloud via EAS, no Mac
and no local Android SDK required.

## One-time setup

```powershell
npm install -g eas-cli
eas login                    # Expo account (free tier: limited builds/mo)
eas build:configure          # creates eas.json + links the project
```

## Android dev build (fastest loop)

```powershell
eas build --profile development --platform android
# → install the produced .apk on your phone (QR/link from the build page)
npx expo start --dev-client  # then scan from the dev build
```

Local Android builds later (optional): install JDK 17 + Android Studio, then
`npx expo run:android`.

## iOS (TestFlight, no Mac)

```powershell
eas build --profile development --platform ios   # needs Apple Developer account ($99/yr)
# or straight to TestFlight:
eas build --profile production --platform ios
eas submit --platform ios
```

Device-only note: iOS **release** builds of ML/GPU code need a real device
(simulator lacks the full Metal stack).

## Week-1 device verification list (from docs/ARCHITECTURE.md risks)

1. Concurrent `useVideoOutput` + `useFrameOutput` records clean 1080p while
   frames stream (vision-camera #3147-class regressions: verify recorded file
   has no dropped frames with inference ON).
2. fast-tflite `NitroModules.box(model)` → `unbox().runSync()` works inside a
   V5 `onFrame` worklet (no published joint example — our integration is first-party).
3. GPU delegate (`android-gpu`) loads the FP16 model; measure ms/frame at 640
   on a mid-range phone; decide detect-every-N-frames cadence.
4. `resizer.resize()` + `getPixelBuffer()` layout matches the model's expected
   input (RGB interleaved float32).
5. expo-audio SFX latency < 100ms from `player.play()` while recording audio.

## Demo mode (no model, no camera — works today)

The Live screen falls back to the mock detector (`src/ml/mockDetector.ts`) when
no model file is bundled: scripted make/miss scene drives the full HUD, sounds,
stats and session flow. Use this for UI iteration in a simulator/emulator.
