/**
 * Form Studio 3D screen source contracts (WI-D) — formstudio3d.tsx pulls in
 * expo-router, sqlite, Skia and gesture-handler, so a full render under jest
 * is not honest coverage. Instead these tests pin the load-bearing GATING,
 * MOTION-ACCESSIBILITY and HONESTY-COPY contracts at the source level (same
 * approach as summaryScreenContract.test.ts):
 *
 * 1. REDUCED MOTION — preset tween snaps instantly, the auto-orbit loop is
 *    inert AND its pill is hidden entirely.
 * 2. USER GESTURES WIN — onCameraChange cancels the tween, stops the orbit
 *    and drops the preset highlight before following the drag.
 * 3. HONESTY COPY — trail caption says pose-estimated (not ball tracking),
 *    the coach overlay leads with "an estimate, not a scan", and compare
 *    copy calls both shots estimated reconstructions.
 * 4. CALLOUTS — render only at the release frame, never while comparing, and
 *    flow through angleText so the "≈" low-confidence prefix reaches the scene.
 * 5. COMPARE — ghost fully suppressed while comparing (reference={null} on
 *    both stages + the ghost card swaps to an explanation), and an unliftable
 *    shot B gets an honest refusal, never a made-up skeleton.
 * 6. COACH GATING — steps are empty until the stage has real content, so the
 *    walkthrough never teaches over off/empty/loading states; mounted as a
 *    sibling of <Screen> exactly like Home.
 * 7. READ-ONLY — the screen writes nothing itself (tutorial-seen goes through
 *    the useCoachMarks hook, not a direct store call).
 */
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(
  path.join(__dirname, '..', '..', 'app', 'formstudio3d.tsx'),
  'utf8',
);

describe('reduced motion', () => {
  it('snaps presets instantly instead of tweening', () => {
    expect(src).toMatch(/if \(reducedMotion\) \{\s*setCam\(target\);\s*return;\s*\}/);
  });

  it('keeps the auto-orbit loop inert under reduced motion', () => {
    expect(src).toContain('if (!orbiting || reducedMotion) return;');
  });

  it('hides the ORBIT pill entirely under reduced motion', () => {
    const orbitPill = src.indexOf('label="ORBIT"');
    expect(orbitPill).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, orbitPill - 700), orbitPill);
    expect(before).toContain('{!reducedMotion && (');
  });
});

describe('user gestures own the camera', () => {
  it('onCameraChange cancels tween + orbit + preset highlight, then follows', () => {
    expect(src).toMatch(
      /const onStageCamera = \(next: OrbitCamera\) => \{\s*cancelTween\(\);\s*setOrbiting\(false\);\s*setActivePreset\(null\);\s*setCam\(next\);\s*\};/,
    );
  });

  it('every mounted stage dispatches through onStageCamera', () => {
    const stages = src.match(/<FormStage3D/g) ?? [];
    const wired = src.match(/onCameraChange=\{onStageCamera\}/g) ?? [];
    expect(stages.length).toBeGreaterThan(0);
    expect(wired).toHaveLength(stages.length);
  });

  it('selection change stops the showcase orbit', () => {
    expect(src).toMatch(/setPlaying\(false\);\s*setPos\(0\);\s*setOrbiting\(false\);/);
  });
});

describe('honesty copy', () => {
  it('captions the trail as pose-derived, not ball tracking', () => {
    expect(src).toContain('Wrist path is estimated from pose — not ball tracking.');
  });

  it('coach overlay leads with the estimate-not-scan step', () => {
    const first = src.indexOf("title: 'An estimate, not a scan'");
    expect(first).toBeGreaterThan(-1);
    for (const title of ["'Orbit the shot'", "'Scrub and freeze'", "'Compare two shots'"]) {
      expect(src.indexOf(title)).toBeGreaterThan(first);
    }
    expect(src).toContain('solid joints are trusted, hollow rings are estimated');
  });

  it('compare footnote calls both shots estimated reconstructions', () => {
    expect(src).toContain(
      'Both shots are estimated reconstructions — one shared camera, one shared',
    );
  });

  it('references stay labeled synthesized, never motion capture', () => {
    expect(src).toContain('synthesized from published mechanics — not motion');
  });
});

describe('release callouts', () => {
  it('render only at the release frame and never while comparing', () => {
    expect(src).toContain(
      'if (!readouts || compareIdx != null || curFrame !== readouts.frame) return [];',
    );
  });

  it('reuse angleText so the ≈ low-confidence prefix reaches the scene', () => {
    expect(src).toMatch(/text: `ELBOW \$\{angleText\(readouts\.elbow\)\}`/);
    expect(src).toMatch(/text: `KNEE \$\{angleText\(readouts\.knee\)\}`/);
    expect(src).toMatch(/text: `TILT \$\{angleText\(readouts\.forearmTilt\)\}`/);
  });

  it('never invents a callout for an absent reading', () => {
    for (const key of ['elbow', 'knee', 'forearmTilt']) {
      expect(src).toContain(`if (readouts.${key}) {`);
    }
  });
});

describe('side-by-side compare', () => {
  it('suppresses the ghost on both compare stages', () => {
    // Both half-width stages pass reference={null}; the single-stage path
    // additionally gates on compareActive for safety.
    const nullRefs = src.match(/reference=\{null\}/g) ?? [];
    expect(nullRefs.length).toBe(2);
    expect(src).toContain('reference={compareActive ? null : refLifted}');
  });

  it('swaps the ghost card controls for an explanation while comparing', () => {
    expect(src).toContain('NBA ghost is hidden while comparing two shots side by side.');
  });

  it('refuses honestly when shot B cannot be lifted', () => {
    expect(src).toContain('3D unavailable for that shot — the camera hid too much of');
  });

  it('drops a compare pick that leaves range or collides with shot A', () => {
    expect(src).toContain(
      'if (compareIdx != null && (compareIdx >= studioShots.length || compareIdx === shotIdx))',
    );
  });

  it('readout secondary line switches from ghost to B while comparing', () => {
    const prefixes = src.match(/secondaryPrefix=\{compareActive \? 'B' : 'ghost'\}/g) ?? [];
    expect(prefixes).toHaveLength(3);
  });

  it('compare picker card takes stagger index 5, keeping 0-4 intact', () => {
    const indices = [...src.matchAll(/entering=\{cardEnter\((\d+)\)\}/g)].map((m) => Number(m[1]));
    expect(indices).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('share still', () => {
  it('never throws into the UI and always restores the button', () => {
    expect(src).toMatch(/void shareStage3DStill\(data\)\.finally\(\(\) => setSharing\(false\)\);/);
    expect(src).toContain('disabled={sharing}');
  });

  it('stamps the depth-confidence tier into the export data', () => {
    expect(src).toMatch(
      /confidenceLine: `DEPTH CONFIDENCE: \$\{confidenceLabel\(depthLevel\)\.toUpperCase\(\)\}`/,
    );
  });

  it('subtitle carries angleText (≈-prefixed) readings, never raw numbers', () => {
    expect(src).toContain(
      'ELBOW ${angleText(readouts.elbow)} · KNEE ${angleText(readouts.knee)} · FOREARM TILT ${angleText(readouts.forearmTilt)}',
    );
  });
});

describe('coach overlay gating + mount', () => {
  it('teaches only once the stage has real content', () => {
    expect(src).toContain(
      'const ready = replay3d && !loading && studioShots.length > 0 && lifted != null;',
    );
    expect(src).toContain("useCoachMarks('formstudio3d', ready ? FORM3D_STEPS : [])");
  });

  it('mounts as a sibling of <Screen> in the Home call-site shape', () => {
    expect(src).toMatch(
      /\{coach\.visible && \(\s*<CoachMarks steps=\{coach\.steps\} onFinish=\{coach\.finish\} onSkip=\{coach\.finish\} \/>\s*\)\}/,
    );
  });

  it('steps are centered — no targetRect over scrollable content', () => {
    // Property form only (comments may explain WHY there is none).
    expect(src).not.toContain('targetRect:');
  });
});

describe('read-only screen', () => {
  it('never writes to stores or db directly', () => {
    // Tutorial-seen persistence flows through useCoachMarks, not the screen —
    // ban the CALL form (the header comment may mention the name).
    expect(src).not.toMatch(/markTutorialSeen\(/);
    // Only reads: sessionShots/shotFromRow. No inserts/updates/execs.
    expect(src).not.toMatch(/\b(insertShot|updateShot|execAsync|runAsync)\b/);
  });
});
