# Quality Gates — test & regression strategy

**Mission:** the merge gate is `npx tsc --noEmit && npx jest` — **all green, no
exceptions**. The green baseline count lives in
[MASTER-PLAN §0](MASTER-PLAN.md) (quoted: 「基準 629 tests,全綠才能 commit」)
and may only change with a stated reason (see §3 below). Every `src/core`
change requires a unit test — that is a MASTER-PLAN iron rule, not a
suggestion. This page maps each iron rule to the suite(s) that mechanically pin
it, and tells you exactly what you must add when your feature touches a given
seam.

> Cross-reference: [INTEGRATION-REVIEW.md](INTEGRATION-REVIEW.md) (the 4-lens
> post-merge review — runs *after* this gate is green) and
> [SMOKE-CHECKLIST.md](SMOKE-CHECKLIST.md) (on-device verification — the only
> coverage for worklet/camera/Skia code, see §4).

---

## 1. Iron-rule → suite map

Every row is a rule bought with a real incident. If your diff makes one of
these suites fail, the suite is right and your diff is wrong until you can
argue otherwise in the commit body. All paths relative to `src/`.

| Iron rule | Guarding suites | Notes |
|---|---|---|
| **Bread-ball guarantee** — fuse truth table: with net available, cls may only contribute to a make by *agreeing* with net; net=false + cls + occluded ⇒ unsure; geo=false ⇒ always miss | `core/__tests__/fuse.test.ts`, `core/__tests__/shotFsm.test.ts`, `core/__tests__/depthRatioGate.test.ts` | `fuse.test.ts` is a **PINNED** truth table — editing `fuse()` requires deliberately editing this table row-by-row. `shotFsm.test.ts` covers pass-through demotion, wedged-ball, putback/basket-cooldown. Depth-ratio veto is one-directional: make→miss only, never miss→make. |
| **Corroborators upgrade geo `null`→`true` only**, only with net/cls agreement; nothing may ever flip geo=`false` | `core/__tests__/shotFsm.test.ts`, `core/__tests__/reappearance.test.ts`, `core/__tests__/geoExit.test.ts` | shotFsm pins virtual-cross never-alone and real-crossing preference over projection. |
| **Net burst forward-only grace** / inclusive window boundary | `core/__tests__/netBurst.test.ts` | Grace extends the window forward only; it never rewrites the past. |
| **30 fps byte-identity** + gates only *loosen* at low fps (sample floors clamp ≥ 3) | `core/__tests__/shotFsmLowFps.test.ts`, `core/__tests__/ballTrackerLowFps.test.ts`, `core/__tests__/trajectoryLowFps.test.ts`, `core/__tests__/reappearanceLowFps.test.ts`, `core/__tests__/ironRules.invariants.test.ts` (NEW) | The lowFps suites run the 8/12/15/24/30 fps matrix incl. the "never a false call at 8 fps" invariant; the invariants suite pins the `scaleFrameGate` math itself (byte-identity at `NOMINAL_FPS`, clamp ≤ nominal, floor at min). See [DEVICE-SCENARIO-MATRIX §2](DEVICE-SCENARIO-MATRIX.md). |
| **Parser transpose-garbage guard** — raw box count > 5 % of anchors ⇒ garbage layout, pick the other; both garbage ⇒ corrupt; sticky `prevLayout`; rawHead decode | `ml/__tests__/yoloParser.test.ts` | This guard *is* the fix for the "iPhone 一堆爛框" incident — do not weaken it. |
| **Letterbox cull** — contain-mode bars culled; same-array identity when nothing is culled | `ml/__tests__/letterboxCull.test.ts` | Identity check keeps the hot path allocation-free. |
| **Motion candidate is continuation-only** — synthetic score 0.13 sits *between* the 0.12 tracking gate and the 0.2 cold gate | `ml/__tests__/motionCandidate.test.ts`, `core/__tests__/ironRules.invariants.test.ts` (NEW) | The invariants suite asserts the 0.12 < 0.13 < 0.2 *ordering*, not just the values — motion can continue a jump-gate-vetted track, never start one. |
| **ROI second pass contributes `'ball'` ONLY** — never `ball_in_basket` (would fabricate makes) | **NO unit coverage** — worklet code in `src/camera/useShotEngine.ts` (~1291–1299) | Guarded by [INTEGRATION-REVIEW Lens 3](INTEGRATION-REVIEW.md) grep check + [SMOKE-CHECKLIST S5](SMOKE-CHECKLIST.md). Treat any change near the ROI merge as high-risk. |
| **Recheck replays the conservative baseline** — `ShotFsm` constructor flags default `false` | `core/__tests__/recheck.test.ts`, `core/__tests__/ironRules.invariants.test.ts` (NEW) | recheck.test is behavioral; the invariants suite pins the flag defaults directly so a "helpful" default flip cannot slip in silently. |
| **Calibration refines distance only, never gates** — reject ⇒ byte-identical default path | `core/__tests__/ftCalibration.test.ts`, `core/__tests__/courtGeometric.test.ts`, `core/__tests__/courtCalibration.test.ts`, `core/__tests__/courtRegistration.test.ts`, `core/__tests__/threePointLine.test.ts`, `core/__tests__/courtHomography.test.ts` | A failed/rejected calibration must leave outputs byte-identical to the uncalibrated path — no partial application. |
| **Coach never fabricates** — every claim is measured-with-units evidence; personalization shifts emphasis only, never invents data | `core/__tests__/coachEngine.test.ts`, `core/__tests__/coachPersonalize.test.ts`, `core/__tests__/weeklyReport.test.ts`, `core/__tests__/weeklyAssignment.test.ts` | Rules stay silent under their min-sample thresholds — see §2. |
| **Drills remain `spotShooting` ModeState**; `'unsure'` is a non-event (advances nothing, penalizes nothing) | `core/__tests__/drills.test.ts`, `core/__tests__/gameModes.test.ts` | |
| **`corrected` vs `outcomeCorrected` semantics** — a value fix (arc, position) never stamps `outcomeCorrected` | `core/__tests__/db.test.ts`, `core/__tests__/hardExamples.test.ts` | `outcomeCorrected` feeds the hard-example flywheel; polluting it poisons training data. |
| **Core purity** — no wall clock / RNG / timers in `src/core` + `src/ml`; no module-level `let`/`var` in `src/ml` (worklet-capture crash class) | `core/__tests__/purity.static.test.ts` (NEW) | Static fs-scan with an explicit allowlist (starts empty). Time comes from inputs only. |
| **settingsStore persist migration chain** (currently v5) | `state/__tests__/settingsMigration.test.ts` (NEW) | Pins the persist version, replays `migrate()` from every historical version, asserts known backfills, and round-trips `partialize` through JSON. |

---

## 2. New-suite requirements matrix (by seam)

Adding a feature is not done when it works — it is done when the seam it
touched has the test the seam demands.

| If your feature touches… | You MUST add… | Fixture / pattern to copy |
|---|---|---|
| **ShotFsm** (new arm path, signal, or demotion) | Scenario tests in `shotFsm.test.ts` style; one case per fps in the `shotFsmLowFps.test.ts` matrix; an explicit decision (test or written rationale) for the pass-through demotion set. `fuse.test.ts` must **not** need edits — if it does, you changed the truth table: stop and re-read the bread-ball rule. | `rimFromBox` / `arcFrames` fixtures, `G = 900`, rim box `{300, 200, 40, 20}` in `core/__tests__/shotFsm.test.ts`. |
| **FsmFrameInput / FramePayload new field** | Type-level compile coverage; a pure `step()`-harness test if any logic reads the field. | The `releaseEventT` one-shot-latch pattern (consume once, then clear) — do not invent a second latch idiom. |
| **yoloParser / a new model** | Fixture-tensor test incl. garbage-layout rejection *and* both-layout parse; thread any new parse option through **all four** parse call sites. | `ml/__tests__/yoloParser.test.ts`; call-site checklist in [INTEGRATION-REVIEW Lens 1](INTEGRATION-REVIEW.md). |
| **config.ts constant change** | Update the pins in `core/__tests__/ironRules.invariants.test.ts` in the **same commit**, with a one-line rationale. That friction is the point — the pin exists so the change is conscious. | The invariants suite itself. |
| **settingsStore persisted key** | New key: default value in the store (auto-covered by the `partialize` round-trip in `settingsMigration.test.ts`). Rename/backfill: persist version bump + `migrate` branch + a new assertion in `settingsMigration.test.ts`. | `state/__tests__/settingsMigration.test.ts`; kv-store mock pattern in `state/__tests__/challengeStore.test.ts`. |
| **db.ts column** | Additive `user_version` migration test in `db.test.ts` **plus** lock-step assertions across `insertShot` / `shotFromRow` / `importBackup`. The `importBackup` omission was a real prior bug (v8 columns missing from the column list). | Existing migration cases in `core/__tests__/db.test.ts`. |
| **Coach rule** | A `coachEngine.test.ts` case proving the min-sample gate (rule *silent* under threshold) + a severity/strength ranking case. | `core/__tests__/coachEngine.test.ts`. |
| **Drill** | Progression test + JSON serialization round-trip of `DrillState` in `drills.test.ts`. | `core/__tests__/drills.test.ts`. |
| **HUD / worklet code** | **Not unit-testable** (see §4): a mandatory [SMOKE-CHECKLIST](SMOKE-CHECKLIST.md) entry + [INTEGRATION-REVIEW Lens 4](INTEGRATION-REVIEW.md) review. Any pure geometry extracted out of the worklet into `src/` (the `shotSparkline.ts` pattern) **must** be unit-tested. | Extract-then-test; keep the worklet body thin. |

---

## 3. Baseline policy

- The `npx jest` green total is recorded in [MASTER-PLAN §0](MASTER-PLAN.md).
  It may only **increase**, or decrease with an explicit
  `removed suite X because Y` line in the commit body. A silent drop is a
  broken gate.
- CI runs the exact same command as the local gate:
  `npx tsc --noEmit && npx jest`. There is no separate CI configuration to
  drift.
- New suites must be **deterministic**: no wall clock, no network, no device,
  no ordering dependence between test files. If a suite needs "now", it takes
  time as an input — same rule as the core it tests.

---

## 4. What we deliberately do NOT unit test

Stating this explicitly so nobody fakes coverage with brittle mocks:

- **Worklet bodies** (`useShotEngine` frame processor) — no jest environment
  can reproduce worklet capture semantics or the frame-processor runtime; a
  mocked worklet test proves nothing and rots.
- **Skia canvases** (HUD overlays, sparklines, comet/arc rendering).
- **VisionCamera / recording** paths.
- **TFLite delegates** (CPU/GPU selection, real inference latency).

These are covered instead by [SMOKE-CHECKLIST.md](SMOKE-CHECKLIST.md) on a
real device plus the DebugPanel `HOOPILOT DIAG` dump. If a change lives only
in these layers, its verification is a smoke run, not a mock — and the pure
logic it depends on must be extracted into `src/` where it *can* be pinned
(see §2, last row).
