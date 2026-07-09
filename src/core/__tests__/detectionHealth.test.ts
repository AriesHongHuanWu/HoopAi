/**
 * Detection-health derivations: tier boundaries must replicate the legacy
 * DetectionHeartbeat exactly, the light sentinel (0 = never measured) must
 * never read as darkness, and the beacon/tips follow a strict precedence so
 * the HUD tells one story at a time.
 */
import {
  HEALTH_COPY,
  beaconState,
  delegateLabel,
  fpsTier,
  healthTip,
  lightTier,
  signalTier,
} from '../detectionHealth';

describe('signalTier', () => {
  test('boundaries match the legacy heartbeat (>0.3 good, >0.05 weak)', () => {
    expect(signalTier(0.31)).toBe('good');
    expect(signalTier(0.3)).toBe('weak'); // strict > — 0.3 itself is weak
    expect(signalTier(0.06)).toBe('weak');
    expect(signalTier(0.05)).toBe('blind'); // strict > — 0.05 itself is blind
    expect(signalTier(0)).toBe('blind');
  });
});

describe('fpsTier', () => {
  test('boundaries at 20 / 10 / 0', () => {
    expect(fpsTier(20)).toBe('smooth');
    expect(fpsTier(19.9)).toBe('ok');
    expect(fpsTier(10)).toBe('ok');
    expect(fpsTier(9.9)).toBe('slow');
    expect(fpsTier(0.1)).toBe('slow');
    expect(fpsTier(0)).toBe('off');
  });
});

describe('lightTier', () => {
  test('exactly 0 is the never-measured sentinel, not darkness', () => {
    expect(lightTier(0)).toBe('unmeasured');
  });

  test('real pitch-black (floored to 0.0001 upstream) reads as dark', () => {
    expect(lightTier(0.0001)).toBe('dark');
  });

  test('boundaries at 0.2 (dim) and 0.45 (good)', () => {
    expect(lightTier(0.2)).toBe('dim');
    expect(lightTier(0.45)).toBe('good');
  });
});

describe('beaconState precedence', () => {
  // Full 2×2×2 table: drift always wins, locked beats locking, a live
  // countdown without a lock means locking, all-quiet means searching.
  const cases: Array<{
    rimLocked: boolean;
    drift: boolean;
    countdown: number | null;
    expected: ReturnType<typeof beaconState>;
  }> = [
    { rimLocked: false, drift: false, countdown: null, expected: 'searching' },
    { rimLocked: false, drift: false, countdown: 3, expected: 'locking' },
    { rimLocked: true, drift: false, countdown: null, expected: 'locked' },
    { rimLocked: true, drift: false, countdown: 3, expected: 'locked' },
    { rimLocked: false, drift: true, countdown: null, expected: 'drift' },
    { rimLocked: false, drift: true, countdown: 3, expected: 'drift' },
    { rimLocked: true, drift: true, countdown: null, expected: 'drift' },
    { rimLocked: true, drift: true, countdown: 3, expected: 'drift' },
  ];

  test.each(cases)(
    'rimLocked=$rimLocked drift=$drift countdown=$countdown → $expected',
    ({ rimLocked, drift, countdown, expected }) => {
      expect(beaconState({ rimLocked, drift, countdown })).toBe(expected);
    },
  );

  test('countdown 0 still counts as locking (0 is a live countdown, not null)', () => {
    expect(beaconState({ rimLocked: false, drift: false, countdown: 0 })).toBe('locking');
  });
});

describe('delegateLabel', () => {
  test('maps known model families with a GPU/CPU suffix', () => {
    expect(delegateLabel('yolox-tiny (gpu)')).toBe('Standard model · GPU');
    expect(delegateLabel('nanoV2-416')).toBe('Compact model v2');
    expect(delegateLabel('loading')).toBe('Loading model…');
    expect(delegateLabel('mystery-thing')).toBe('On-device model');
  });

  test('nano without v2 reads as the compact model', () => {
    expect(delegateLabel('nano-320 cpu')).toBe('Compact model · CPU');
  });

  test('accelerator aliases all read as GPU', () => {
    expect(delegateLabel('yolox coreml')).toBe('Standard model · GPU');
    expect(delegateLabel('yolox nnapi')).toBe('Standard model · GPU');
    expect(delegateLabel('yolox metal')).toBe('Standard model · GPU');
  });
});

describe('healthTip priority', () => {
  test('blind signal outranks darkness and slowness', () => {
    expect(healthTip({ signal: 'blind', fps: 'slow', light: 'dark' })).toBe(
      HEALTH_COPY.tipBlind,
    );
  });

  test('darkness outranks slowness once the signal is fine', () => {
    expect(healthTip({ signal: 'good', fps: 'slow', light: 'dark' })).toBe(
      HEALTH_COPY.tipDark,
    );
  });

  test('slowness surfaces only when signal and light are fine', () => {
    expect(healthTip({ signal: 'good', fps: 'slow', light: 'good' })).toBe(
      HEALTH_COPY.tipSlow,
    );
  });

  test('all healthy → no tip', () => {
    expect(healthTip({ signal: 'good', fps: 'smooth', light: 'good' })).toBeNull();
  });
});
