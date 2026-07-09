/**
 * calibrationGuide tests. Diagram geometry is checked against both rulebooks'
 * real metric specs; the checklist and health model are exercised over their
 * full state matrices, including the light===0 "never measured" sentinel and
 * the honesty rule (no item detail may ever claim anything is saved).
 */
import {
  landmarkGuide,
  closePair,
  qualityTier,
  qualityLabel,
  rimAimChecklist,
  buildCalibrationHealth,
  daysAgoLabel,
  LOW_LIGHT_THRESHOLD,
  WHY_CALIBRATE,
  PLACEMENT_STEPS,
  type AimSnap,
  type HealthInput,
} from '../calibrationGuide';
import { CALIBRATION_LANDMARK_IDS, FIBA_COURT, NBA_COURT, type CourtSpec } from '../courtModel';

const DAY_MS = 86400000;
const NOW = 1_700_000_000_000;

describe('landmarkGuide', () => {
  function checkSpec(spec: CourtSpec) {
    const entries = landmarkGuide(spec);
    expect(entries.map((e) => e.id)).toEqual([...CALIBRATION_LANDMARK_IDS]);
    const byId = new Map(entries.map((e) => [e.id, e]));

    for (const e of entries) {
      expect(e.pos.x).toBeGreaterThanOrEqual(0);
      expect(e.pos.x).toBeLessThanOrEqual(1);
      expect(e.pos.y).toBeGreaterThanOrEqual(0);
      expect(e.pos.y).toBeLessThanOrEqual(1);
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.instruction.length).toBeGreaterThan(0);
      expect(e.tip.length).toBeGreaterThan(0);
    }

    // Basket: centered on x, near the baseline end of the diagram.
    const basket = byId.get('basket')!;
    expect(Math.abs(basket.pos.x - 0.5)).toBeLessThanOrEqual(0.01);
    expect(basket.pos.y).toBeLessThan(0.25);

    // Corners: on the baseline (y≈0), left of / right of center.
    const left = byId.get('cornerThreeLeft')!;
    const right = byId.get('cornerThreeRight')!;
    expect(left.pos.y).toBeLessThan(0.1);
    expect(right.pos.y).toBeLessThan(0.1);
    expect(left.pos.x).toBeLessThan(0.5);
    expect(right.pos.x).toBeGreaterThan(0.5);

    // The arc apex sits deeper into the court than the FT line.
    expect(byId.get('topOfArc')!.pos.y).toBeGreaterThan(byId.get('ftCenter')!.pos.y);
  }

  test('FIBA court: 5 entries in ritual order with sane diagram positions', () => {
    checkSpec(FIBA_COURT);
  });

  test('NBA court: same invariants hold for the deeper arc', () => {
    checkSpec(NBA_COURT);
  });
});

describe('closePair', () => {
  test('well-separated points return null', () => {
    const pts = [
      { id: 'basket' as const, x: 0, y: 0 },
      { id: 'topOfArc' as const, x: 100, y: 100 },
    ];
    expect(closePair(pts, 28)).toBeNull();
  });

  test('a near-coincident pair is reported with both offending ids', () => {
    const pts = [
      { id: 'basket' as const, x: 0, y: 0 },
      { id: 'topOfArc' as const, x: 100, y: 100 },
      { id: 'ftCenter' as const, x: 10, y: 10 },
    ];
    const pair = closePair(pts, 28);
    expect(pair).not.toBeNull();
    expect(pair).toContain('basket');
    expect(pair).toContain('ftCenter');
  });

  test('a single point can never form a pair', () => {
    expect(closePair([{ id: 'basket', x: 5, y: 5 }], 28)).toBeNull();
  });
});

describe('qualityTier / qualityLabel', () => {
  test('tier boundaries align with the engine acceptance range', () => {
    expect(qualityTier(0.1)).toBe('dialed');
    expect(qualityTier(0.15)).toBe('dialed');
    expect(qualityTier(0.16)).toBe('good');
    expect(qualityTier(0.3)).toBe('good');
    expect(qualityTier(0.31)).toBe('rough');
    expect(qualityTier(0.49)).toBe('rough');
  });

  test('every tier has a distinct label', () => {
    const labels = (['dialed', 'good', 'rough'] as const).map(qualityLabel);
    expect(new Set(labels).size).toBe(3);
    expect(qualityLabel('good')).toContain('±0.3 m');
  });
});

describe('rimAimChecklist', () => {
  const snap = (over: Partial<AimSnap>): AimSnap => ({
    rimSeen: false,
    countdown: null,
    locked: false,
    light: 0,
    ...over,
  });
  const states = (s: AimSnap) => rimAimChecklist(s).steps.map((st) => st.state);

  test('no rim yet: hunting for the frame', () => {
    const { steps, lowLight } = rimAimChecklist(snap({}));
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.id)).toEqual(['find', 'steady', 'locked']);
    expect(states(snap({}))).toEqual(['doing', 'todo', 'todo']);
    expect(lowLight).toBe(false); // light 0 = never measured, must not flag
  });

  test('rim seen but not steady yet', () => {
    expect(states(snap({ rimSeen: true }))).toEqual(['done', 'todo', 'todo']);
  });

  test('countdown running: steady step is live', () => {
    expect(states(snap({ rimSeen: true, countdown: 2 }))).toEqual(['done', 'doing', 'todo']);
  });

  test('locked: everything done regardless of the rest of the snapshot', () => {
    expect(states(snap({ locked: true }))).toEqual(['done', 'done', 'done']);
  });

  test('lowLight flags only for measured-and-dim light', () => {
    expect(rimAimChecklist(snap({ light: 0 })).lowLight).toBe(false);
    expect(rimAimChecklist(snap({ light: 0.1 })).lowLight).toBe(true);
    expect(rimAimChecklist(snap({ light: 0.2 })).lowLight).toBe(false);
    expect(rimAimChecklist(snap({ light: LOW_LIGHT_THRESHOLD })).lowLight).toBe(false);
  });
});

describe('buildCalibrationHealth', () => {
  const input = (over: Partial<HealthInput>): HealthInput => ({
    hasRegistration: false,
    reprojectionErrorM: null,
    hasFtCal: false,
    lastCourtCal: null,
    lastFtCal: null,
    nowMs: NOW,
    ...over,
  });
  const item = (h: ReturnType<typeof buildCalibrationHealth>, key: string) =>
    h.items.find((i) => i.key === key)!;

  test('active registration reports its quality tier', () => {
    const h = buildCalibrationHealth(input({ hasRegistration: true, reprojectionErrorM: 0.2 }));
    const court = item(h, 'court');
    expect(court.status).toBe('active');
    expect(court.detail).toContain('Active this session');
    expect(court.detail).toContain('±0.3 m'); // 0.2 m → 'good' tier label
  });

  test('a past court-tap shows as a receipt, never as active', () => {
    const h = buildCalibrationHealth(
      input({ lastCourtCal: { ts: NOW - 3 * DAY_MS, reprojErrM: 0.21 } }),
    );
    const court = item(h, 'court');
    expect(court.status).toBe('idle');
    expect(court.detail).toContain('3 days ago');
    expect(court.detail).toContain('±0.21 m');
  });

  test('active FT calibration vs FT receipt', () => {
    const active = item(buildCalibrationHealth(input({ hasFtCal: true })), 'ft');
    expect(active.status).toBe('active');
    expect(active.detail).toContain('measured');

    const receipt = item(
      buildCalibrationHealth(input({ lastFtCal: { ts: NOW - 1.5 * DAY_MS } })),
      'ft',
    );
    expect(receipt.status).toBe('idle');
    expect(receipt.detail).toContain('yesterday');
  });

  test('all-null input: everything idle, honesty footer exact', () => {
    const h = buildCalibrationHealth(input({}));
    expect(h.items.map((i) => i.key)).toEqual(['rim', 'court', 'ft']);
    for (const i of h.items) expect(i.status).toBe('idle');
    expect(h.footer).toBe(
      'Calibration lives and dies with your camera position — it is never saved between sessions.',
    );
  });

  test('honesty rule: no item detail ever claims anything is saved', () => {
    const variants: HealthInput[] = [
      input({}),
      input({ hasRegistration: true, reprojectionErrorM: 0.1, hasFtCal: true }),
      input({
        lastCourtCal: { ts: NOW - 10 * DAY_MS, reprojErrM: 0.4 },
        lastFtCal: { ts: NOW - DAY_MS },
      }),
    ];
    for (const v of variants) {
      for (const i of buildCalibrationHealth(v).items) {
        expect(i.detail).not.toContain('saved');
        expect(i.benefit).not.toContain('saved');
      }
    }
  });
});

describe('daysAgoLabel', () => {
  test('recency buckets', () => {
    expect(daysAgoLabel(NOW, NOW)).toBe('today');
    expect(daysAgoLabel(NOW, NOW - 0.9 * DAY_MS)).toBe('today');
    expect(daysAgoLabel(NOW, NOW - 1.5 * DAY_MS)).toBe('yesterday');
    expect(daysAgoLabel(NOW, NOW - 5 * DAY_MS)).toBe('5 days ago');
  });
});

describe('guide copy constants', () => {
  test('ladder sources align with evidence.ts valueSource language', () => {
    expect(WHY_CALIBRATE.ladder.map((l) => l.source)).toEqual(['heuristic', 'metric', 'court']);
    expect(WHY_CALIBRATE.ladder.map((l) => l.label)).toEqual([
      'Estimated',
      'Measured',
      'Court-registered',
    ]);
  });

  test('placement coach has the three placement rules', () => {
    expect(PLACEMENT_STEPS.map((s) => s.id)).toEqual(['side', 'frame', 'height']);
  });
});
