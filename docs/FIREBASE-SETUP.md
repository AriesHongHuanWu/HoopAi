# Firebase setup — the owner's runbook

Everything in this file is run by **you**, the project owner, on your own
machine. `firebase-tools` is not a dependency of this repo and nobody else can
log in as you (the login is an interactive Google OAuth flow).

**You do not have to do any of this.** With no Firebase config the app behaves
exactly as it always has: no account, no network calls, every session, shot and
stat in the on-device SQLite database. That is a supported, tested
configuration — see `src/data/__tests__/firebaseConfig.test.ts` and
`src/state/__tests__/authStore.test.ts`, which pin the unconfigured path. The
cloud is an opt-in **mirror**, never the source of truth.

---

## 0. What the cloud half actually does

| | |
|---|---|
| Auth | email + password, password reset, and **anonymous** sign-in so a player never has to make an account. A guest can later add an email and keep the same account (`linkWithCredential`). |
| Records | session records (`users/{uid}/sessions/{recordKey}`) and their shots (`.../shots/{shotIndex}`). |
| What is uploaded | numbers and short labels **only**: start/end time, session label, mode id, attempts, makes, FG%, and per shot the index, times, outcome, correction flags, entry/release angle, 2-or-3 value + confidence. |
| What is **never** uploaded | video, frames, images, clip paths, trajectories, pose data, form reports, arcs, frame- or court-space coordinates. Enforced by a field whitelist in `src/data/firebaseRecords.ts` **and** by the security rules below. |
| SDK | the pure-JS `firebase` npm package (v12, modular). No native module, no config plugin, no prebuild, no pods. |
| Auth persistence | `getReactNativePersistence` over `expo-sqlite/kv-store` (already a dependency), so a session survives a restart without adding `@react-native-async-storage/async-storage`. |

---

## 1. Install the CLI and sign in

```bash
npm install -g firebase-tools
firebase login
```

`firebase login` opens a browser. If you would rather not install globally,
every command below works with `npx firebase-tools@latest …`.

## 2. Create (or pick) the project

```bash
firebase projects:create hoopilot-app --display-name "Hoopilot"
```

`hoopilot-app` must be globally unique; add a suffix if it is taken. To use a
project you already have, list them and skip to the next step:

```bash
firebase projects:list
```

Then, from the repo root:

```bash
cd /path/to/hoop-ai
firebase use hoopilot-app
```

That writes `.firebaserc` (just the project id — not a secret).

## 3. Create the Firestore database

```bash
firebase firestore:databases:create "(default)" --location=asia-east1
```

Pick the region closest to your users (`asia-east1` for Taiwan,
`us-central1`, `europe-west1`, …). **The region cannot be changed later.** If
the command reports that the API is not enabled yet, open
`https://console.firebase.google.com/project/hoopilot-app/firestore`, click
**Create database**, choose **production mode** (the rules below replace the
default deny-all), and pick the same region.

## 4. Turn on the two sign-in providers

This step is console-only — the CLI cannot toggle auth providers. Open:

```
https://console.firebase.google.com/project/hoopilot-app/authentication/providers
```

* **Email/Password** → Enable → Save.
* **Anonymous** → Enable → Save. (Required: "keep going without an account" is
  the default path through the app.)

Leave everything else off. The app uses no other provider.

## 5. Register the web app and read its config

```bash
firebase apps:create web "Hoopilot"
firebase apps:sdkconfig web
```

`apps:sdkconfig` prints the web config. Copy four values into a new `.env` in
the repo root (`cp .env.example .env` first):

```
EXPO_PUBLIC_FIREBASE_API_KEY=…        # from apiKey
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=…    # from authDomain
EXPO_PUBLIC_FIREBASE_PROJECT_ID=…     # from projectId
EXPO_PUBLIC_FIREBASE_APP_ID=…         # from appId
```

Then restart Metro (`npx expo start --clear`) — Expo inlines `EXPO_PUBLIC_*`
at bundle time, so a running dev server will not pick them up.

### About these four values

They are **not credentials**. A Firebase web config identifies the project;
Google documents it as public, and it is readable inside any shipped app
bundle. What protects the data is step 6.

`.env` is gitignored anyway (`.gitignore` has `.env`, `.env.*`,
`!.env.example`), so nothing real lands in a tracked file. What must **never**
go anywhere near this repo is a **service-account JSON key** or any admin
credential — those are real secrets, they bypass every rule below, and the app
does not use them.

## 6. Deploy the security rules — this is the part that matters

```bash
firebase deploy --only firestore:rules
```

`firebase.json` already points at `firestore.rules` in the repo root. The rules
are the enforcement: the client-side whitelist is a second lock on the same
door, and a lock on the client is a lock an attacker owns — anyone can pull the
public web config out of the bundle and talk to the project directly. This
project has previously shipped an admin check that existed only in the
frontend. Not again.

The deployed rules guarantee:

1. A user's records are readable and writable **only** by that user. There is
   no cross-user read path, not even a listing of user ids. Anonymous (guest)
   accounts are real accounts with real uids and get the same isolation.
2. A document may contain **only** the whitelisted numeric/metadata fields
   (`keys().hasOnly(...)`). A write carrying `clipPath`, `trajectoryJson`,
   `frames`, a base64 blob or a nested map is rejected **by the database**,
   whatever a client believes it is doing.
3. Every other path in the project is denied.

`firestore.rules`, in full:

```javascript
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    function isOwner(uid) {
      return request.auth != null && request.auth.uid == uid;
    }

    // `data.get(field, null)` rather than `data[field]`: reading an absent key
    // is an ERROR in rules, and an error denies the whole write.
    function numOrNull(data, field) {
      return data.get(field, null) == null || data.get(field, null) is number;
    }

    function strOrNull(data, field, maxLen) {
      return data.get(field, null) == null
             || (data.get(field, null) is string && data.get(field, null).size() <= maxLen);
    }

    function sessionShapeOk() {
      let d = request.resource.data;
      return d.keys().hasOnly([
               'schema', 'recordKey', 'originDeviceId', 'localId', 'startedAt',
               'endedAt', 'label', 'modeId', 'attempts', 'makes', 'fgPct',
               'shotCount', 'updatedAt'
             ])
             && d.keys().hasAll(['schema', 'recordKey', 'startedAt', 'attempts', 'makes'])
             && d.schema is number
             && d.recordKey is string && d.recordKey.size() <= 64
             && d.startedAt is number
             && d.attempts is number && d.attempts >= 0
             && d.makes is number && d.makes >= 0
             && numOrNull(d, 'endedAt')
             && strOrNull(d, 'label', 120)
             && strOrNull(d, 'modeId', 120)
             && strOrNull(d, 'originDeviceId', 32)
             && numOrNull(d, 'localId')
             && numOrNull(d, 'fgPct')
             && numOrNull(d, 'shotCount')
             && numOrNull(d, 'updatedAt');
    }

    function shotShapeOk() {
      let d = request.resource.data;
      return d.keys().hasOnly([
               'schema', 'shotIndex', 'tStart', 'tResolved', 'outcome',
               'corrected', 'outcomeCorrected', 'rimBounce', 'entryAngleDeg',
               'releaseAngleDeg', 'shotValue', 'valueConfidence'
             ])
             && d.keys().hasAll(['shotIndex', 'outcome'])
             && d.shotIndex is number
             && d.outcome in ['make', 'miss', 'unsure']
             && numOrNull(d, 'schema')
             && numOrNull(d, 'tStart')
             && numOrNull(d, 'tResolved')
             && numOrNull(d, 'corrected')
             && numOrNull(d, 'outcomeCorrected')
             && numOrNull(d, 'rimBounce')
             && numOrNull(d, 'entryAngleDeg')
             && numOrNull(d, 'releaseAngleDeg')
             && numOrNull(d, 'shotValue')
             && numOrNull(d, 'valueConfidence');
    }

    match /users/{uid} {
      allow read, write: if false;

      match /sessions/{recordKey} {
        allow read: if isOwner(uid);
        allow create, update: if isOwner(uid) && sessionShapeOk();
        allow delete: if isOwner(uid);

        match /shots/{shotIndex} {
          allow read: if isOwner(uid);
          allow create, update: if isOwner(uid) && shotShapeOk();
          allow delete: if isOwner(uid);
        }
      }
    }

    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

## 7. Prove the rules actually deny what they claim

Do not skip this. Open the Rules Playground:

```
https://console.firebase.google.com/project/hoopilot-app/firestore/rules
```

Four checks, each of which must come back the way it says:

| Simulated request | Expected |
|---|---|
| `get` on `/users/USER_A/sessions/x` authenticated as `USER_A` | **allow** |
| `get` on `/users/USER_A/sessions/x` authenticated as `USER_B` | **deny** |
| `create` on `/users/USER_A/sessions/x` as `USER_A` with `{schema:1, recordKey:"d-1", startedAt:1, attempts:0, makes:0}` | **allow** |
| the same `create` plus `clipPath: "file:///v.mp4"` | **deny** |

Or run them offline against the emulator:

```bash
firebase emulators:start --only firestore
```

## 8. Cost and lock-in

Auth and Firestore both have a free tier that a hackathon demo will not come
close to. Nothing in the app breaks if you delete the project later: strip
`.env`, and it is a local-only app again.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Account screen says "Local only" | no `.env`, a blank value, or a leftover placeholder (`your-api-key`) — all read as unconfigured, on purpose | fill in all four values, then `npx expo start --clear` |
| "This sign-in method is switched off for this project" | step 4 not done | enable Email/Password **and** Anonymous |
| "Could not reach your account…" | offline, or rules not deployed | check signal; `firebase deploy --only firestore:rules` |
| `PERMISSION_DENIED` in the Metro log | rules not deployed, or a payload field outside the whitelist | deploy the rules; if it persists, the payload shape and the rules have drifted apart — reconcile `CLOUD_SESSION_FIELDS` / `CLOUD_SHOT_FIELDS` with `firestore.rules` |
| Sign-in works, history does not appear | records only sync on an explicit **Back up now** or right after a sign-in | tap **Back up now** on the Account screen |
