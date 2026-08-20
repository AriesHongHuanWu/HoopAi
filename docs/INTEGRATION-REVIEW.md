# 4-Lens Integration Review

Codifies MASTER-PLAN §0 iron rule 9: **run a 4-lens integration review after every
multi-agent wave merge, before release.** A 15-agent two-wave merge once shipped 16
integration bugs — every check below is descended from one of them.

**When:** after every multi-agent wave merge, before release.

**How:** `npx tsc --noEmit && npx jest` must be green FIRST — a red gate means *fix*,
not *review*. Then spawn one reviewer agent per lens over the full merged diff
(`git diff <base>..HEAD`). Each reviewer returns findings as `file:line` + severity
(**blocker** / **major** / **minor**). Triage every blocker before tagging a release.

Line numbers below are anchors, approximately correct at time of writing — grep for the
symbol if the file has shifted. All grep commands run in Git Bash from the repo root.

---

## Lens 1 — Contract drift (types & shapes across seams)

Multi-agent merges love to update a shape at ONE of its sites and forget the others.
Every check here is "declared in N places — are all N updated?"

| # | Check | How to verify |
|---|-------|---------------|
| 1 | Every new `FramePayload` field is BOTH declared (`src/pipeline/shotPipeline.ts:56`) AND populated in the worklet payload build — the `scheduleOnRN(onPayload, {...})` object literal in `src/camera/useShotEngine.ts` (~L1463). A declared-but-never-populated field silently reads `undefined` downstream. | `grep -n -A 15 "interface FramePayload" src/pipeline/shotPipeline.ts` then `grep -n -A 12 "scheduleOnRN(onPayload" src/camera/useShotEngine.ts` — diff the key lists. |
| 2 | Every new `OverlayState` field has a matching `EMPTY_OVERLAY` default (`src/camera/useShotEngine.ts` — interface ~L119, defaults ~L181). A missing default crashes worklet guards on the first frame before the pipeline publishes. | `grep -n -A 60 "interface OverlayState" src/camera/useShotEngine.ts` vs `grep -n -A 60 "EMPTY_OVERLAY" src/camera/useShotEngine.ts` — key lists must match 1:1. |
| 3 | Every new `PipelineFrameState` field is published in the pipeline `onFrame` → written into the overlay SharedValue → consumed with a null-guard in the Skia overlays (`TrajectoryOverlay` / `DetectionBoxes` `useDerivedValue` worklets). All three hops or the field is dead weight (or a worklet crash). | Trace the field name: `grep -rn "<fieldName>" src/pipeline src/camera src/components/hud` |
| 4 | New `FsmFrameInput` fields follow the `releaseEventT` pattern: **optional**, delivered **once** on the firing frame, **latched** inside the FSM (see `shotFsm.ts:174` and the one-shot delivery at `shotPipeline.ts:516`). A field re-delivered every frame re-triggers whatever it latches. | Read the diff at the payload-build site: is the new field wrapped in a fire-once conditional like `...(cond ? { field } : {})`, and cleared after delivery? |
| 5 | New `ResolvedShot` fields are optional, ride the spread pattern (`...(x ? { x } : {})` at `shotFsm.ts` ~L1020–1036 or pipeline enrichment `shotPipeline.ts` ~L687–798), AND appear in **all** of: `src/core/types.ts`, `db.ts` `insertShot` column list (~L475), `shotFromRow` (~L658), and the `importBackup` INSERT (~L702). The v8-columns omission in `importBackup` was a real shipped bug — check `importBackup` explicitly, it is always the forgotten one. | `grep -n "insertShot\|shotFromRow\|importBackup" src/data/db.ts` then read each column list against the new field. |
| 6 | New `parseYoloOutput` options are threaded to **all four** call sites: primary inference (`useShotEngine.ts` ~L1147), ROI second pass (~L1285), the delegate smoke test (~L518), and the Test AI screen (`src/camera/detectImage.ts` ~L267). An option set at one site and not the others means live and Test AI disagree. | `grep -rn "parseYoloOutput(" src/ --include="*.ts" \| grep -v __tests__` — exactly 5 hits: the definition in `src/ml/yoloParser.ts` + the 4 call sites; check the opts object at each call site. |
| 7 | `src/camera/detectImage.ts` `resolveDetectorConfig()` (~L70) still mirrors the live loader's model/engine/input-size resolution for any model or engine change. The Test AI screen must not lie about what the live pipeline runs. | Diff `resolveDetectorConfig` against the model-selection logic in the `useShotEngine.ts` load effect (~L381). |

---

## Lens 2 — Shared-seam collisions (files multiple features touch)

Git auto-merge resolves *textual* conflicts; it hides *semantic* ones. These are the
files every wave touches.

| # | Check | How to verify |
|---|-------|---------------|
| 1 | `src/state/settingsStore.ts`: every new key has a default; the persist `version` (~L423) is bumped **iff** a key was renamed/removed or needs a backfill (a plain new key with a default needs NO bump); `src/state/__tests__/settingsMigration.test.ts` pin is updated in the SAME merge; `TRACKING_PRESETS` (~L101) and `partialize` (~L416) stay consistent with the new keys. | `git diff <base>..HEAD -- src/state/settingsStore.ts src/state/__tests__/settingsMigration.test.ts` — a version bump without a test update (or vice versa) is a blocker. |
| 2 | `src/data/db.ts`: the `user_version` chain stays strictly additive and monotonic — one `if (version < N)` block per feature, **no duplicate N across features** (THE classic wave collision: two agents both claim v9). `insertShot` / `ShotRow` / `shotFromRow` / `importBackup` updated in lock-step. New aggregate scans use the narrow `sessionShotOutcomes` (~L645), not full `sessionShots` (blob columns). | `grep -n "user_version = " src/data/db.ts` — versions must be a strictly increasing sequence with no repeats. |
| 3 | `src/pipeline/shotPipeline.ts`: new setters follow the right scope — session-scoped state rides `adoptRim` (~L895) / session reset, immediate toggles take effect on the next frame. The shot-value priority chain order is preserved: **court > metric > heuristic, manual override LAST** (~L739–770). Enrichment happens BEFORE `events.onShot` fires (~L797) — a field attached after the callback never reaches the DB. | Read the diff around L687–798; confirm no new code runs after `this.events.onShot?.(resolved)`. |
| 4 | `src/app/session/live.tsx`: layer order preserved (camera → `TrajectoryOverlay` → debug `DetectionBoxes` → aiming → `CoachMarks` → `ShotFlash` → top HUD → `DrillOverlay` → bottom bar → sheets, ~L571–686). No new per-frame React state — SharedValues are polled at ≤5 Hz with change-gated setState. New exit paths set `ending` or use `router.replace`. Tick-driven mode logic still excludes calibration chips. | Read the JSX diff top-to-bottom; `grep -n "setInterval\|useState" src/app/session/live.tsx` and audit anything new. |
| 5 | `src/app/(tabs)/coach.tsx`: new cards get their data from `useCoachSessions` (~L297) — no parallel session loaders. Finding keys stay unique (single-shot rules fire once). Router pushes use typed literal routes. | Read the diff; `grep -n "router.push" "src/app/(tabs)/coach.tsx"` — every argument is a string literal. |
| 6 | `src/camera/useShotEngine.ts`: the model load-effect dependency list (~L546: `[detectorModel, perfMode, detInputSize, forceCpu, useYolox, detectorAccel, nanoV2]`) includes every setting the load/attempts chain reads. New worklet-read settings are captured consts (frame processor re-registers on change) or SharedValues — **never refs**. Boxed models ride SharedValues. | Compare the effect body's setting reads against its dep array; `grep -n "useRef" src/camera/useShotEngine.ts` and confirm none are read inside a `'worklet'` block. |
| 7 | Any file two features both touched: read both feature diffs side-by-side for semantic conflicts auto-merge hides — e.g. both appending to the same switch/array, both consuming the same one-shot event, both bumping the same version. | `git log --oneline <base>..HEAD -- <file>` per shared file; if >1 feature, manual side-by-side. |

---

## Lens 3 — Iron-rule audit (product safety)

These rules are the product. A violation here is automatically a **blocker**.

| # | Check | How to verify |
|---|-------|---------------|
| 1 | **Bread-ball guarantee**: any NEW code path that can produce outcome `'make'` must show its corroboration — net/cls agreement or a fully real geometric crossing. Nothing new injects `ball_in_basket`, flips geo `false`→`true`, or mints/upgrades a make without net/cls agreement. | `grep -rn "'make'" src/core src/pipeline --include="*.ts" \| grep -v __tests__` — justify every occurrence that is new in the diff. |
| 2 | **ROI contributes 'ball' only**: the ROI merge block (`useShotEngine.ts` ~L1285–1331) must only DROP `ball_in_basket` from ROI results, never push it into the merged detections (an injected `ball_in_basket` fabricates a make). | `grep -n "ball_in_basket" src/camera/useShotEngine.ts` — every hit in the ROI block is a filter/skip, none is a push. |
| 3 | **Visual/judgment separation**: `fsm.step` still consumes the raw tracker ball BEFORE any `displayBall`/arc-snap smoothing; nothing arc-derived (`fullFlightPath`, corridor, landing point) feeds make/miss or arming. Overlays never arm or judge. | `grep -rn "fullFlightPath\|displayBall" src/core src/pipeline` — no hit inside FSM decision logic; confirm step-input ordering in the pipeline diff. |
| 4 | **fps honesty**: every new frame-COUNT gate routes through `scaleFrameGate(nominal, dt, min)`; every new time window uses `GATE_EPS_SEC`. Hard-coded integer frame comparisons silently tighten at low fps. | `grep -rn "scaleFrameGate" src/core src/pipeline` then eyeball every new integer-frame comparison in the diff for a missing scale. |
| 5 | **Recheck baseline**: recheck must run the conservative baseline — `ShotFsm` constructor default flags stay `false` and `recheck.ts:277` still constructs with default opts (`new ShotFsm(rim, {...frame size...})`, no feature flags). `ironRules.invariants.test.ts` green covers the defaults; confirm the call site by eye. | `grep -n "new ShotFsm" src/core/recheck.ts` |
| 6 | **Read-only files untouched**: `src/constants/tokens.ts` and `src/components/ui.tsx` have zero diff. Dark broadcast theme only — no light theme anywhere. | `git diff <base>..HEAD --stat -- src/constants/tokens.ts src/components/ui.tsx` must print nothing. |
| 7 | **No new native deps**: `package.json` diff shows no new dependencies (CI iOS took 9 attempts to stabilize; Skia 2.6.2 / Reanimated 4.5 pinned; expo-gl deliberately absent). | `git diff <base>..HEAD -- package.json` must print nothing (or doc-irrelevant script changes only, which still need sign-off). |
| 8 | **Tab-nav rules**: 5 tab roots only; new screens are registered in the root Stack and push OVER the tab bar; no back buttons on tab roots; `router.push` uses typed routes — string literals or the established template-literal pattern for typed dynamic routes (`` `/history/${id}` ``). | `git diff <base>..HEAD -- "src/app/(tabs)" src/app/_layout.tsx` + `grep -rn "router.push(" src/app \| grep -v "'/"` — NEW hits beyond the baseline template-literal pushes need justification. |
| 9 | **Honesty UI**: no fake AR/3D claims; `est.` labels preserved on NBA-comparison data; machine-made corrections pass `corrected=false` (only user swipes set `corrected=true`). | `grep -rn "corrected" src/data src/app \| grep -v __tests__` — audit new write sites. |

---

## Lens 4 — Worklet & performance discipline

The frame processor runs ~30×/sec on a phone that is also encoding video. One sloppy
merge here shows up as thermal throttling or a dead frame pipeline, not a red test.

| # | Check | How to verify |
|---|-------|---------------|
| 1 | New worklet code: `'worklet'` directive present; helper worklets declared BEFORE the worklets that call them (Babel captures eagerly — declaration order matters); no closure over mutable JS state (use a SharedValue instead — a captured `let` is frozen at registration); no throw escapes the frame wrapper (an uncaught worklet throw kills frame delivery for the session). | Read every new `'worklet'` block in the diff; `grep -n "'worklet'" src/camera/useShotEngine.ts` and check each new one for outer-scope reads that are not SharedValues or captured consts. |
| 2 | Buffers: any resizer output is fully READ before the `finally` that disposes it; every new GPU/ArrayBuffer resource is disposed in a `finally`. | Read the diff around each new `runSync`/resize call — read-then-dispose order. |
| 3 | Timing pollution: any new secondary inference (ROI-style) feeds its OWN ms EMA (pattern: `avgRoiMs`, `useShotEngine.ts` ~L1284), never `avgInferMs` — the frame gate and thermal governor read `avgInferMs`, and polluting it halves the effective fps. | `grep -n "avgInferMs" src/camera/useShotEngine.ts` — only the primary inference writes it. |
| 4 | React side: SharedValue consumers poll at 3–5 Hz with change-gated setState; no per-frame `setState` anywhere on the live screen. | `grep -n "setInterval" src/app/session/live.tsx src/components/hud/*.tsx` — intervals ≥200ms; audit new `useState` writes. |
| 5 | Allocation: per-frame paths stay allocation-light (no fresh arrays/objects per frame where a reused buffer works); ring buffers capped following the existing patterns (`MAX_TRAJ_SAMPLES = 48`, `PRE_ARM_MAX = 32` in `shotFsm.ts`; `FLIGHT.maxFlightSamples = 64` in `config.ts`). | Read new per-frame code in the diff for `new`/`[...]`/`.map(` in hot loops; every new unbounded `push` needs a cap. |
| 6 | Reduced motion: every new animation checks `useReducedMotion`; celebration/particle layers stay `pointerEvents="none"`; particle budgets respected. | `grep -rn "useReducedMotion" src/app src/components` — every new Animated entrance/celebration file appears in the list. |
| 7 | DB on hot paths: no full `sessionShots` (blob-column) scans inside focus effects or per-tick code; use the narrow readers (`sessionShotOutcomes` pattern, `db.ts` ~L645). | `grep -rn "sessionShots(" src/app` — new call sites must not sit in `useFocusEffect`/interval bodies. |

---

## Run protocol (copy-paste for the integrator)

1. Merge all feature worktrees/branches into the integration branch.
2. `npx tsc --noEmit && npx jest` — must be green. Record the total test count for the
   MASTER-PLAN §0 baseline refresh.
3. Spawn 4 reviewer agents, one lens each. Brief = that lens's section of this doc +
   the full merged diff (`git diff <base>..HEAD`). Each returns findings as
   `file:line` + severity (blocker/major/minor).
4. Collect findings, fix all blockers (and majors where cheap), re-run the gate from
   step 2.
5. Update MASTER-PLAN §4 rows to ✅ with the merge hash.
6. Hand `docs/SMOKE-CHECKLIST.md` to the user for on-device verification.
7. Release only after sections S0–S5 of the smoke checklist pass on a real device.
