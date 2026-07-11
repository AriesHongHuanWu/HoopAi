/**
 * Summary screen source contracts (WI-B + tutor-5) — summary.tsx pulls in the
 * camera/session stores, expo-router, sqlite and Skia charts, so a full render
 * under jest is not honest coverage. Instead these tests pin the load-bearing
 * TEXT and GATING contracts at the source level (same approach as
 * setupSections.test.tsx pins import constraints):
 *
 * 1. HONESTY COPY — the coach step must never claim corrections retrain
 *    detection (they rewrite outcome only; signalsJson is untouched, see
 *    core/evidence.ts). The replacement copy tells the truth.
 * 2. UNSURE HINT — HintChip renders only when the session has unsure shots,
 *    with the trains-nothing copy and the how-it-works action.
 * 3. CONFETTI — mounts only on a new personal best, keyed on sessionId (once
 *    per mount per session), one-way latched off via confettiOn, with the
 *    PersonalBestBanner kept as the reduced-motion carrier.
 * 4. EXPLAINER NUDGE — gated on the (defensively read) detectionExplainerSeen
 *    flag; routes to /how-it-works.
 * 5. STAGGER — exactly the agreed section indices, and never on UndoSnackbar,
 *    modals or CoachMarks.
 */
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(
  path.join(__dirname, '..', '..', 'app', 'session', 'summary.tsx'),
  'utf8',
);

describe('honesty copy: correction coach step', () => {
  it('never claims corrections train or sharpen detection', () => {
    // The old copy's false promise, and any wording like it, must stay gone.
    expect(src).not.toMatch(/trains? sharper detection/i);
    expect(src).not.toMatch(/trains (the )?(detector|detection|model|AI)/i);
  });

  it('carries the truthful replacement copy verbatim', () => {
    expect(src).toContain(
      'Swipe a shot right to mark a make, left for a miss — or tap to correct it, including 2-point vs. 3-point. Corrections are yours: always labeled EDITED, never used to re-judge anything.',
    );
  });
});

describe('unsure hint chip', () => {
  it('renders only when the session has unsure shots', () => {
    expect(src).toMatch(/\{unsureCount > 0 && \(\s*<HintChip/);
  });

  it('uses the persisted one-shot key and the trains-nothing copy', () => {
    expect(src).toContain('hintKey="unsureSummary"');
    expect(src).toContain(
      "UNSURE stays unsure until you say otherwise — honest receipts only. Swipe to correct; it's labeled, and it trains nothing.",
    );
    expect(src).toContain('actionLabel="How calls are made"');
  });

  it('routes its action to the how-it-works explainer', () => {
    expect(src).toMatch(/onAction=\{\(\) => router\.push\('\/how-it-works'\)\}/);
  });
});

describe('personal-best confetti', () => {
  it('mounts only for a new PB and only while the one-shot latch is on', () => {
    expect(src).toMatch(/\{newBests\.length > 0 && confettiOn && \(\s*<Confetti/);
  });

  it('is keyed on sessionId — once per screen mount per session', () => {
    expect(src).toMatch(/trigger=\{sessionId \?\? 0\}/);
    expect(src).toMatch(/seed=\{\(sessionId \?\? 1\) as number\}/);
  });

  it('latches off via onDone and is never re-armed anywhere', () => {
    expect(src).toMatch(/onDone=\{\(\) => setConfettiOn\(false\)\}/);
    // The ONLY setConfettiOn call is the latch-off — corrections/re-renders
    // can never replay the burst.
    const calls = src.match(/setConfettiOn\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(src).not.toContain('setConfettiOn(true)');
  });

  it('keeps PersonalBestBanner mounted as the reduced-motion carrier', () => {
    expect(src).toMatch(/\{newBests\.length > 0 && \(\s*<PersonalBestBanner/);
  });

  it('confetti reads no judgment inputs — stats and outcomes never feed it', () => {
    const confetti = src.match(/<Confetti[\s\S]*?\/>/)?.[0] ?? '';
    expect(confetti).not.toContain('stats');
    expect(confetti).not.toContain('outcome');
    expect(confetti).not.toContain('shots');
  });
});

describe('first-summary explainer nudge', () => {
  it('reads the settings flag through the typed selector (key exists since settingsStore v7)', () => {
    // The defensive `(s as any).detectionExplainerSeen ?? false` bridge was
    // only for the window before the v7 key landed; the direct typed read is
    // the contract now — a removed key would fail tsc, not silently default.
    expect(src).toContain('detectionExplainerSeen');
    expect(src).not.toMatch(/as any\)\.detectionExplainerSeen/);
  });

  it('shows the nudge only until the explainer has been seen', () => {
    expect(src).toMatch(/\{!explainerSeen && \(/);
    expect(src).toContain('label="How every call is made"');
    expect(src).toContain(
      'First session? See exactly how makes, misses and UNSURE get decided.',
    );
  });
});

describe('section entrance stagger', () => {
  it('uses exactly the agreed block indices in visual order', () => {
    const indices = [...src.matchAll(/entering=\{enter\((\d+)\)\}/g)].map((m) =>
      Number(m[1]),
    );
    // hero 0 · goal-line 1 · milestone 1 · media 2 · shot map 3 · court map 4
    // · box score 5 · next up 6
    expect(indices).toEqual([0, 1, 1, 2, 3, 4, 5, 6]);
  });

  it('never staggers the snackbar, modals or coach marks', () => {
    for (const overlay of ['UndoSnackbar', 'CoachMarks', 'FramePickerModal', 'FormatPicker']) {
      const mount = src.indexOf(`<${overlay}`);
      expect(mount).toBeGreaterThan(-1);
      const before = src.slice(Math.max(0, mount - 400), mount);
      expect(before).not.toContain('entering={enter(');
    }
  });
});
