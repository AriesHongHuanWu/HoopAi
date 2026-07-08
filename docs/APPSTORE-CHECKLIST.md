# App Store / Play Store readiness checklist — Hoopilot

Status: **pre-submission pack (MASTER-PLAN Phase A + B08).** This is the single
source of truth for the store answers, the copy that must match between the app
and the listings, and the decisions that still need a founder call.

The app's whole compliance story rests on one fact: **Hoopilot processes
everything on-device. No video, image or audio is ever transmitted. The only
data that leaves the phone is a file the user personally taps Share or Export
on.** Answer every store questionnaire from that fact.

- App name: **Hoopilot** · slug `hoop-ai`
- iOS bundle id: `com.arieswu.hoopai` · Android package: `com.arieswu.hoopai`
- Version `1.0.0` · iOS `buildNumber` `1` · Android `versionCode` `1`
- In-app policy screens: `/legal` (hub) → `/legal/privacy`, `/legal/terms`,
  `/legal/licenses`. Hosted mirror for the listing URL: `docs/PRIVACY-POLICY.md`.

---

## 1. Apple — App Privacy "nutrition labels" (App Store Connect → App Privacy)

Overall answer to *"Do you or your third-party partners collect data from this
app?"* → **the app collects no data that is transmitted off device.** Apple's
definition of "collect" is *transmit off the device*. Because nothing is
transmitted, the honest and correct selection is:

> **"Data Not Collected."**

Set this as the top-level answer. The reasoning, per data type, so a reviewer
question can be answered instantly:

| Data type touched | Stored | Leaves device? | Nutrition-label treatment |
|---|---|---|---|
| Camera video / photos | On device only (clips optional) | No (only via user Share/Export) | Not collected |
| Microphone audio | On device with clips | No | Not collected |
| Health & Fitness (height, weight, wingspan) | On device, optional | No | Not collected |
| Birth year / age | On device, optional (age derived, never stored) | No | Not collected |
| Nickname / identifiers | On device, optional | No | Not collected |
| Usage / analytics | **None exists** | — | Not collected |
| Diagnostics / crash | **None exists** | — | Not collected |

**If Apple's flow forces you to declare the fitness fields as "collected"**
(some reviewers read local storage of health-type data strictly), declare
**Health & Fitness** with these exact sub-answers:

- Used for: **App Functionality only** (personalized coaching + fair peer
  comparison). NOT Analytics, NOT Product Personalization for ads, NOT
  Third-Party Advertising.
- Linked to the user's identity? **No.** (No account; data is not tied to an
  identity.)
- Used for tracking (as ATT defines it)? **No.**

There is **no ATT / App Tracking Transparency prompt** — the app does no
tracking and has no `NSUserTrackingUsageDescription`. Do not add one.

## 2. Google Play — Data Safety form (Play Console → App content → Data safety)

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **No** — no data is collected or shared (nothing is transmitted off device). |
| Is all user data encrypted in transit? | **Not applicable / Yes** — no data is transmitted; nothing travels unencrypted. State "no data collected". |
| Do you provide a way to request data deletion? | Data is on-device only; the user deletes it by clearing clips/profile or uninstalling. (Becomes a **hard requirement** the day accounts ship — see §6.) |
| Photos and videos | Accessed **on-device for app functionality**; not collected/transmitted. |
| Audio | Recorded on-device with clips; not collected/transmitted. |
| Health and fitness | Optional height/weight/wingspan stored **on-device**; not collected/transmitted. |
| Personal info (name) | Optional nickname stored **on-device**; not collected/transmitted. |

Play separates **app permissions** from **data collection** — declaring the
camera/mic/media permissions is expected and does not mean "collected." The
Data Safety form is about transmission, and Hoopilot transmits nothing.

**Flag (founder decision — see §11):** the manifest still requests legacy
`READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE`. On Android 13+ these are
superseded by the scoped `READ_MEDIA_*` perms already present; broad storage
perms can trigger a Play permissions-declaration prompt. Decide whether to drop
them (owned by the camera/media area).

## 3. Age rating

- **Apple:** expected **4+**. No objectionable content; no user-generated
  content shared through our servers (there are none); no unrestricted web
  access; no gambling. Answer all content-description questions **None**.
- **Google Play (IARC questionnaire):** expected **Everyone**. It is a sports
  training utility with no violence, no in-app purchases live during beta, and
  no data sharing.
- Note the app is a **fitness / sports utility**, not a game, for category
  selection (primary category: **Sports** or **Health & Fitness**).

## 4. Permission purpose strings (drafted AND applied to `app.json`)

All strings below are now live in `app.json` (this change set). Each names the
concrete use and states on-device processing — the wording Apple review reads.

**iOS `infoPlist`:**

- `NSCameraUsageDescription`: "Hoopilot uses the camera to detect the ball and
  rim and score your shots in real time. Video is analyzed entirely on your
  device and is never uploaded."
- `NSMicrophoneUsageDescription`: "Hoopilot records court audio together with
  your session clips so replays sound like you were there. Audio stays on your
  device and is never uploaded."
- `NSPhotoLibraryAddUsageDescription` (**added**): "Hoopilot saves the highlight
  clips you choose to keep to your photo library."
- `NSPhotoLibraryUsageDescription` (**added**): "Hoopilot reads a basketball
  video you pick so it can run the on-device shot detector on it. Only the video
  you select is read, and it never leaves your device."
- `ITSAppUsesNonExemptEncryption`: `false` (**added** — export-compliance, §7).

**expo plugin permission strings (Android + iOS prompt copy):**

- `expo-media-library` photos/savePhotos: "Hoopilot saves the highlight clips
  you choose to keep to your photo library."
- `expo-image-picker` photos: "Hoopilot reads a basketball video you pick so it
  can run the on-device shot detector on it. Only the video you select is read,
  and it never leaves your device."

## 5. IAP readiness

- **No purchase package is installed** (StoreKit 2 / react-native-iap /
  RevenueCat). Beta is fully unlocked — `src/core/premium.ts` `IS_BETA = true`
  makes `isUnlocked()` return true for every feature. **This is correct for
  submission:** shipping a paywall UI with no working products is itself a
  rejection risk (Guideline 2.1 / 3.1.1).
- The paywall spec lives in `docs/MONETIZATION.md` (HoopAI Pro, $4.99/mo /
  $29.99/yr, auto-renewing subscription, 7-day trial on annual).
- **When IAP ships**, this checklist gains: subscription products configured in
  App Store Connect / Play, a Terms (EULA) + Privacy link on the paywall,
  restore-purchases, price/terms disclosure before purchase, and the auto-renew
  disclosure text Apple requires (Schedule 2 / Guideline 3.1.2).

## 6. Account deletion — REQUIRED the day accounts ship

Apple **Guideline 5.1.1(v)**: any app that supports account creation must let
users initiate **account deletion from within the app** (not just data
deletion, not "email us").

- **Today:** Hoopilot has **no accounts and no login**, so 5.1.1(v) does not
  apply yet. All data is on-device and removed by clearing clips/profile or
  uninstalling.
- **The moment accounts / cloud sync ship (MONETIZATION `cloudSync`):** an
  in-app "Delete account" flow becomes **mandatory** for both stores, and the
  Play Data Safety "data deletion" answer must point to it. Wire this in the
  same release that introduces accounts — do not defer it. The privacy policy
  already pre-commits to this (`/legal/privacy` → "Future changes").

## 7. Export compliance (encryption)

- Hoopilot uses only **standard OS-provided encryption** (HTTPS/TLS via the
  platform, on-device SQLite) and no proprietary or non-standard cryptography.
- It therefore qualifies for the standard **exemption** under U.S. EAR
  §740.17(b). `ITSAppUsesNonExemptEncryption = false` is set in `app.json`, so
  App Store Connect will **not** ask the encryption question each build.
- No CCATS / year-end self-classification report is required for the exempt
  category. Re-evaluate only if custom crypto is ever added.

## 8. Content rights — pro player names (FLAG FOR LEGAL REVIEW)

Shot Lab and Form Studio compare the user's shot to **factual pro-shooting
benchmarks** (release angle, tempo, release height, etc.) attributed to named
players: Stephen Curry, Klay Thompson, Ray Allen, Reggie Miller, Kevin Durant,
Kawhi Leonard, Damian Lillard, Kyrie Irving, Devin Booker, Luka Dončić, Steve
Nash, Dirk Nowitzki (`src/core/nbaBenchmarks.ts`).

- **What is used:** player **names as textual references** to public,
  factual benchmark values, plus parametric reference-form illustrations.
- **What is NOT used:** no NBA/team **logos**, no **photographs**, no **video**,
  no player **likeness or avatars**, no jerseys or marks.
- The app is **not affiliated with, endorsed by, or sponsored by** the NBA or
  any player, and the Licenses screen (`/legal/licenses`) states this in-app.
- **Founder / legal decision:** nominative use of names as factual references
  is generally defensible, but right-of-publicity and trademark exposure is a
  **legal-counsel call before launch**. If counsel prefers zero risk, swap the
  named archetypes for descriptive labels ("compact one-motion guard",
  "high-release wing") — the benchmark math is unchanged. Tracked here as an
  open item, not resolved by engineering.

## 9. Screenshot list (10 scenes, per device class)

Capture on a 6.7" iPhone and a 6.5"/tablet frame (plus Android phone). Order =
listing order (hook first):

1. **Live HUD scoring a make** — comet trail + rim lock, FG% chip. The hero.
2. **Session summary** — big FG% scoreboard, make/miss strip, shot arc hero.
3. **Made-shot highlight replay** — the clip player on a swish.
4. **Shot Lab** — release angle / entry angle vs. a pro benchmark.
5. **Form Studio** — user form overlaid on a reference form (2D).
6. **Jump Lab** — jump metrics readout.
7. **Trends** — FG% over time, streaks, improvement curve.
8. **History** — session cards with mini pip rows.
9. **Game modes** — Around the World / 3-Point Contest picker.
10. **Privacy, plainly** — the `/legal` hub / privacy callout: "runs entirely on
    your phone." A trust close that doubles as review reassurance.

Add one **app preview video** (optional) of a live session scoring shots.

## 10. App Review notes (draft — paste into App Store Connect "Notes")

> Hoopilot is an on-device basketball shot tracker. Point the phone at a hoop,
> shoot, and it detects the ball and rim from the live camera to score makes and
> misses in real time, with optional highlight clips.
>
> Camera & microphone: used to detect the ball/rim and record court audio with
> session clips. ALL processing is on-device — no video, image or audio is ever
> uploaded. Nothing leaves the device unless the user taps Share or Export.
>
> How to review without a hoop: the app ships with a built-in demo/mock
> detector, so a full session (HUD, sounds, stats, summary) can be reviewed
> indoors with no basketball hoop present. [Confirm the exact toggle/path with
> the reviewer — see src/ml/mockDetector.ts.]
>
> Accounts: none. Purchases: none active (beta is fully unlocked). Tracking:
> none. Privacy policy: [hosted URL of docs/PRIVACY-POLICY.md]; the same policy
> is in-app under Settings → Privacy, terms & licenses.

## 11. Open items needing a founder decision

1. **Legacy Android storage perms** (§2) — drop `READ/WRITE_EXTERNAL_STORAGE`
   now that scoped `READ_MEDIA_*` are present? (Owned by camera/media area.)
2. **Pro player names** (§8) — legal-counsel sign-off on nominative use, or swap
   to descriptive archetypes.
3. **Privacy Policy hosting URL** — publish `docs/PRIVACY-POLICY.md` to a stable
   URL and set it in both store listings **and** repoint `PRIVACY_POLICY_URL` in
   `src/app/settings.tsx` (currently the GitHub repo root — blocking TODO noted
   in that file).
4. **Support email** — `support@hoopai.app` must be a monitored inbox before
   submission (both stores require reachable support).
5. **AGPL YOLO11 removal for paid build** (MASTER-PLAN B08 red line) — the
   Apache YOLOX default already ships; confirm the build variant that strips the
   AGPL weights before charging money.

## 12. What changed in this pack

- **`app.json`**: improved `NSCameraUsageDescription` and
  `NSMicrophoneUsageDescription`; **added** `NSPhotoLibraryAddUsageDescription`,
  `NSPhotoLibraryUsageDescription`, and `ITSAppUsesNonExemptEncryption = false`;
  **added** `ios.buildNumber = "1"` and `android.versionCode = 1`; tightened the
  `expo-media-library` and `expo-image-picker` permission strings. Bundle ids,
  name, slug and version were already store-sane and unchanged.
- **In-app legal**: new `/legal` hub + `/legal/privacy`, `/legal/terms`,
  `/legal/licenses` screens; a reusable `LegalLink` component for Settings to
  import post-merge (Settings not edited here — owned elsewhere).
- **Docs**: this checklist + `docs/PRIVACY-POLICY.md` (hosted mirror).
