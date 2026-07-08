# video-stitcher

Local Expo native module that exports a **single MP4** by concatenating clip
windows out of one source recording — fast, fully on-device, no server. It's
what turns Hoopilot's in-app highlight reel (which only _plays_ make-clips by
seeking around the master recording) into a real file you can drop straight into
Instagram Reels.

- **iOS:** `AVMutableComposition` + `AVAssetExportSession`
- **Android:** [`media3-transformer`](https://developer.android.com/media/media3/transformer)

The module autolinks in SDK 57 (it lives under `modules/`), so there is **no app
config change** required — see [Autolinking](#autolinking-sdk-57).

## API

Import the guarded wrapper (`src/media/videoStitcher.ts`), not this module
directly. The wrapper degrades gracefully when the native module is absent
(Expo Go, Jest, or a binary built before this landed).

```ts
import { stitch, onProgress, available, cancel } from '@/media/videoStitcher';
```

### `stitch(options)`

```ts
stitch(options: {
  sourceUri: string;                 // file:// URI (or bare path) of the source
  segments: { startSec: number; endSec: number }[]; // clip windows, source time
  outputFileName?: string;           // optional basename; ".mp4" appended
  durationSec?: number;              // optional source duration → clamps segments
  mergeGapSec?: number;              // optional: merge windows within this gap
}): Promise<{ uri: string; durationSec: number }>
```

Resolves with the exported MP4's `file://` URI (in the app cache) and its
duration. **Rejects with a coded error** — never crashes — on any failure;
`err.code` is one of:

| code | meaning |
|------|---------|
| `ERR_STITCHER_UNAVAILABLE` | native module not in this build (TS guard) |
| `ERR_NO_SEGMENTS` | no usable segments (empty, or all out of range) |
| `ERR_NO_SOURCE` | `sourceUri` empty/invalid |
| `ERR_BAD_ASSET` | source video couldn't be read |
| `ERR_NO_VIDEO_TRACK` | source has no video track |
| `ERR_COMPOSITION` | composition build failed / a stitch is already running |
| `ERR_EXPORT_SETUP` / `ERR_EXPORT_FAILED` | export session failed |
| `ERR_CANCELLED` | `cancel()` was called mid-export |
| `ERR_OUTPUT` | couldn't prepare the output file |

Before segments reach native, the wrapper runs `sanitizeSegments`
(clamp to `[0, durationSec]`, drop reversed/degenerate windows, sort, merge
overlaps/near-adjacent, drop sub-`0.2s` windows). Native **re-clamps
defensively** and skips any range it can't insert, so a bad segment can never
crash the export.

### `available: boolean`

`true` only when the native module is linked **and** `isAvailable()` returns
true. Branch on this to hide the Export button in unsupported builds.

### `onProgress(listener) => unsubscribe`

Fires once per appended segment: `{ index, total }` (0-based). Coarse by design
— assembly is near-instant; the export dominates. Returns an unsubscribe
function (a no-op when the module is absent).

### `cancel(): void`

Best-effort cancel of the in-flight export. No-op when nothing is running or the
module is absent.

### `buildReelSegments(session, shots, opts)` (`src/media/reelExport.ts`)

Pure helper that turns a session's made shots into video-time stitch windows,
reusing the exact make-window math from `src/core/clipPlanner.ts` and the reel
player. It maps shot-clock time to video time via
`videoTime = shot.tResolved − recordingStartSec`, then clamps/merges. Returns
`{ ok: true, sourceUri, segments, totalSec }` or `{ ok: false, reason }` for the
same graceful-exit states the player handles (`no-recording`, `no-offset`,
`no-duration`, `no-makes`, `empty`). Feed `segments` + `sourceUri` to `stitch`.

## Platform notes

### Why passthrough / transmux (seconds, not minutes)

Re-encoding a multi-minute recording on a phone is slow and battery-hungry. Both
platforms avoid it:

- **iOS** prefers `AVAssetExportPresetPassthrough` when the composition can be
  exported losslessly (the common case: all clips come from one source, same
  codec), copying compressed samples with no re-encode. It falls back to
  `AVAssetExportPresetHighestQuality` only when passthrough isn't possible.
- **Android** `media3-transformer` **transmuxes** (remuxes compressed samples
  into a new MP4 container) when the clips share the source codec, rather than
  transcoding. A `VIDEO_H264` output MIME is requested as the fallback target.

For a typical highlights reel cut from a single H.264 recording, both paths are
a container-level copy — a handful of seconds, not minutes.

Orientation is preserved: iOS copies the source track's `preferredTransform`;
media3 carries the source rotation metadata through the transmux.

Output MP4s land in the app **cache** directory (`…/reels/`). Reels are
ephemeral share artifacts — the user shares them out or saves to their library
(via `expo-media-library`); cache is the right home and lets the OS reclaim
space.

### Dependencies

`media3` is declared in **this module's** `android/build.gradle`
(`media3-transformer`, `media3-common`, `media3-effect` @ 1.4.1) — NOT in the
app's `package.json`. The module owns its transcode/transmux stack. iOS needs no
extra pods beyond `ExpoModulesCore`; `AVFoundation`/`CoreMedia` are system
frameworks (declared in the podspec).

## Autolinking (SDK 57)

Local modules under `modules/` autolink automatically in SDK 57 — Expo
autolinking discovers any directory with an `expo-module.config.json`
(`nativeModulesDir` defaults to `./modules/`). **No change to `app.json`,
`package.json`, `Podfile`, or Gradle is required.** After adding the module:

- iOS: `npx pod-install` (or `expo prebuild`) picks up the podspec.
- Android: the Gradle project is included automatically.

CI (macOS/Ubuntu prebuild) compiles the native code; the local dev machine
here can't build native, so the native side is validated by CI and the
TypeScript layer is fully unit-tested (`src/media/__tests__/`).

## CI expectations

- **iOS**: builds against deployment target 16.4 (matches the app). Uses only
  system frameworks + `ExpoModulesCore`.
- **Android**: `minSdkVersion 26` (matches the app's `expo-build-properties`).
  media3 1.4.1 is compatible with the app's AGP 8 / Kotlin toolchain.
- The prebuild step must run so autolinking regenerates the native projects with
  this module included.

## v2 follow-ups

Anything that needs **compositing** (drawing on top of the video) requires a
re-encode — passthrough/transmux only copies existing frames. Deferred to v2:

- **Watermark / brand bug** burned into the exported file (the in-app player
  already shows a `BrandMark` overlay, but that's not in the pixels).
- **End-card / stat frame** appended as real video (the player ends on a branded
  `ShareCard`; exporting it means rendering it to frames and encoding).
- **Transitions / crossfades** between clips.
- **Music bed / audio ducking.**

Each of these means switching iOS to a re-encoding preset + `AVVideoComposition`
/ `AVMutableAudioMix`, and Android to media3 `Effects` (`OverlayEffect`,
`TextureOverlay`) with a real encode — slower, but the quality bar for a shared
reel may justify it. Keep them behind the same `stitch` API so callers don't
change.
