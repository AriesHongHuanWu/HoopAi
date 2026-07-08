# Device × Scenario matrix

**Mission:** judge trajectory + makes accurately on every supported phone down
to an iPhone XR, whose detector runs at only **8–15 fps**. An arc at 8 fps has
~6 samples; its scoring transit at the rim can be **one** sample. This page maps
the three device tiers against the scenarios we ship into, states which
detection paths carry the make/miss call in each cell, and marks whether the
cell is **measured** on real clips or still **assumed** (needs flywheel data).

> Cross-reference: [MASTER-PLAN §5 精準度階梯](MASTER-PLAN.md#§5-精準度階梯擴充版).

---

## 1. Device tiers

Tiers are classified in `src/core/deviceProfile.ts` (model string → generation,
`deviceYearClass` + RAM fallback, and a runtime inference-ms benchmark that can
only ever *lower* the tier) and tuned in `src/camera/deviceTuning.ts`.

| Tier | Example phones | Detector rung | Input | Delegate | Expected detection fps |
|---|---|---|---|---|---|
| **entry** | iPhone XR/XS/X/8 (A12↓), old Android | Nano | 416 | CPU | **8–15 fps** |
| **mid** | iPhone 11/12/SE2 (A13–A14), 2019+ Android ≥4 GB | auto (Nano↔Tiny by ms budget) | 416 | GPU | **15–24 fps** |
| **high** | iPhone 13+ (A15+), 2021+ Android ≥6 GB | Tiny | 416 | GPU | **24–30+ fps** |

The **entry tier at 8 fps is the design floor**. Everything below is written so
the *make/miss outcome* is invariant across tiers; only metric *precision*
(entry/release-angle baselines, rim-bounce detection) degrades gracefully.

---

## 2. Why low fps is dangerous — and what was hardened

Any decision-core gate written as "N frames" silently changes its **wall-clock**
meaning as fps drops (5 frames = 167 ms at 30 fps but **625 ms** at 8 fps). The
audit (below) converted every frame-count gate to a **time budget** re-derived
from each consumer's own measured sample interval (an internal EMA — no new
plumbing). By construction, **at 30 fps every gate reproduces its original
integer frame count, so 30 fps behaviour is byte-identical** and only slower
devices see the fix. Sample-count *floors* (arc fits) are fps-scaled but never
drop below **3** — the minimum that determines a quadratic.

### Audit table (decision-core constants)

| Constant / gate | File | Kind | 8 fps verdict | Fix |
|---|---|---|---|---|
| `TRACKER.jumpWindowFrames = 5` (flight-continuation floor + jump-gate release) | ballTracker | frame-count | **BREAKS** — 625 ms window holds the relaxed score gate open ~4× too long; noise continues a dead track | → `jumpWindowSec` (5/30 s), compared as wall-clock time |
| `TRACKER.maxPredictedFrames = 20` | ballTracker | frame cap over time | OK — `maxPredictedSec = 0.5` binds first at ≤40 fps; the frame cap is only a fast-pipeline safety net | none |
| `TRACKER.maxPredictedSec = 0.5` | ballTracker | time | OK — device-independent by design | none |
| jump-gate *allowance* (`maxSpeedDiametersPerSec × Δt`) | ballTracker | time-scaled | OK — already scales with elapsed time | none |
| `TRACKER.historyLen = 30` | ballTracker | ring size | OK — bounded by `staleSampleSec = 2 s` prune; 30 slots is generous headroom at any fps | none (documented) |
| `trajectory MIN_FIT_SAMPLES = 5` | trajectory | sample-count | **BREAKS** — a short/tail arc at 8 fps has 2–4 samples, below 5 → no fit → no descend-arm / no virtual crossing | `fitArc(samples, minSamples)` param; FSM passes an fps-scaled floor, hard-clamped ≥ `ABS_MIN_FIT_SAMPLES = 3` |
| `descendingArm.minRealSamples = 5` | shotFsm | sample-count | **BREAKS** — a made floater never arms on a slow phone | fps-scaled via `minFitSamples()` |
| `virtualCross.minRealSamples = 5` | shotFsm | sample-count | **DEGRADES→BREAKS** — occluded swish can't project its crossing | fps-scaled via `minFitSamples()` (still conservative — declines a too-sparse tail rather than fake a crossing) |
| `REAPPEAR.minRealSamplesPreGap = 5` | reappearance | sample-count | **BREAKS** — corroborator never arms | fps-scaled off the history's own median interval, clamp ≥ 3 |
| `REAPPEAR.vyDownSamples = 2` | reappearance | sample-count floor | OK — 2 is the minimum meaningful anti-noise floor; kept fps-independent | none (documented) |
| `SHOT_FSM.layupArmLowScorePersistFrames = 3` | shotFsm | sample-count floor | OK — 3 is the anti-noise floor; kept as a *sample* count (not scaled up at low fps, which would make layups harder) | none (documented) |
| `SHOT_FSM.releaseAngleSamples = 5` | shotFsm / trajectory | "use up to N" | **DEGRADES (metric only)** — at 8 fps the first-5-samples secant spans a longer baseline, so the *release-angle number* is noisier; make/miss unaffected (uses ≥2) | left as-is (metric quality, not correctness) |
| up-zone **rising** detection (jump arm needs a sample during the ~150 ms rise) | shotFsm | sampling chance | **DEGRADES** — at 8 fps (125 ms/frame) ~1 chance, sometimes 0 to catch a rising in-up-zone sample | architectural fallback: the same shot arms via the **descend** or **release** branch instead (tested) |
| rim-bounce detection (needs a sample during the re-ascent) | shotFsm | sampling chance | **DEGRADES (signal only)** — 8 fps can miss the bounce flag; the make/miss outcome still resolves from the final crossing + net | accepted; outcome-level invariant tested |
| `netWindowSec = 0.35`, all `*Sec` cooldowns/timeouts | shotFsm | time | OK — net samples arrive per analyzed frame; 0.35 s spans ≥2 net samples even at 8 fps | none |

All other `*Sec` constants (lostBall, cooldowns, maxLive, putback, stationary,
seed windows, TTLs) are already wall-clock and device-independent.

---

## 3. Scenario matrix

Legend for **carrying path**: `geo` = observed rim-plane crossing · `net` =
net-motion burst · `cls` = ball_in_basket class · `virtual` = projected
occluded crossing (net/cls-corroborated) · `descend`/`release`/`layup`/`jump` =
arming branch. **Status**: `M` measured on labeled clips · `A` assumed (needs
flywheel). The whole grid is currently **A** at the device level — the offline
low-fps *simulation* suite (`shotFsmLowFps`, `ballTrackerLowFps`,
`reappearanceLowFps`, `trajectoryLowFps`) is `M-sim` (make/miss invariance
proven at 8/12/15/24/30 fps), but no cell has on-device flywheel confirmation
yet. Every `A` cell is a flywheel data ask.

### 3.1 entry tier (8–15 fps) — the design floor

| Scenario | Carrying path(s) | Outcome invariant vs 30 fps? | Status |
|---|---|---|---|
| Indoor, netted, side 5 m | geo + net | Yes | A (M-sim) |
| Outdoor sun, netted | geo + net | Yes — geo primary; glare hurts detection recall, not the gate | A |
| **Netless** (outdoor rim) | geo (+ cls when occluded at rim) | Yes — `fuse()` netless branch | A (M-sim) |
| Dark / dusk | geo + net; cold-acquire relaxed to `ballScoreMinDark` | Yes for arming; recall-limited | A |
| Close 3 m | geo + net | Yes | A |
| **Far 10 m** | geo + net; small ball → relaxed tracking floor | **Degrades** — ball may go undetected whole frames; virtual/reappear thin at 8 fps | A ⚠ |
| Portrait framing | geo + net | Yes | A |
| Landscape framing | geo + net | Yes | A |
| Youth rim 2.6 m | geo + net (rim-width scale auto-adjusts zones) | Yes | A |
| **Small ball (size 5/6)** | geo + net; `BALL_SIZES_M` setting | Yes for geo/net; depth-ratio veto flag still OFF | A |
| Layup / putback | layup arm → cls + occluded-at-rim | Yes | A (M-sim) |
| **Floater / runner** | descend arm → geo/net | **Degrades at 8 fps** — a *fast* floater's rim transit can be <1 frame; documented as "no false call" (make or no-attempt, never a phantom miss). 12 fps+ recovers the make | A (M-sim, degraded path asserted) |
| Occluded swish (ball lost at rim) | virtual crossing (net/cls-corroborated) | **Degrades** — sparse descending tail; declines to `unsure` rather than fake it (never a false miss) | A (M-sim, degraded path asserted) |

### 3.2 mid tier (15–24 fps)

| Scenario | Carrying path(s) | Outcome invariant vs 30 fps? | Status |
|---|---|---|---|
| All entry-tier scenarios | same as entry | Yes — extra fps restores rim-bounce flag + denser tails; floater/occluded-swish makes recover | A (M-sim) |
| Far 10 m | geo + net; ROI-zoom 2nd pass affordable | Better recall than entry (roiZoomSafe = true) | A |
| Small ball | geo + net; ROI zoom | Better | A |

### 3.3 high tier (24–30+ fps)

| Scenario | Carrying path(s) | Outcome invariant vs 30 fps? | Status |
|---|---|---|---|
| All scenarios | full three-signal fusion, Tiny model, pose form analysis on | Yes — this **is** the 30 fps baseline the matrix is measured against | A (M-sim = baseline) |
| Occluded swish, rim-bounce, floater | virtual + geo + net, dense tails | Full precision incl. metrics | A |

---

## 4. Validation status & flywheel asks

- **`M-sim`** — proven offline: the four low-fps suites resample the *same
  continuous physics* at 8/12/15/24/30 fps and assert each canonical scenario
  (clean swish, brick, rim-rattler, layup, occluded swish w/ virtual crossing,
  floater, reappearance) resolves to the **same outcome as 30 fps**, or to the
  **documented degraded path** (never a false make/miss). This is math
  confirmation, not device confirmation.
- **Every device × scenario cell is `A` (assumed)** until the flywheel
  (`WS-F`) ships labeled on-device clips per tier. Priority asks, worst-first:
  1. **entry × far 10 m** and **entry × small ball** — the recall-limited cells
     where 8 fps + a tiny ball is most likely to drop the track entirely.
  2. **entry × floater (fast)** — confirm the "no false call" degraded path on
     real footage; measure how often a real fast floater is simply not called.
  3. **entry × occluded swish** — measure the `unsure` rate; the virtual-crossing
     corroborator is deliberately conservative at low fps.
- **Depth-ratio veto / reappearance / view-band routing flags are still OFF**
  (`SHOT_FSM.useDepthRatioVeto/useReappearance/useViewBandRouting = false`); the
  low-fps hardening keeps them fit to flip on once labeled clips justify it.

Update this page whenever a cell moves `A → M`. A quarter with no cell promoted
is a review item (MASTER-PLAN §9).
