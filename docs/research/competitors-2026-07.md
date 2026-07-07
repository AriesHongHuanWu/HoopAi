# Competitor research — July 2026

21-agent research workflow over the 11 reference videos the founder supplied.
Full raw output lived in the session; this file preserves the actionable core.

## What the videos are

| Video | Product | What it proves |
|---|---|---|
| shorts/EIB4U2xTQqs | **Ball AI** (ballai.app, ~4.7★, 75K+ installs) | Real-time phone shot tracking + rep-by-rep auto-clips; BUT core product is an Apple Watch tracker, iOS 17+, Android waitlisted, free tier shrank to 100 shots/week, and their web portal exposes literal Admin/Annotator/Clipper roles — a human labeling back office |
| shorts/ZPru6jHGnIk | **Level Up: AI Basketball Coach** | CV shot tracking is "coming soon" marketing; shipped AI is a Gemini-powered video-review coach. Leaderboards are honor-system |
| H3nGXVSQww8 | **ShotBot** (shotbot.ai, solo dev, iOS-only, <1k installs) | Ghost-hoop calibration ritual, per-shot composite image (arc + launch angle + result), zone heatmaps; needs bright light + a good net + 20–30ft placement + account; reviews report 6 makes counted as misses |
| 6kDAiDc8Th0 | **Scout AI** (Pivo motorized mount) | Auto-panning game FILMING, not shot detection. Yellow-box-turns-green basket calibration UX is worth stealing |
| MpTQeo6gNOQ, am4jnDCyDno, fb1L5V_qGEI, lacjpBw0ZoU | DIY CV projects (YOLO/MediaPipe genre) | The overlay visual language (boxes, comets, skeletons) IS the wow factor; avishah3's arc-projection trick (self-reported 95–97%, measured ~67% by others) — projection works ONLY as a corroborator |
| vOSbfhEbYAg (CNBC), shorts/1CnV15GvzUk | **HomeCourt** (NEX Team, Apple Design Award, NBA partner) | The gold standard: on-device CV, auto rim detection, shot charts, Shot Science metrics. BUT iOS-only, in maintenance mode since ~2022 (parent pivoted to a console), needs net + tripod + good light, no correction UI (documented complaint) |

## What the user (and the market) admires

1. **Detection you can SEE working** — live overlays, comets, counters burned onto the feed.
2. **Zero-hardware magic** — prop the phone, stats appear, routine never changes.
3. **Auto-generated artifacts** — per-rep clips, composite shot images, instant replays.
4. **Broadcast-grade metrics** — release/entry angle, arc, heatmaps, NBA benchmarks.
5. **A satisfying lock ritual** — ghost hoop → green box → GO.

## Hoopilot's winning position (3 defensible differentiators)

1. **"Shows its work"**: per-shot evidence receipts (geo/net/cls chips + clip), honest
   'unsure', offline audit, published per-condition accuracy. Hardware apps CAN'T,
   subscription incumbents WON'T. Our deterministic replayable FSM makes it nearly free.
2. **Works on real courts**: netless, unmarked, dark, offline, no account, Android AND
   iOS. Every incumbent is structurally locked out of part of this.
3. **Detection-scored solo games + IG-native output, free, on the platform (Android)
   the incumbents abandoned.** Ghost Challenge, auto highlight reel, streak callouts.

## Ranked build list

| # | Item | Cat | Effort | Status |
|---|---|---|---|---|
| 1 | 3A (AF+AE+AWB) lock on rim at rim lock + low-light gate profile | detection | S | **SHIPPED** (48d5f18) — light profile pending |
| 2 | Virtual-crossing corroborator (arc projection, net/cls-gated) | detection | S | **SHIPPED** (48d5f18) |
| 3 | Evidence receipts + swipe-to-correct | differentiator | S | task #12 |
| 4 | Ghost-rim guided placement + live quality grade | ux | M | task #13 |
| 5 | Offline re-analysis of unsure windows ("re-checked N, corrected M") | detection | M | task #9 |
| 6 | One-tap highlight reel + story end card | differentiator | M | task #14 |
| 7 | Last-shot micro-replay toast on live HUD | ux | M | task #15 |
| 8 | Pose-gated release detection (4th arm path) | detection | M | task #16 |
| 9 | Correction data flywheel → training hard examples | detection | M | backlog |
| 10 | Ghost Challenge mode (race your last session) | differentiator | M | backlog |

Loading experience (boot intro, Home stagger, AI warm-up state) shipped alongside
rank 1–2 in 48d5f18.
