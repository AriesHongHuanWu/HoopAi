/**
 * Acquisition-funnel formatting/diffing tests.
 *
 * The funnel is recording-only, so these tests pin the EXACT diagnostic
 * string format (a field COPY DIAG paste must stay machine-greppable across
 * releases) and the display-precision change detector that keeps the debug
 * panel from re-rendering on float dust.
 */
import {
  EMPTY_FUNNEL,
  formatFunnelDiag,
  funnelChanged,
  type FrameFunnel,
} from '../acquisitionFunnel';
import { DETECTION } from '../config';

/** A fully-active funnel frame used as the mutation base in tests. */
function funnel(overrides: Partial<FrameFunnel> = {}): FrameFunnel {
  return {
    ballDets: 3,
    floor: 0.35,
    gate: 'cold',
    rejScore: 12,
    rejSize: 0,
    rejAspect: 3,
    rejJump: 1,
    lastReject: 'score',
    accepted: false,
    rescued: false,
    rawBall: 3,
    track: 'none',
    armRefusal: 'no-branch',
    dribbleLatch: true,
    arcR2y: 0.72,
    arcSuppressed: true,
    ...overrides,
  };
}

describe('EMPTY_FUNNEL', () => {
  test('is inert, frozen, and reports the open-court default floor', () => {
    expect(Object.isFrozen(EMPTY_FUNNEL)).toBe(true);
    expect(EMPTY_FUNNEL.floor).toBe(DETECTION.ballScoreMin);
    expect(EMPTY_FUNNEL.gate).toBe('none');
    expect(EMPTY_FUNNEL.track).toBe('none');
    expect(EMPTY_FUNNEL.armRefusal).toBe('no-rim');
    expect(EMPTY_FUNNEL.lastReject).toBeNull();
    expect(EMPTY_FUNNEL.arcR2y).toBeNull();
    expect(EMPTY_FUNNEL.ballDets).toBe(0);
    expect(EMPTY_FUNNEL.rawBall).toBe(0);
    expect(
      EMPTY_FUNNEL.rejScore +
        EMPTY_FUNNEL.rejSize +
        EMPTY_FUNNEL.rejAspect +
        EMPTY_FUNNEL.rejJump,
    ).toBe(0);
    expect(EMPTY_FUNNEL.accepted).toBe(false);
    expect(EMPTY_FUNNEL.rescued).toBe(false);
    expect(EMPTY_FUNNEL.dribbleLatch).toBe(false);
    expect(EMPTY_FUNNEL.arcSuppressed).toBe(false);
  });
});

describe('formatFunnelDiag', () => {
  test('fully-active frame matches the pinned two-line format exactly', () => {
    const [l1, l2] = formatFunnelDiag(funnel());
    expect(l1).toBe('gates: floor 0.35 cold · ball 3 · rej s12 a3 j1 z0');
    expect(l2).toBe('arm: no-branch · dribble latched · arc r2 0.72 SUPPRESSED');
  });

  test('inactive segments are omitted (quiet IDLE frame)', () => {
    const [l1, l2] = formatFunnelDiag({
      ...EMPTY_FUNNEL,
      floor: 0.2,
      gate: 'none',
    });
    expect(l1).toBe('gates: floor 0.20 none · ball 0 · rej s0 a0 j0 z0');
    // No dribble latch, no suppression, no arc fit: only the arm segment.
    expect(l2).toBe('arm: no-rim');
  });

  test('arc segment appears without SUPPRESSED when the arc draws', () => {
    const [, l2] = formatFunnelDiag(
      funnel({
        armRefusal: 'live',
        dribbleLatch: false,
        arcSuppressed: false,
        arcR2y: 0.9,
      }),
    );
    expect(l2).toBe('arm: live · arc r2 0.90');
  });

  test('suppression without a held latch reads "dribble clear" (apex rule)', () => {
    const [, l2] = formatFunnelDiag(
      funnel({ dribbleLatch: false, arcSuppressed: true, arcR2y: 0.81 }),
    );
    expect(l2).toBe('arm: no-branch · dribble clear · arc r2 0.81 SUPPRESSED');
  });

  test('dribble latch shows even with no arc fit (arcR2y null)', () => {
    const [, l2] = formatFunnelDiag(
      funnel({ arcR2y: null, arcSuppressed: false, dribbleLatch: true }),
    );
    expect(l2).toBe('arm: no-branch · dribble latched');
  });

  test('floor always prints at 2 decimals with the gate word', () => {
    const [l1] = formatFunnelDiag(funnel({ floor: 0.16, gate: 'tracking' }));
    expect(l1.startsWith('gates: floor 0.16 tracking')).toBe(true);
    const [hoop] = formatFunnelDiag(funnel({ floor: 0.1, gate: 'hoopRoi' }));
    expect(hoop.startsWith('gates: floor 0.10 hoopRoi')).toBe(true);
  });
});

describe('funnelChanged', () => {
  test('identical frames do not change', () => {
    expect(funnelChanged(funnel(), funnel())).toBe(false);
  });

  test('float dust below display precision does not change', () => {
    // Same 2-decimal display for floor and arcR2y => no re-render.
    expect(
      funnelChanged(
        funnel({ floor: 0.3501, arcR2y: 0.721 }),
        funnel({ floor: 0.3549, arcR2y: 0.724 }),
      ),
    ).toBe(false);
  });

  test('display-visible float movement changes', () => {
    expect(funnelChanged(funnel({ floor: 0.35 }), funnel({ floor: 0.36 }))).toBe(
      true,
    );
    expect(
      funnelChanged(funnel({ arcR2y: 0.72 }), funnel({ arcR2y: 0.73 })),
    ).toBe(true);
  });

  test('arcR2y null vs a fit changes (null-aware compare)', () => {
    expect(funnelChanged(funnel({ arcR2y: null }), funnel({ arcR2y: 0.72 }))).toBe(
      true,
    );
    expect(funnelChanged(funnel({ arcR2y: null }), funnel({ arcR2y: null }))).toBe(
      false,
    );
  });

  test('every counter and enum is significant', () => {
    const base = funnel();
    const variants: Partial<FrameFunnel>[] = [
      { ballDets: 4 },
      { gate: 'tracking' },
      { rejScore: 13 },
      { rejSize: 1 },
      { rejAspect: 4 },
      { rejJump: 2 },
      { lastReject: 'jump' },
      { accepted: true },
      { rescued: true },
      { rawBall: 4 },
      { track: 'real' },
      { armRefusal: 'cooldown' },
      { dribbleLatch: false },
      { arcSuppressed: false },
    ];
    for (const v of variants) {
      expect(funnelChanged(base, funnel(v))).toBe(true);
    }
  });
});
