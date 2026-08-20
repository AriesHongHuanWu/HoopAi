# Form Check — stage runbook

**Build:** `lightning-nano-model` @ `ae4029e` + v3 stage hardening.
**Demoing:** Form Check only. Indoor room, no hoop, no ball, iPhone 11 or older.
**§0 is the one you run in the room.** Everything else is done before you leave the house.

---

## 0 · THE 60-SECOND ROOM TEST

Run this **in the demo room, with the phone where it will actually sit.** This is the whole
rehearsal diagnostic — every number is already on screen in the normal demo path.

| # | Do | Look at | Pass |
|---|----|---------|------|
| 1 | Open Form Check, wait 5 s on the guide | rail after Start | no error banner |
| 2 | Tap **Start form check** | top rail | `Starting the camera…` → chips within ~2 s |
| 3 | Stand where you will present | **FPS chip** | **≥ 22.** 15–21 = works now, may not after two runs. < 15 → §5 row 3 |
| 4 | " | **BODY chip** | green |
| 5 | " | **SIDE chip** | green. Amber = still counting, angles low-confidence |
| 6 | Two practice motions | rail | `PRACTICE MOTION 1 OF 2` → `Calibrated — scoring armed` |
| 7 | Three deliberate motions, ~1.5 s apart | big numeral | reads **exactly 3** |
| 8 | Tap **End session** | report | opens straight onto **Compare**, motion animates |

**Verdict**

- **All green** → run the script as written.
- **FPS 15–21, or any amber chip** → still run it. Say the confidence line out loud (§7).
- **FPS < 15** → tap flip for the back camera; if still low, tap **Count anyway**. The demo works,
  every rep is then labelled low-confidence, and you must say so.
- **Step 7 reads 0** → §5 row 6. **Step 7 over-counts** → keep your arms down between reps.

> No in-app diagnostic screen exists, on purpose. Every number above is rendered by the real demo
> path; a screen that measured pose fps would need a second copy of the camera + MoveNet loop —
> more risk than it removes, a week out.

---

## 1 · PRE-FLIGHT ON THE PHONE

**Night before**

1. **Reboot the phone.** Non-negotiable. Frame timestamps are seconds-since-boot on iOS; long uptime
   used to invert the clock. Fixed in this build, but a reboot also clears thermal state.
2. **Do not wipe or reinstall the app.** A fresh install empties the CoreML compile cache (worst-case
   warm-up) *and* wipes the sessions that make Form Check reachable (§8).
3. **Profile → Height** set, and **Settings → Shooting hand** set. Without height, release height
   reads `% of frame` instead of metres.
4. **Charge to 100 %.** Low Power Mode throttles and will cost you pose fps.
5. Take §2's four measurements. Write them in the table.

**Ten minutes before**

| Check | Pass |
|---|---|
| Do Not Disturb / Focus **on** | no notification can background the camera |
| Low Power Mode **off** | Settings → Battery |
| Auto-Lock — ignore it | the screen already stays awake inside Form Check |
| Brightness to max | you are reading amber chips from arm's length |
| Camera permission already granted | open Form Check once; no OS dialog should appear |
| App **cold-killed, then relaunched** | the first run of the day pays the worst warm-up, not the demo |
| Phone cool to the touch | ≥ 3 min backgrounded, screen off, since the last rehearsal run |
| **Coach → Your form → Check my shooting form** opens | §8 — verify physically, it is the top open risk |

---

## 2 · MEASUREMENTS THAT MUST BE TAKEN ON *THIS* PHONE

None of these can be read off the code. Take them in the demo room if you can, at home if you cannot.

**M1 · Pose frame rate**
Start a live Form Check, stand at demo distance, read the **FPS chip** in the top rail.
Then end the session and read `pose N fps` on the report — that is the session **median**, a far more
honest number than the live chip. Do it once on the **front** camera and once on the **back**.
*Pass ≥ 22. 15–21 workable. Below 15 needs* **Count anyway** *(offered only at ≥ 8 fps).*

**M2 · Delegate acceptance (CoreML vs CPU)**
**Not surfaced in the UI.** Its only observable is M1: had the CoreML rung failed and the loader
fallen through to CPU, pose fps on an A12/A13 would sit far below the floor. So treat **M1 ≥ 22 as
the delegate having been accepted**, and do not claim more than that. A direct readout needs a
one-line log in the loader — see §8.

**M3 · Warm-up / cold start**
Force-quit the app. Relaunch, open Form Check, tap **Start form check** *immediately*.
- If the rail shows `Warming up the pose model…` at all, the model was not ready. Time it.
- Time from the tap to the **first skeleton drawn**.

*Pass: no warm-up banner, skeleton inside ~2 s. If you do see the banner, wait that many seconds on
the guide during the demo — the guide is where the warm-up is meant to be paid.*

**M4 · Thermal behaviour over three runs**
Three back-to-back 60-second sessions, no cool-down. Record `pose N fps` from each report.
*Pass: run 3 within 20 % of run 1 and still ≥ 15. If it drops, your rehearsal ceiling is two runs and
you need ≥ 3 minutes backgrounded, screen off, before you walk on.*

| | front cam | back cam |
|---|---|---|
| M1 live FPS chip | | |
| M1 report median | | |
| M3 warm-up banner (s) | | — |
| M3 tap → skeleton (s) | | — |
| M4 run 1 / 2 / 3 | / / | / / |

---

## 3 · ROOM SETUP

**Phone**
- Propped against something solid, **portrait**, on your **shooting-arm side**, screen facing you.
- Lens at roughly hip-to-chest height. Keep it near vertical — past 15° of tilt the app says
  `Straighten the phone` and the receipt reads `not compensated`.
- **Never hand-held, and never held by a friend.** Framing drift and tilt break the gates, and the
  session then pauses for reasons the audience can see but you cannot.

**You**
- **2–4 m away, side-on.** Head to feet in frame. Analysis uses the **centre square** of the sensor
  frame, so leave headroom and footroom — being "in the preview" is not enough.
- If **BODY** goes amber, step back a pace. Do not move the phone mid-demo.

**Light**
- Seek: even, bright, roughly frontal room light. Face the light.
- Avoid: a **window or lamp behind you** (a silhouette collapses keypoint scores), single harsh
  downlights, dim warm mood lighting.
- Dim room → **flip to the back camera**. Bigger aperture; it is the single best fps recovery.

**Background**
- Plain wall. Avoid: other people in frame, a TV or poster showing a person, mirrors, and
  coat-rack-shaped clutter. Pose is single-person and will latch onto whoever it finds.
- Wear something that contrasts with the wall. Baggy sleeves hide the elbow line.

---

## 4 · THE SCRIPT (2:30)

| Time | Do | Say (roughly) |
|---|---|---|
| 0:00 | — | "Shooting-form apps need either a hoop or a lab. This needs neither — a phone and a wall." |
| 0:15 | Open Form Check, hold on the guide **5 s** | "Phone at your side, two to four metres, side-on. That's the setup." *(the model is warming here — do not rush this)* |
| 0:30 | Tap **Start form check** | "All of it runs on the phone. Nothing uploads." |
| 0:40 | Skeleton locks on; point at the chips | "It tells me what it can see before it measures anything — frame rate, body, arm, how side-on I am." |
| 0:50 | Two practice motions | "These two aren't scored. They calibrate — which arm I shoot with, how the phone is tilted, my baseline." |
| 1:05 | `Calibrated — scoring armed` | — |
| 1:10 | **Four** deliberate shooting motions, ~1.5 s apart | "No ball. It's reading the motion." |
| 1:35 | Tap **End session** | — |
| 1:40 | ★ **WOW — the report opens on Compare** | "That's my motion, next to a reference form. The reference is *synthesized* from published mechanics — a coaching illustration, not motion capture. This is a style match, not a score." |
| 1:55 | Scrub the motion by hand | "Set point, dip, release, follow-through — timed from the pose, phase by phase." |
| 2:05 | Tab to **Overview** | "Consistency: how far my elbow and my tempo move rep to rep. That's the coaching." |
| 2:15 | Point at `Release angle — needs the ball — not measured here` | "**And this is the part I'm proud of.** There's no ball, so it says so. It never reports what it didn't see." |
| 2:25 | — | "On-device, no account, nothing leaves the phone." |

**Do at least 3 reps** — below 3 the consistency rows render as em-dashes and the verdict asks for
more. **Four is the target.**

---

## 5 · FAILURE PLAYBOOK

One action each. Phrased so it looks intentional.

| # | What you see | Do this | Say this |
|---|---|---|---|
| 1 | No skeleton after ~3 s | Tap **Restart** | "Let me give it a clean start." |
| 2 | `The pose model didn't load — tap Retry.` | Tap **Retry** | "It caught its own failure — that's the retry." |
| 3 | `Pose is at N fps — too slow` | Tap the **flip** icon (back camera). Still low → **Count anyway** | "Dimmer room than I rehearsed in — back camera. / I'll let it count below its own floor; it marks those numbers low-confidence, which is the point." |
| 4 | `Step back — head to feet in frame.` | Step back one pace. **Do not move the phone** | "It wants my whole body — it won't guess at legs it can't see." |
| 5 | `Turn a little more side-on.` | Rotate ~20° | "It's a side-on measurement." |
| 6 | Counter does not move | Exaggerate: deeper dip, wrist higher, fuller extension, ~1.5 s apart | "It wants a full motion, not a wave." |
| 7 | Counter over-counts | Arms **down** between reps | — |
| 8 | Stuck on `PRACTICE MOTION 1 OF 2` | One clear motion, then tap **Start scoring** (appears after one) | "One practice rep is enough to calibrate." |
| 9 | Stuck and no practice rep lands | Tap **Skip** | "Skipping calibration — it'll read 'assumed' instead of measured, and it says so." |
| 10 | Dropped back into calibration | Two practice motions *(Recalibrate is long-press only now)* | "Re-baselining." |
| 11 | Phone backgrounded (call, banner) | Return to the app; the camera restarts itself. Rail stuck → **Restart** | — |
| 12 | **End session** is grey | It is disabled at zero reps. Tap **Restart**, never **Cancel** | "Fresh take." |
| 13 | Total loss | **Cancel** → **Start form check** | The model stays warm; this costs about a second. |
| 14 | Report is thin (< 3 reps) | Tap **Check again** on the report, do four | "Let me give it enough reps to talk about consistency." |

---

## 6 · DO NOT DO THIS ON STAGE

- **Do not demo Jump Lab or a live tracking session.** No hoop, and they still carry the old
  magnitude-guessed frame clock. Form Check only.
- **Do not hold the phone, and do not let anyone else hold it.**
- **Do not tap the refresh icon** in the live view expecting a restart — it is *long-press to
  recalibrate*, and a tap only shows a hint. **Restart** is the pill below it.
- **Do not press Play** in the Compare theatre. Scrub by hand — you control the pace and can talk over it.
- **Do not do fewer than three reps.**
- **Do not let a second person into frame.**
- **Do not open Settings, Profile, History or any other tool** mid-demo. Nothing else is rehearsed.
- **Do not reinstall or wipe the app** on demo day.
- **Do not say "it knows if it went in."** It cannot. See §7.

---

## 7 · WHAT THIS BUILD DOES **NOT** DO

Say these before a judge asks. The app's identity is that it does not report what it did not see —
over-claiming costs more than any missing feature.

**No ball, so no outcome**
- No make/miss, no shot outcome, no score. It never sees a ball.
- No release angle, no entry angle, no arc, no backspin. The report reads
  `needs the ball — not measured here`.

**Pose is COCO-17, so no hands**
- No wrist flick, no grip, no finger release, no hand rotation. Those keypoints do not exist.

**2D, single view**
- Angle comparisons are **in the camera plane**, not 3D. Depth in the 3D view is **inferred** from
  anthropometric assumptions, never measured.
- Metres are **estimates** derived from your profile height. Without a height, release height is a
  percentage of frame.
- Camera tilt beyond 15° is reported as **not compensated**, not corrected.

**The references are synthesized**
- The "NBA" reference form is an **idealized coaching illustration** built from published mechanics.
  Not motion capture, not real player data. A match is a **style match** — never a grade, never a
  score out of 100.

**It counts motions, sensitively**
- A raised arm can count. It is a motion counter, not a shot detector — the guide says so.

**It refuses rather than guesses**
- Below 15 fps it stops counting unless you explicitly tap **Count anyway**, and then every rep is
  labelled low-confidence with the reason.
- A relaxed gate always carries its cost into the report: `low pose fps`, `landmarks dropped`,
  `angled stance`. If those chips appear, read them out. They are the demo, not a blemish on it.
- Missing landmarks make a metric **unavailable with a reason** — knee flexion and metric release
  height go to "—" rather than being estimated.
- **The caveat survives the save.** A session caught under a relaxed gate reads
  `8 reps · tempo ±96 ms · low-confidence · 2 d ago` in the Coach receipt, and the tempo trend under
  it says how many of its points were coarse. If you tap **Count anyway** on stage, that is what the
  history will say afterwards — saving never launders a relaxed run.

**Scope**
- One person at a time. On-device only: no account, no cloud, no upload.

---

## 8 · OPEN RISK — VERIFY BEFORE DEMO DAY

**Form Check can be unreachable on a phone with no tracked sessions.** `coach.tsx` returns an empty
state before the `Your form` segment that holds the app's only two routes into `/formcheck`, and the
Train tab's tool grid has no Form Check tile. A wiped phone cannot open the feature being demoed.

Three mitigations, best first:

1. **Land the entry-point fix** — a Form Check `ToolCard` in `src/app/(tabs)/modes.tsx`, and the
   Form Check card lifted into `coach.tsx`'s zero-session branch. Two additive edits.
2. **Do not wipe the phone**, and confirm by hand that
   **Coach → Your form → Check my shooting form** opens. It is in the ten-minute checklist.
3. **Last resort, must be tested first:** the URL scheme is `hoopai`. Typing `hoopai://formcheck`
   into Safari should deep-link the screen. **Unverified** — test it on the demo phone, and check the
   back button behaves, before relying on it.

Two more, harmless as long as you follow §6:
- `src/app/jump.tsx` and `src/camera/useShotEngine.ts` still guess the frame clock from timestamp
  magnitude. Do not demo those screens on a phone with long uptime.
- A **one-line log of the accepted delegate rung** in the Form Check loader would make M2 directly
  readable in Xcode/Console instead of inferred. Not yet added.
