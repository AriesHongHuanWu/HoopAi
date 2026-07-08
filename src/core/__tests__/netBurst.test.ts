/**
 * netBurstInWindow tests — the rim-bounce net-timing fix.
 *
 * A rim rattle re-ascends and drops LATE, so a genuine swish burst can land
 * past the symmetric window around the (early) first crossing. The
 * forward-only window (graceSec > 0) recovers it; the raised rim-bounce
 * threshold (1.5×) still vets every sample so a bounce-OUT graze can't sneak in.
 */
import { netBurstInWindow } from '../shotFsm';

const WIN = 0.35;
const GRACE = 0.25;
const RAISED = 0.25 * 1.5; // 0.375 — rim-bounce threshold
const REF = 0.1; // first-crossing time

describe('netBurstInWindow — rim-bounce forward window (grace > 0)', () => {
  test('REAL-MAKE-KEPT: a late swish burst above the raised threshold is caught', () => {
    // Drop at t=0.45 (0.35s after crossing) — past the symmetric window, inside
    // the forward window [0.10, 0.70]. Score 0.40 > raised 0.375.
    const samples = [{ t: 0.45, score: 0.4 }];
    expect(netBurstInWindow(samples, REF, RAISED, WIN, GRACE)).toBe(true);
  });

  test('BREAD-BALL-REJECT: a weak graze below the raised threshold is NOT a burst', () => {
    // A bounce-out graze: in-window but score 0.30 < raised 0.375.
    const samples = [{ t: 0.45, score: 0.3 }];
    expect(netBurstInWindow(samples, REF, RAISED, WIN, GRACE)).toBe(false);
  });

  test('rejects a burst past the forward grace window', () => {
    // 0.75 > 0.10 + 0.35 + 0.25 = 0.70.
    expect(netBurstInWindow([{ t: 0.75, score: 0.9 }], REF, RAISED, WIN, GRACE)).toBe(false);
  });

  test('the forward boundary (ref + window + grace) is inclusive', () => {
    expect(netBurstInWindow([{ t: 0.7, score: 0.9 }], REF, RAISED, WIN, GRACE)).toBe(true);
  });

  test('forward-only: a PRE-crossing burst does not count', () => {
    // t=0.05 is before ref=0.10 — excluded by the forward-only window even
    // though a symmetric window would include it.
    expect(netBurstInWindow([{ t: 0.05, score: 0.9 }], REF, RAISED, WIN, GRACE)).toBe(false);
  });
});

describe('netBurstInWindow — normal symmetric window (grace = 0)', () => {
  test('a burst just before the crossing counts (symmetric)', () => {
    // |0.05 - 0.10| = 0.05 <= 0.35.
    expect(netBurstInWindow([{ t: 0.05, score: 0.3 }], REF, 0.25, WIN, 0)).toBe(true);
  });

  test('a burst past the symmetric window does NOT count (unchanged behaviour)', () => {
    // |0.50 - 0.10| = 0.40 > 0.35 — the exact late-drop the rim-bounce path fixes.
    expect(netBurstInWindow([{ t: 0.5, score: 0.9 }], REF, 0.25, WIN, 0)).toBe(false);
  });

  test('no samples is never a burst', () => {
    expect(netBurstInWindow([], REF, 0.25, WIN, 0)).toBe(false);
    expect(netBurstInWindow([], REF, RAISED, WIN, GRACE)).toBe(false);
  });
});
