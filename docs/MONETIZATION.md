# HoopAI monetization plan

Status: **planning only**. HoopAI is in beta and every feature described here is
fully unlocked in the app today — see [Beta policy](#beta-policy). No purchase
package (StoreKit 2, `react-native-iap`, RevenueCat) is installed yet; this
document is the spec the paywall gets built against at launch.

The single code choke point for all of this is `src/core/premium.ts`. Screens
never check a plan or an entitlement directly — they call `isUnlocked(id)` and
render a `ProBadge` next to gated features. Flipping `IS_BETA` to `false` and
wiring `isUnlocked` to a real entitlement source is the entire launch cutover.

---

## 1. Model: freemium + subscription

**HoopAI Pro** — auto-renewing subscription, App Store IAP. A subscription
(not one-time unlock) fits this product because the ongoing value is data
that compounds: unlimited history, deepening records, and models/features
that keep shipping post-launch (form analysis, custom modes, cloud sync).
A single purchase would undersell that and cap future revenue from features
that don't exist yet.

### Price anchor vs. the market

| App | Plan | Price |
|---|---|---|
| Ball AI (aim/competitor reference point) | Monthly | **$9.99/mo** |
| Ball AI | Annual | ~$59.99/yr |
| **HoopAI Pro (recommended)** | Monthly | **$4.99/mo** |
| **HoopAI Pro (recommended)** | Annual | **$29.99/yr** (≈ $2.50/mo, 50% off monthly) |
| HoopAI Pro | 7-day free trial | on annual plan by default |

**Rationale for undercutting Ball AI:**
- HoopAI is a new entrant with zero brand recognition and no App Store
  reviews at launch — price is the lever we control before trust is earned.
  Landing meaningfully below the category leader removes "is this worth it"
  as a purchase-decision blocker.
- A $4.99/mo anchor also reads as an impulse buy for a hobbyist app (shooting
  drills, pickup games) rather than a "serious training tool" price, which
  matches HoopAI's actual target user (a player working on their shot, not a
  program buying seats for a team).
- The annual plan at $29.99 is the plan we actually want people on — it is
  ~50% cheaper per month than paying monthly, which pushes the LTV-friendly
  choice without a hard discount cliff that feels manipulative.
- A 7-day trial on the annual plan lets a user run several real sessions
  (not just one) before being charged, which matters for a feature set whose
  value shows up over multiple sessions (trends, streak records, badge
  progress) rather than in the first five minutes.
- Once HoopAI has ratings, retention data and a install base, price can move
  up — it is far easier to raise a proven price than to win back users who
  churned over an unproven one.

### Lifetime option — under consideration, not launching v1

A one-time "HoopAI Pro Lifetime" purchase (e.g. $49.99–$79.99) is worth
testing in a later release, not at launch:
- **For:** removes subscription-fatigue objections; a strong value prop for
  power users who will use the app for years; works well as a "founder"
  reward (see grandfathering below).
- **Against:** caps revenue from a single user right when we have the least
  data on retention/LTV to price it correctly; complicates the entitlement
  model (must survive OS reinstalls, device changes, future cloud sync)
  before that infrastructure exists.
- **Recommendation:** ship subscription-only at launch. Revisit a lifetime
  tier once we have 2–3 months of subscription retention data, and consider
  offering it first (or only) to beta grandfathered users as a thank-you
  tier rather than a general SKU.

---

## 2. Free forever (the core loop stays free, always)

The free tier is not a crippled trial — it is the full core product:

- Live camera tracking with real-time make/miss detection.
- **Free Play** mode (open run, no target/timer — the default daily loop).
- Basic session stats: attempts, makes, FG%, streak, 2pt/3pt split.
- **1 sound pack** (Classic).
- **Limited history** — last 10 sessions kept in full; older sessions still
  count toward lifetime totals (so lifetime stats/records never regress) but
  their per-shot detail rolls off.

This is deliberate: someone must be able to prop their phone up, shoot around
and get real, accurate makes/misses without ever paying. That's the whole
reason to install HoopAI over doing nothing.

---

## 3. HoopAI Pro (subscription)

Everything below is gated behind `isUnlocked()` post-launch and mirrors the
`PRO_FEATURES` registry in `src/core/premium.ts`:

| Feature | Why it's Pro |
|---|---|
| **All game modes** (Around the World, Spot Shooting, Timed Challenge, 3-Point Contest, Free Throw Streak, H-O-R-S-E) | Structured drills are the "coming back for more" hook once Free Play gets old. |
| **Unlimited history** | Serious users want every session; casual users don't miss what they don't see. |
| **Replay + highlights mode** | Instant replay player and auto-cut highlight reels are compute/storage-heavy and high perceived value. |
| **Clip pre/post-roll control** | Power-user tuning knob on top of the (free) default clip window. |
| **All sound packs** (Arcade, Stadium) **+ future custom sound import** | Low-cost personalization lever; free keeps one voice. |
| **Voice announcements** | Nice-to-have layered on top of the free core loop, not required to use the app. |
| **Achievements deep records** | Full badge board + lifetime record detail; free users still see basic session stats. |
| **Share cards without watermark** | Free share cards carry a small HoopAI watermark (built as free marketing); Pro removes it. |
| **Precise / ultra detection models** | Meaningfully more compute per frame — a real cost driver, fair to gate. |
| **Form analysis** *(future)* | Release angle / jump metrics from pose tracking — planned post-launch. |
| **Custom mode builder** *(future)* | Build your own drills/spots/scoring — planned post-launch. |
| **Cloud sync** *(future)* | Cross-device backup — planned post-launch, needs backend work first. |

Note: the free tier does **not** currently produce a watermarked share card in
the codebase — adding the watermark to the free path is a prerequisite launch
task tracked separately, called out here so it isn't lost.

---

## 4. Beta policy

**While in beta, nothing is gated.** `IS_BETA = true` in `src/core/premium.ts`
makes `isUnlocked()` return `true` unconditionally — every mode, every sound
pack, unlimited history, replay/highlights, all of it is live for every beta
tester today.

`ProBadge` components are sprinkled next to what will become Pro-only
placements (mode picker cards other than Free Play, the Records screen
header) purely to **seed the expectation**: testers see a small "PRO" pill
today so the eventual paywall isn't a surprise, but the badge's accessibility
label and long-form copy ("PRO · free in beta") make clear it's free right
now.

### Grandfathering beta testers

Recommendation: beta testers who used the app before the paywall ships get a
**"Founder" badge** (cosmetic, shown on their share cards / profile) plus a
**discounted lifetime rate** — e.g. 50% off the standard monthly/annual price
for as long as they stay subscribed, or first access to a Lifetime SKU if one
ships (see §1). This rewards early feedback without giving away the full
product forever, and it costs us very little if beta uptake is small relative
to the eventual audience.

Mechanically: this needs a server-verifiable "installed before launch date X"
signal — the simplest version is a locally-stored flag written the first time
`onboardingDone` becomes true, then confirmed against a receipt or an install
date once analytics/backend exists. Decide the exact mechanism when the
paywall is actually built; don't build it speculatively now.

---

## 5. App Store subscription checklist (for when the paywall ships)

Not started yet — no packages added during beta, per the hard rule. This is
the checklist to work from at cutover:

1. **App Store Connect**
   - [ ] Create a subscription group ("HoopAI Pro").
   - [ ] Add two subscription products: monthly ($4.99) and annual ($29.99).
   - [ ] Configure the 7-day free trial as an introductory offer on annual.
   - [ ] Write subscription display name/description copy (sentence case,
         matches in-app copy exactly — App Review checks this).
   - [ ] Add required subscription disclosure text to the paywall screen
         (price, billing period, auto-renewal, cancellation instructions,
         links to Terms of Use / Privacy Policy) — Apple guideline 3.1.2.
2. **Purchase library** — pick one at implementation time, not now:
   - **`react-native-iap`** — thin wrapper over StoreKit 2, more manual
     receipt/entitlement bookkeeping, no backend dependency, cheaper to run.
   - **RevenueCat** — hosted entitlements, cross-platform parity if/when
     Android IAP is added, built-in analytics/paywall A/B testing, small
     revenue cut. Lean toward RevenueCat if Android launches alongside iOS or
     if cloud sync (which implies a backend anyway) ships around the same
     time; lean toward `react-native-iap` if iOS-only and backend-free stays
     true for a while.
3. **Entitlement wiring**
   - [ ] Replace `isUnlocked()`'s `return true` with
         `IS_BETA || <entitlement check>`.
   - [ ] Restore-purchases affordance in Settings (required by Apple
         guideline 3.1.1 whenever there's a paid unlock).
   - [ ] Handle grace period / billing-retry states gracefully (don't yank
         access mid-grace-period).
4. **Beta → launch cutover**
   - [ ] Flip `IS_BETA` to `false`.
   - [ ] Ship the Founder grandfathering flag/check (see §4) before the flip
         goes out, so no existing tester gets surprise-locked.
   - [ ] Update `ProBadge` long-form copy (drop "free in beta") in the same
         release.
5. **Testing**
   - [ ] Sandbox-test both products end to end (purchase, restore, cancel,
         renewal, trial-to-paid conversion) before submitting.
   - [ ] Verify every currently-free-in-beta feature correctly locks for a
         non-subscribed sandbox account, and correctly unlocks for a
         subscribed one.
