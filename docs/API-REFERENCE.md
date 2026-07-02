# Realtime Camera ML — API Reference (compiled 2026-07-03)

> Compiled from official docs by a research agent. This is the coding reference for the
> camera/ML layer. Stack: Expo SDK 57 / RN 0.86.0 / React 19.2 /
> react-native-worklets 0.10 / Reanimated 4.5 / VisionCamera 5.1 / fast-tflite 3.0.1.
>
> **Version pins (Expo SDK 57 bundledNativeModules):** reanimated 4.5.0, worklets 0.10.0,
> skia 2.6.2 — do NOT manually upgrade to reanimated 4.6/worklets 0.11.

## 1. react-native-vision-camera v5.1.0

Docs: https://visioncamera.margelo.com (V5). V4 docs at visioncamera4.margelo.com.
Monorepo packages: core, `-worklets`, `-resizer`, `-skia`, `-barcode-scanner`, `-location`.

### V5 is a total rewrite — breaking changes

- **Nitro Modules foundation** — peer deps `react-native-nitro-modules` + `react-native-nitro-image`.
- **Formats API removed.** `useCameraFormat`, `format`/`fps`/`videoHdr` props gone → **Constraints API** (`constraints={[...]}`).
- **Boolean output props removed.** `<Camera photo video />` gone → **Output objects**: `usePhotoOutput()`, `useVideoOutput()`, `useFrameOutput()`, `CameraPreviewOutput`.
- **`frameProcessor` prop gone.** Frame processing = a `CameraFrameOutput` in `outputs={[...]}`.
- **Worklets runtime switched** to `react-native-worklets` (Software Mansion) via glue package `react-native-vision-camera-worklets` → SharedValues can be mutated directly inside frame worklets.
- No Expo config plugin in V5 docs — raw `ios.infoPlist` NSCameraUsageDescription / NSMicrophoneUsageDescription + `android.permissions` CAMERA / RECORD_AUDIO in app.json.

### Basic component

```tsx
import { Camera, useCameraPermission } from 'react-native-vision-camera'

const { hasPermission, requestPermission } = useCameraPermission()
<Camera style={{ flex: 1 }} isActive={true} device="back" />
```

Three API tiers: `<Camera />` view, `useCamera(...)` hook, imperative `CameraSession`.

### Frame output (was "frame processors")

```tsx
const frameOutput = useFrameOutput({
  pixelFormat: 'yuv',          // 'rgb' | 'yuv' | 'native'; yuv most efficient
  targetFps: 30,               // replaces V4 runAtTargetFps
  onFrame(frame) {
    'worklet'
    // frame.width, frame.height, frame.timestamp, frame.orientation,
    // frame.getPixelBuffer(): ArrayBuffer  (replaces toArrayBuffer())
    // frame.getPlanes(), frame.getNativeBuffer()
    frame.dispose()            // MANDATORY — GPU buffer pool
  }
})
<Camera outputs={[frameOutput]} ... />
```

Async processing (replaces `runAsync`):

```ts
const asyncRunner = useAsyncRunner()
const frameOutput = useFrameOutput({
  onFrame(frame) {
    'worklet'
    const wasHandled = asyncRunner.runAsync(() => {
      'worklet'
      doSomeHeavyProcessing(frame)
      frame.dispose()
    })
    if (!wasHandled) frame.dispose()   // runner busy → drop frame yourself
  }
})
```

Share with UI: write `useSharedValue` (from react-native-reanimated) directly inside `onFrame`; hop to JS with `scheduleOnRN` from `react-native-worklets`.

### Simultaneous recording + frame processing

```tsx
<Camera style={StyleSheet.absoluteFill} isActive device="back"
        outputs={[videoOutput, frameOutput]} />
```

```ts
const videoOutput = useVideoOutput({
  enableAudio: true,               // needs mic permission
  enablePersistentRecorder: true,  // survives device flips; slight buffering overhead
  fileType: 'mp4',
})
const recorder = await videoOutput.createRecorder({ /* RecorderSettings */ })
await recorder.startRecording(
  (path) => console.log('finished', path),
  (error) => console.error(error),
)
await recorder.stopRecording()
```

- **Don't re-use a Recorder** — create a new one per recording.
- `RecorderSettings`: `maxDuration`, `maxFileSize`, custom path; codec/bitrate fields exist — check
  /api/react-native-vision-camera/interfaces/RecorderSettings when coding.
- Use `onConfigured` — outputs become usable only after session connection.
- Keep `videoStabilizationMode` OFF for realtime ML (software stabilization queues frames → latency).

### GPU resize for ML — react-native-vision-camera-resizer

Metal/Vulkan compute shader: resize + YUV→RGB + dtype conversion (~5× faster than old resize-plugin).

```ts
const { resizer } = useResizer({
  width: 640, height: 640,
  channelOrder: 'rgb', dataType: 'float32',
  scaleMode: 'cover',              // or use crop
  pixelLayout: 'interleaved',      // 'planar' for CHW models
})
// in worklet:
const resized = resizer.resize(frame)     // GPUFrame
const buffer = resized.getPixelBuffer()   // ArrayBuffer for the model
resized.dispose()                          // dispose GPUFrame too!
```

### Skia — useSkiaFrameProcessor is GONE

`react-native-vision-camera-skia` provides `<SkiaCamera onFrame={(frame, render) => ...} />`.
Docs do NOT state whether SkiaCamera drawings bake into recordings. **Our approach: keep
recordings clean — plain `<Camera>` + a separate transparent Skia `<Canvas>` overlay driven
by SharedValues.**

### Constraints & exposure lock

```tsx
<Camera constraints={[{ fps: 60 }, { resolutionBias: videoOutput }]}
        onSessionConfigSelected={(config) => {}} />
```

`CameraController` (from `useCamera(...)`/session): `setExposureLocked(minExposureDuration, maxISO)`,
`setFocusLocked(0.3)`, `minISO/maxISO`, `zoom`, `setTorchMode`. `<Camera>` accepts `zoom`/`exposure`
as Reanimated SharedValues. Device probing: `useCameraDevice('back')`,
`device.getSupportedResolutions('video')`, `device.supportedFPSRanges`.

## 2. react-native-fast-tflite v3.0.1 (Nitro)

```ts
// metro.config.js must add 'tflite' to resolver.assetExts (done).
const model = await loadTensorflowModel(require('assets/model.tflite'), ['core-ml'])
// delegates array is the SECOND ARG in v3: [] | ['core-ml'] | ['android-gpu'] | ['nnapi']
const plugin = useTensorflowModel(require('assets/model.tflite'), [])

const outputs = model.runSync([inputBuffer])   // sync, worklet-safe
const boxes = new Float32Array(outputs[0]!)
```

Worklet pattern (box the Nitro object):

```tsx
import { NitroModules } from 'react-native-nitro-modules'
const model = objectDetection.state === 'loaded' ? objectDetection.model : undefined
const boxedModel = useMemo(() => (model != null ? NitroModules.box(model) : undefined), [model])
// worklet: const tflite = boxedModel.unbox(); tflite.runSync([buffer])
```

Config plugin: `["react-native-fast-tflite", { "enableCoreMLDelegate": true }]` (done).
Android GPU delegate needs `uses-native-library libOpenCL.so` etc. in AndroidManifest —
add via a small config plugin before release builds.
NOTE: no official V5+fast-tflite joint example exists; box/unbox + runSync is the documented mechanism.

## 3. Skia 2.6.2 + Reanimated 4.5

Pass shared/derived values directly as Skia props (no createAnimatedComponent):

```tsx
const r = useSharedValue(0)
const c = useDerivedValue(() => size - r.value)
<Canvas style={{ flex: 1 }}><Circle cx={r} cy={r} r={r} color="cyan" /></Canvas>
```

Paths: `Skia.PathBuilder.Make().moveTo(...).lineTo(...).build()` (builder API in 2.6.x docs).
`<Path path={skPathOrSvgString} style="stroke" strokeWidth={3} start={0} end={trim} />`.
Use Skia's `interpolateColors` inside `useDerivedValue` (not Reanimated's).

## 4. expo-audio (SDK 57)

```tsx
import { useAudioPlayer, createAudioPlayer, preload, setAudioModeAsync } from 'expo-audio'

const player = useAudioPlayer(require('../assets/sounds/make.wav'))  // auto lifecycle
player.play(); player.seekTo(0); player.replace(src)

await setAudioModeAsync({
  playsInSilentMode: true,
  interruptionMode: 'mixWithOthers',   // don't fight VisionCamera's audio session
  allowsRecording: true,
})
```

Overlapping sounds = multiple players; rapid retrigger = small player pool per sound or seekTo(0)+play().
`preload(src, { preferredForwardBufferDuration: 20 })` at module scope for low latency.

## 5. expo-sqlite (SDK 57)

```ts
import * as SQLite from 'expo-sqlite'
const db = await SQLite.openDatabaseAsync('hoopai.db')
await db.execAsync('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS ...')
const res = await db.runAsync('INSERT INTO t (v) VALUES (?)', 'x')  // lastInsertRowId, changes
const row = await db.getFirstAsync('SELECT ...', 1)
const rows = await db.getAllAsync('SELECT ...')
await db.withTransactionAsync(async () => { ... })
```

Provider: `<SQLiteProvider databaseName="hoopai.db" onInit={migrateDbIfNeeded}>` +
`useSQLiteContext()`. Migrations via `PRAGMA user_version`. Prepared:
`db.prepareAsync('... VALUES ($v)')` → `stmt.executeAsync({ $v })` → `stmt.finalizeAsync()`.

## 6. react-native-worklets 0.10 / Reanimated 4.5 renames

| Reanimated 3 | Now (`react-native-worklets`) |
|---|---|
| `runOnJS(fn)(args)` | `scheduleOnRN(fn, args)` — args inline! |
| `runOnUI` | `scheduleOnUI` |
| `executeOnUIRuntimeSync` | `runOnUISync` |

Babel: `react-native-worklets/plugin` — **babel-preset-expo handles this automatically in SDK 57;
do not add a manual babel.config.js unless needed.**
`useSharedValue` still imports from `react-native-reanimated`. New Architecture only.

## Assembled per-frame pipeline (unverified end-to-end — budget device testing)

`useFrameOutput({ pixelFormat:'yuv', targetFps, onFrame })` → worklet → `asyncRunner.runAsync` →
`resizer.resize(frame)` → `getPixelBuffer()` → `boxedModel.unbox().runSync([buffer])` → parse →
core pipeline (tracker/FSM) → write SharedValues (Skia overlay) / `scheduleOnRN` (SFX, SQLite) →
`resized.dispose(); frame.dispose()` — with `useVideoOutput({ enableAudio:true })` recording concurrently.

Verify on device: fast-tflite boxing inside V5 worklets, SkiaCamera-vs-overlay recording behavior,
full RecorderSettings fields.
