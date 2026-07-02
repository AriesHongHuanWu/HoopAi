# ShotTracker — Definitive Architecture & Build Plan

**Cross-platform realtime basketball shot-tracking app** (iPhone + Android, 30fps+ on-device, developed on Windows)

---

## 1. Tech Stack Decision

| Layer | **Choice** | Runner-up | Why rejected |
|---|---|---|---|
| **Framework** | **React Native** (Expo dev-client, New Architecture, RN 0.81+/SDK 54+) | Flutter | Flutter's only concurrent record+stream API (`startVideoRecording(onAvailable:)`) is broken on Android since Sept 2023 (flutter/flutter#134814, still open) — this is exactly our core feature. `CameraImage` has **no frame timestamp**, killing frame-accurate clip alignment. `tflite_flutter` is weakly maintained (last push Oct 2025, 108 open issues). KMP rejected outright: no shared camera/ML layer (write the hard part twice) and Kotlin/Native iOS can't compile on Windows. |
| **Camera** | **react-native-vision-camera V5** (Nitro; MIT, 9.5k★, pushed Jul 2026) — concurrent `VideoOutput` + `FrameOutput`, `Frame.timestamp`, persistent recorder | VisionCamera V4 snapshot | Keep V4 as a documented fallback only if a needed V5 plugin hasn't migrated to Nitro at kickoff. |
| **Inference runtime** | **TFLite/LiteRT via react-native-nitro-tflite** (or fast-tflite on V4): CoreML delegate on iOS (ANE), GPU delegate on Android (NNAPI deprecated in Android 15) | Ultralytics Flutter plugin / native MediaPipe Tasks modules | Ultralytics plugin is AGPL/paid and Flutter-only; native Tasks modules mean double native code. Note: official fast-tflite V5 integration is sponsor-gated — plan for nitro-tflite. |
| **Ball/rim detector model** | **RF-DETR Nano fine-tuned on 3 classes (ball, rim, ball-in-basket)** — Apache-2.0, 48 COCO AP, NMS-free, official CoreML path; export FP16 | YOLO11n/YOLO26n (Ultralytics) | Better toolchain but AGPL applies to code **and weights** → paid Enterprise License for a closed app. Use Ultralytics only for private prototyping/benchmarking. Backups: YOLOX-Nano, D-FINE (both Apache-2.0). |
| **Pose model** | **MediaPipe Pose Landmarker FULL (BlazePose)** — Apache-2.0, 33 landmarks incl. thumb/index/pinky (only mobile model with hand-adjacent points), 2D + 3D world landmarks, 30fps+ mid-range phones | MoveNet Lightning; RTMPose-s | MoveNet: 17 pts, no hands, no 3D → weak follow-through metrics (keep as low-end-Android fallback). RTMPose-s: best accuracy/ms but DIY ncnn integration → v2 upgrade path. YOLO11-pose (AGPL, no hands) and Apple Vision (iOS-only) fail hard requirements. |
| **Overlay rendering** | **@shopify/react-native-skia** + react-native-vision-camera-skia; Reanimated 4 SharedValues written directly from frame processors | Plain RN views | Can't hit 30–60fps trajectory trails; Skia is GPU (Metal/OpenGL) and integrates with VisionCamera. **Known constraint: overlays are preview-only, never baked into recordings.** |
| **Audio** | **expo-av / react-native-sound** with pre-loaded, low-latency samples (swish chime, neutral thud, streak stingers) + optional TTS voice announcements (selectable metric, à la HomeCourt) | Native audio modules | Only needed if measured latency >100ms; start simple. |
| **Video/clips** | **VisionCamera V5 persistent Recorder** (h265, ~5–6 Mbps) → event-offset log → session-end **passthrough trim via react-native-media-toolkit** (AVAssetExportSession passthrough / Media3 Transformer ClippingConfiguration) | react-native-video-trim (self-hosted FFmpeg) | FFmpeg is a supply-chain liability (ffmpeg-kit retired Jan 2025, binaries purged, patent risk, 16KB-page issues). media-toolkit is small (69★) — vet/vendor it, or write our own ~200-line Nitro module around the same native APIs. |
| **State/storage** | **Zustand** (session state) + **SQLite via expo-sqlite or WatermelonDB** (shots, sessions, trends) + **MMKV** (settings) + expo-media-library (clips to Photos/MediaStore) | Redux, Realm | Overkill / heavier; SQLite is the right shape for shot-chart queries (per-zone FG%, trends). |
| **iOS builds from Windows** | **EAS Build** (15 free iOS builds/mo; $19/mo tier) + TestFlight | Codemagic (500 free macOS-M2 min/mo) | Both work; EAS integrates with the Expo dev-client hot-reload loop. Keep Codemagic as fallback. |

---

## 2. Detection Pipeline (End-to-End)

```
Camera (1080p60 capture, locked short exposure ≤1/500s, yuv format)
 ├─► VideoOutput: full-res 1080p h265 recorder (untouched by ML)
 └─► FrameOutput: small buffers (720p yuv) → frame processor (worklet)
       │  frame.timestamp captured for every event; frame.dispose() always
       ├─ [GPU resize plugin] 640×640 letterboxed tensor          ~2-4 ms
       ├─ [Detector: RF-DETR Nano FP16]
       │    iOS: every frame (ANE 3-12 ms)
       │    Android mid-range: every 2-3 frames (GPU delegate 25-45 ms)
       │    + 320px ROI re-detect around Kalman prediction on skipped frames
       ├─ [Single-ball tracker] gravity-prior (const-acceleration) Kalman,
       │    ByteTrack-style low-conf rescue, cleaning gates          <1 ms
       ├─ [Rim lock] detect once at session start, user-confirmed, heavily
       │    damped; re-verify every ~5 s                             ~0 ms/frame
       ├─ [Net-motion ROI] MOG2/frame-diff on ~100px net box         <1 ms
       ├─ [Trajectory ring buffer] last 30 ball points (x, y, t, conf)
       ├─ [Shot FSM] IDLE → SHOT_LIVE → RESOLVED (make/miss/unsure)
       └─ [Pose: BlazePose FULL] runAsync, throttled to 20-30fps, only
            while person detected                                    10-25 ms
       ▼
 SharedValues → Skia overlay (trajectory trail, rim box, skeleton, HUD)
 Events → audio (swish/thud <100ms), counters, shot log (timestamp = recordedDuration at event)
```

**Budgets:** 33 ms/frame at 30fps analysis. iOS: detector every frame with headroom. Android design target = Snapdragon 7-series: detect every 2–3 frames + Kalman interpolation holds a 30fps UI. Pose runs in a **parallel `runAsync` worklet** so it never blocks ball tracking. Confidence gates: ball >0.3 (relax to 0.15 inside hoop ROI), rim >0.5. **Never analyze at 320px full-frame** — a 20–40px ball loses recall; 640 is the floor. Idle mode: cheap frame-diff + orange-hue gate wakes the detector to save battery/thermals; skip-frame processing under thermal pressure (HomeCourt patent pattern).

**Ball track cleaning gates (from avishah3, reimplemented):** reject detections that jump >4× ball diameter within 5 frames; reject non-round boxes (w×1.4 < h) except when blurred-streak flag is on; keep 30-frame history; rim "moves" >0.5× its diagonal in 5 frames are rejected.

---

## 3. Make/Miss Algorithm Spec

Three-signal fusion (geometry + net motion + learned class), per the HomeCourt patent recipe and open-source consensus:

```
SETUP (once per session):
  rim = detect(class=rim); user confirms/adjusts via tap (AR box)
  rim_plane_y   = rim.cy - 0.5*rim.h
  rim_span      = [rim.cx - 0.4*rim.w, rim.cx + 0.4*rim.w]   # central 80%
  up_zone       = box(width=4*rim.w, height=2*rim.h, above rim_plane_y)
  below_line    = rim.cy + 0.5*rim.h
  net_roi       = box(rim.w wide, 1.2*rim.h tall, hanging below rim)

STATE MACHINE:
  IDLE:
    if ball in up_zone and vy < 0 (moving up): state = SHOT_LIVE; t0 = now
       # layup path: if person bbox overlaps hoop ROI when ball appears
       # above rim, enter SHOT_LIVE without the up_zone requirement
  SHOT_LIVE:
    rim_bounce = true if ball re-ascends above rim_plane_y after touching rim region
    if ball.y > below_line:                    resolve()
    if now - t0 > 1.5s and ball lost:          resolve()   # occluded case
  RESOLVE:
    # Signal 1 — geometric crossing test
    p_above = last ball point with y < rim_plane_y
    p_below = first ball point with y > rim_plane_y
    x_cross = interpolate_x(p_above, p_below, at y = rim_plane_y)
    geo_make = rim_span[0] < x_cross < rim_span[1]           # + ~10px rebound buffer
    # Signal 2 — net motion burst
    net_make = motion_score(net_roi, within 10 frames of crossing) > T
               (T *= 1.5 if rim_bounce)                       # patent-style adaptive
    # Signal 3 — learned appearance
    cls_make = any 'ball-in-basket' detection fired during SHOT_LIVE (conf > 0.35)

    MAKE  if (geo_make and net_make) or (net_make and cls_make)
          or (cls_make and ball occluded at rim)              # layups/dunks
    MISS  if ball below rim with x_cross outside span, or crossing w/o net motion
    UNSURE otherwise → surface third state in UI, one-tap user correction

  cooldowns: 1.5s between shot attempts, 2.0s between scored baskets (SwishAI)
  single-ball, single-hoop lock for the whole session
```

**Overlay parabola:** fit `y = a·x² + b·x + c` to buffered points (draw only, never judge); backtrack in reverse time to reconstruct full arc after occlusion. **Entry angle** = arctan of trajectory slope at rim plane (feeds form feedback, graded vs Noah's 45°/11″). Target accuracy: ~95% on jump shots with good placement; layups/rim-rattlers are the explicit hard bucket handled by the classifier + adaptive net threshold. Netless hoops degrade gracefully to geometry+classifier (warn user during setup). **Do a freedom-to-operate skim of NEX patents US11810321/US10748376 before US launch.**

---

## 4. Form-Analysis Metrics (BlazePose landmarks) + Coaching Rules

One-Euro filter on all landmarks; metrics computed **only at key frames** detected by a phase state machine: *pickup → dip → rise → release → follow-through*. Release frame = ball leaves wrist proximity with upward velocity (fuse ball detector + pose).

| Metric | Formula | Coaching rule (hard-coded) |
|---|---|---|
| Set-point elbow angle | angle(shoulder, elbow, wrist) at dip/set-point | Target 75–90°; flag <60° or >100° |
| Knee flexion | angle(hip, knee, ankle) at deepest dip | Band 100–130° (FT avg 122.6°); flag stiff (>150°) or over-deep (<95°) |
| Release angle | slope of **ball trajectory** in first ~5 frames post-release (NOT pose) | 45–55° good (proficient shooters 52.8–54.2°); flag <45 "add arc", >58 "flatten slightly" |
| Entry angle | trajectory slope at rim plane | Noah standard: 43–47° optimal (45° = 96% FT skill band) |
| Release time | t(release) − t(ball pickup/catch) — HomeCourt's definition | Bins: <0.4s elite, 0.4–0.54 NBA-avg, 0.55–0.7 good, 0.7–1.0 typical, >1.0 slow |
| Follow-through | elbow extension ≥155° held ≥0.3s after release AND wrist above eye line | Flag if elbow collapses <155° within 0.3s: "hold your follow-through" |
| Release height | wrist world-landmark y at release (or px calibrated by user height) | Higher is better; track trend, no absolute flag |
| Jump height | **calibrated hip displacement in px** (user height calibration) — NOT flight time at 30fps (needs 240fps) | Informational; correlate with FG% |
| Consistency | std-dev of release angle & release time across session | Flag σ(release angle) >4°: "consistency over power" |

**Descoped:** guide-hand thumb-flick (needs 21-pt hand model — won't run alongside everything at 30fps) and elbow flare from a single side view (unreliable without 3D or a front view).

**Coaching engine:** deterministic rule engine, fully on-device, **one-cue-at-a-time** prioritization (worst-deviation metric wins), templated plain-language tips, per-shot numeric chips like HomeCourt (numbers over video, not paragraphs). Optional v3: cloud LLM session-narrative + drill plan ("AI Coach").

---

## 5. Recording / Clips Architecture

1. **Continuous master recording** via V5 persistent Recorder (`enablePersistentRecorder`): 1080p, h265, targetBitRate 5–6 Mbps (~2.5 GB/hr), written to app cache dir. Frame output stays small (preview-sized buffers) so recording is full-res while ML is cheap.
2. **Event log:** at every resolved shot, store `offset = recorder.recordedDuration` (or `frame.timestamp − firstRecordedFrame.timestamp`). Never `Date.now()`.
3. **Session end (foreground):** for each make, passthrough-trim `[t−6s, t+2s]` (padding absorbs GOP/keyframe snapping, typical 1–2s) via react-native-media-toolkit → save to Photos/MediaStore → delete master if "keep makes only". Sub-second per clip, no re-encode. Android long exports: foreground service/WorkManager; iOS: finish before backgrounding (~30s grace only).
4. **Overlays:** live trajectory/skeleton are preview-only (VisionCamera limitation). Clips are clean in v1; v2 adds an optional re-encode composite pass (stat-overlay watermark for shareable clips — Ball AI's viral-branding trick).
5. **No ring buffer in v1.** If pre-event capture is ever needed: grafika CircularEncoder pattern (Android) / AVAssetWriter fMP4 segments (iOS) as a custom Nitro module.
6. **Regression-test recording quality with inference ON** (vision-camera #3147: heavy sync inference can drop frames in the *recorded* file — mitigate with runAsync + throttling).

---

## 6. Screens + Design Language

**Design language — dark-first "broadcast":** coal-black canvas (#0F0F0F), one hot orange accent (#FC4C02-class, reads "basketball"), heavy condensed display face (Barlow Condensed/Archivo class) with **tabular lining figures at 100pt+** (glanceable from 20 ft — ~1″ glyph height per 10 ft), Inter/SF body, green dot = make / red X = miss (**always color + shape** for colorblind safety), glassmorphic HUD chips over camera feed. **Sound is the primary courtside channel:** bright swish chime (<100ms) vs short neutral thud; streak escalation at 3/5/10 (rising pitch, flame icon, crowd stinger); misses never punished. Haptics only for phone-in-hand moments. **AI transparency everywhere:** show what the model sees (rim box, ball trail, skeleton) and let the user fix it.

**12 screens:**
1. Onboarding carousel — real demo footage *before* signup
2. Player profile (height for calibration, level, rim/court type)
3. Home dashboard (last session card, streak, FG% sparkline, big Start CTA)
4. **Camera setup & calibration** — live AR rim box, auto-detect + manual nudge, checklist (rim visible / player fully in frame / lighting / angle 30–60° off backboard, 15–30 ft side view), tripod vs leaned-against-bottle mode with honest feature-tier messaging
5. **Live session HUD** — giant makes/attempts/FG% strip, trajectory trail, last-shot flash, streak flame, entry-angle readout, voice-announcement metric selector, REC dot
6. Per-shot result card — mini trajectory, release angle/time, **one-tap make↔miss correction** (trust-critical)
7. Session summary — hero FG% numeral → shot chart → best streak → share card
8. Shot chart detail — scatter (dot/X) / zone / hexbin toggle (zone default; hexbin for 100+ shots), filters, **tap-dot-to-open-clip**
9. Form analysis — skeleton on slow-mo, key-frame metrics, side-by-side compare, max 2–3 tips
10. Video reel — auto-kept make clips, export with stat overlay
11. Progress/trends — FG% + arc over weeks, per-zone deltas
12. Settings — sounds/voice metric, video retention (all / makes only / none)

**Retention loop:** session end → hero stats → tap chart dot → jump to that clip with overlays → swipe shots → correct → share. Market note: HomeCourt abandoned (Jan 2022), all serious competitors iOS-only — **Android is an empty market**; undercut Ball AI's $9.99/mo.

---

## 7. Model Acquisition Plan

**Detector (ball, rim, ball-in-basket — 3 classes):**
1. Data: Roboflow Universe CC BY 4.0 (commercial OK w/ attribution) — "Basketball and rim" 6.3k images (base), "Basketball Detection" sskux ~10k aggregate, basketball-player-detection-3 (654 imgs, has ball-in-basket + rim). Verify licenses in browser (site 403s scripts).
2. Augment: motion-blur augmentation heavily; label blurred streaks as ball; add outdoor/indoor/lighting variety.
3. Train RF-DETR Nano (Apache-2.0), 640×640; prototype-benchmark against YOLO11n privately to sanity-check accuracy.
4. Export: **CoreML FP16** (.mlpackage, ANE) for iOS via RF-DETR's official path; **TFLite FP16** for Android GPU delegate (GPU delegate can't run int8; int8+QAT only if we later go QNN/NPU via Qualcomm AI Hub). Pin LiteRT versions (known Ultralytics-export GPU-delegate crash history — test week 1).
5. Build our own labeled benchmark: 200+ shot clips (makes/misses/layups/rim-rattlers, indoor+outdoor) — public repos' "95–97%" claims are on 25–67 shots.

**Pose:** MediaPipe Pose Landmarker FULL float16 — download official .task/TFLite models, no training. MoveNet Lightning int8 as low-end fallback. **Code references:** josephattalla (MIT, rim-crossing logic + weights) and Ed-Zh (MIT, MediaPipe joint math) are the only repos we may copy from; everything else (avishah3, chonyy, SwishAI) is ideas-only.

---

## 8. Phased Build Plan

**Phase 1 — MVP, Android-first from Windows (weeks 1–5):**
- Week 1 (de-risk): Expo dev-client + VisionCamera V5 on a real mid-range Android device; verify concurrent VideoOutput+FrameOutput; benchmark nitro-tflite GPU delegate with a stock model at 640px; measure ms/frame. **Go/no-go on V5 vs V4-snapshot.**
- Weeks 1–2 (parallel): train detector on Roboflow data (desktop GPU/Colab); export TFLite FP16; build the labeled benchmark set.
- Weeks 2–4: ball tracker (Kalman + cleaning gates), rim lock + tap-confirm setup, shot FSM, geometric make/miss + net-motion ROI, Skia trajectory overlay, make/miss sounds, live HUD counters, SQLite shot log, session summary with scatter shot chart, one-tap correction.
- Week 5: continuous recording + event offsets + session-end passthrough clip extraction ("keep makes only"). **Ship as private Android beta.**
- iOS path: EAS cloud builds throughout (CoreML export of same model); TestFlight at end of Phase 1 — no Mac needed.

**Phase 2 (weeks 6–10):** BlazePose form analysis (phase FSM, key-frame metrics, rule-engine tips, skeleton slow-mo), ball-in-basket class fusion + layup handling, zone/hexbin charts + tap-to-clip, voice announcements + streak celebrations, progress/trends, premium visual polish (design tokens per §6), iOS parity pass + device-tier gating (post-process on old phones).

**Phase 3 (weeks 11+):** share cards + stat-overlay clip export (re-encode composite), leaned-phone degraded mode coach, freemium paywall, optional cloud LLM session coach, RTMPose accuracy upgrade evaluation, drills/challenges gamification, multi-session leaderboards.

---

## 9. Top 10 Risks & Mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Mid-range Android can't hold 30fps** (GPU delegate 25–45ms at 640) | Detect every 2–3 frames + Kalman interpolation + 320px ROI re-detect; week-1 benchmark on Snapdragon 7-series is the go/no-go gate; MoveNet/lite fallbacks per device tier. |
| 2 | **Motion blur kills ball detection at release/rim** | 60fps capture + locked short exposure; blur-augmented training; ByteTrack low-conf rescue; parabola fit means make/miss never needs every frame; frame-diff motion channel if needed. |
| 3 | **AGPL contamination (Ultralytics code/weights)** | Ship RF-DETR Nano (Apache-2.0); use Ultralytics only in private prototyping; audit deps; MIT-only code reuse (josephattalla, Ed-Zh). |
| 4 | **Single-camera depth ambiguity (front-rim brick looks like a make head-on)** | Enforce 30–60° side placement in guided setup; net-motion fusion resolves occluded cases; surface "unsure" + one-tap correction instead of guessing. |
| 5 | **Heavy inference drops frames in the recorded video** (vision-camera #3147) | runAsync everything, small frame-output buffers, throttled pose fps; regression-test recording with inference on, every release. |
| 6 | **V5 plugin ecosystem gaps** (fast-tflite V5 integration sponsor-gated) | react-native-nitro-tflite; documented V4-snapshot fallback; week-1 spike decides. |
| 7 | **Layups/dunks/putbacks miscounted** (no parabola, release at rim — HomeCourt's known flaw) | ball-in-basket class as primary signal when person overlaps hoop ROI; explicit hard-bucket in benchmark; honest UX (correction affordance). |
| 8 | **NEX/HomeCourt patents (net-motion make/miss, US11810321)** | Freedom-to-operate review before US launch; our fusion differs (learned class primary for occlusion); design-around options exist (classifier-first). |
| 9 | **Thermals/battery on long sessions** | Idle mode (frame-diff wake), skip-frame under thermal pressure, h265 5–6 Mbps, 720p analysis stream; net-ROI diff <1ms. |
| 10 | **Accuracy claims don't survive reality** (public repos tested on ≤67 shots) | Build 200+ clip labeled benchmark in week 1–2; CI accuracy gate; low-light note: some Androids auto-throttle to 15fps in dim gyms (#2838) — detect and warn in setup. |

**Bottom line:** React Native + VisionCamera V5 + RF-DETR Nano (FP16 CoreML/TFLite) + BlazePose + Skia, three-signal make/miss fusion, continuous-record-then-trim clips, dark broadcast UI — Android beta in ~5 weeks from a Windows machine, iOS via EAS/TestFlight with zero local Mac dependency.