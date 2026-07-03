# Downloading & installing HoopAI

## Android — free, one tap, no accounts

Every push to `main` builds a signed, sideloadable APK in GitHub Actions and
publishes it to the **[latest release](../../releases/tag/android-latest)**.

1. On your Android phone, open the repo's **Releases** → `HoopAI — latest
   Android build` → download **`HoopAI.apk`**.
2. Tap the file. Android will ask to allow "Install unknown apps" for your
   browser/Files app — allow it, then install.
3. Open HoopAI. Until a trained detector model is bundled it runs in **demo
   mode** (a scripted scene drives the full app); the camera pipeline activates
   once a real model is added (see [MODELS.md](MODELS.md)).

> The APK is signed with a throwaway CI keystore — fine for sideloading and
> testing, not for the Play Store. For a Play Store build, generate a stable
> upload keystore and build with EAS (`eas build -p android --profile production`).

You can also grab the APK from any run's **Artifacts** under the Actions tab, or
cut a versioned release by pushing a tag: `git tag v0.1.0 && git push --tags`.

## iPhone — the honest situation

Apple does **not** allow a freely-downloadable, tap-to-install file like an APK.
An app that installs on a normal (non-jailbroken) iPhone must be signed with an
**Apple Developer account ($99/yr)**. There are three real paths:

| Path | Installs on a real iPhone? | Needs Apple Developer acct | How |
|---|---|---|---|
| **TestFlight** (recommended) | ✅ up to 10k testers | ✅ | `ios-eas.yml` workflow, profile `production`, submit on |
| **Ad-hoc IPA** | ✅ only pre-registered device UDIDs | ✅ | `ios-eas.yml` workflow, profile `preview` |
| **Simulator build** | ❌ Mac Simulator only | ❌ (free) | `ios-simulator.yml` workflow |

### TestFlight / ad-hoc (real iPhone install)

1. Create a free **Expo** account → Access Tokens → make a token.
2. Repo → Settings → Secrets and variables → Actions → add `EXPO_TOKEN`.
3. Have an **Apple Developer** membership. First run: `eas build -p ios` and let
   EAS create/manage the signing credentials (or run `eas credentials`).
4. Actions → **iOS device build (EAS / TestFlight)** → Run workflow → pick
   `production` + submit (TestFlight) or `preview` (ad-hoc). Testers install via
   the TestFlight app from an invite link.

From this Windows machine you can also build without CI:
`npm i -g eas-cli && eas login && eas build -p ios --profile production` — the
build runs on Expo's macOS cloud, no Mac needed.

### Simulator build (free, no Apple account)

Actions → **iOS Simulator build** → Run workflow. The result
(`HoopAI-simulator.app.tar.gz`) is published to the `ios-simulator-latest`
release. On a Mac: `tar -xzf` it, boot a simulator in Xcode, then
`xcrun simctl install booted HoopAI.app`. This proves the iOS build compiles but
can't run on a physical phone.

## What actually runs today

The camera + on-device inference path is written against VisionCamera 5 +
fast-tflite 3 but has **not** been verified on a physical device yet (it can't
be tested in CI or a headless env). The CI APK confirms the app *compiles and
packages*; first-run device verification is the week-1 checklist in
[BUILDING.md](BUILDING.md). Demo mode exercises the entire pipeline, UI, sounds
and stats without a camera or model.
