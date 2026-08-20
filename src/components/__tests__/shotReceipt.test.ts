/**
 * ShotReceipt pure derivations — the expanded receipt renders EXACTLY what
 * receiptDetail/receiptA11yLabel return, so these tests pin the honesty
 * contract at the component boundary: every string comes verbatim from the
 * evidence helpers, provenance/confidence only appear when the shot carries
 * them, and no channel state is ever upgraded on the way to the screen.
 */
// Reanimated's worklets runtime (and even its shipped mock, which re-imports
// it) can't load under jest without native modules. Stub just the surface
// ShotReceipt imports — every function under test here is pure and never
// touches the animation runtime.
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    View: require('react-native').View,
    // ui.tsx (imported for Chip) wraps Pressable at module scope.
    createAnimatedComponent: (component: unknown) => component,
  },
  FadeIn: { duration: () => ({}) },
  LinearTransition: { duration: () => ({}) },
  useReducedMotion: () => true,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withSpring: (value: unknown) => value,
}));

import { color } from '../../constants/tokens';
import {
  channelExplanation,
  confidenceLabel,
  confidenceLevel,
  EVIDENCE_CHANNELS,
  evidenceGlyph,
  evidenceSummary,
  evidenceTone,
  valueSourceLabel,
  valueSourcePhrase,
  verdictNarrative,
} from '../../core/evidence';
import type { ResolvedShot, ShotSignals } from '../../core/types';
import {
  EVIDENCE_TONE_COLOR,
  receiptA11yLabel,
  receiptDetail,
} from '../ShotReceipt';

function makeShot(over: Partial<ResolvedShot> = {}): ResolvedShot {
  return {
    id: 1,
    tStart: 10,
    tResolved: 12.4,
    outcome: 'make',
    signals: { geo: true, net: true, cls: null },
    rimBounce: false,
    xCross: 200,
    entryAngleDeg: 45,
    releaseAngleDeg: 52,
    releasePoint: null,
    originX: null,
    originY: null,
    trajectory: [],
    ...over,
  };
}

describe('receiptA11yLabel', () => {
  it('is the plain evidence summary when 2/3 estimation did not run', () => {
    const shot = makeShot();
    expect(shot.valueSource).toBeUndefined();
    expect(receiptA11yLabel(shot)).toBe(
      evidenceSummary(shot.signals, shot.rimBounce),
    );
  });

  it('appends the provenance suffix with confidence when both are present', () => {
    const shot = makeShot({ valueSource: 'court', valueConfidence: 0.9 });
    expect(receiptA11yLabel(shot)).toBe(
      evidenceSummary(shot.signals, shot.rimBounce) +
        `. Two or three call by ${valueSourceLabel('court')}, ${confidenceLabel(
          confidenceLevel(0.9),
        )} confidence`,
    );
  });

  it('never invents a confidence clause when valueConfidence is missing', () => {
    const shot = makeShot({ valueSource: 'heuristic' });
    const label = receiptA11yLabel(shot);
    expect(label).toBe(
      evidenceSummary(shot.signals, shot.rimBounce) +
        `. Two or three call by ${valueSourceLabel('heuristic')}`,
    );
    expect(label).not.toMatch(/confidence/i);
  });

  it('carries rim bounce and illusion through the evidence summary', () => {
    const signals: ShotSignals = { geo: false, net: false, cls: null, illusion: 'front' };
    const shot = makeShot({ outcome: 'miss', signals, rimBounce: true });
    expect(receiptA11yLabel(shot)).toBe(evidenceSummary(signals, true));
    expect(receiptA11yLabel(shot)).toContain('rim bounce');
  });
});

describe('receiptDetail', () => {
  it('takes the narrative verbatim from verdictNarrative (corrected flag included)', () => {
    for (const shot of [
      makeShot(),
      makeShot({ outcome: 'miss', signals: { geo: false, net: false, cls: false } }),
      makeShot({ outcome: 'unsure', signals: { geo: null, net: true, cls: null } }),
      makeShot({ rimBounce: true }),
      makeShot({ outcome: 'make', signals: { geo: false, net: false, cls: false }, corrected: true }),
    ]) {
      expect(receiptDetail(shot).narrative).toBe(
        verdictNarrative(shot.outcome, shot.signals, shot.rimBounce, shot.corrected === true),
      );
    }
  });

  it('never claims machine attribution for a corrected outcome', () => {
    // Corrections rewrite `outcome` only — signals still describe the ORIGINAL
    // machine call, so the narrative must not say the machine called it.
    const correctedMake = receiptDetail(
      makeShot({
        outcome: 'make',
        signals: { geo: false, net: false, cls: false },
        corrected: true,
      }),
    );
    expect(correctedMake.narrative).toBe(
      'You corrected this to MAKE — the signals below show the original call, not your correction.',
    );
    expect(correctedMake.narrative).not.toMatch(/Called MAKE/);
    expect(correctedMake.narrative).not.toMatch(/Called MISS/);

    const correctedMiss = receiptDetail(
      makeShot({
        outcome: 'miss',
        signals: { geo: true, net: true, cls: true },
        corrected: true,
      }),
    );
    expect(correctedMiss.narrative).toContain('You corrected this to MISS');
    expect(correctedMiss.narrative).not.toMatch(/Called MISS/);
    expect(correctedMiss.narrative).not.toMatch(/Called MAKE/);

    // The channel lines still describe the original signals untouched.
    for (const line of correctedMake.channels) {
      expect(line.glyph).toBe('✕');
      expect(line.tone).toBe('miss');
    }
  });

  it('keeps an uncorrected shot narrative byte-identical to the pre-flag copy', () => {
    // corrected undefined and corrected false must both fall through to the
    // exact machine-verdict sentences that shipped before the flag existed.
    for (const corrected of [undefined, false] as const) {
      expect(
        receiptDetail(makeShot({ corrected })).narrative,
      ).toBe('Called MAKE — the ball’s path and the net agree.');
      expect(
        receiptDetail(
          makeShot({
            outcome: 'miss',
            signals: { geo: false, net: false, cls: false },
            corrected,
          }),
        ).narrative,
      ).toBe('Called MISS — the path never went through the hoop.');
    }
  });

  it('emits one line per fusion channel, in EVIDENCE_CHANNELS order', () => {
    const shot = makeShot({ signals: { geo: true, net: false, cls: null } });
    const detail = receiptDetail(shot);
    expect(detail.channels.map((l) => l.key)).toEqual(
      EVIDENCE_CHANNELS.map((c) => c.key),
    );
    for (const line of detail.channels) {
      const value = shot.signals[line.key];
      expect(line.glyph).toBe(evidenceGlyph(value));
      expect(line.tone).toBe(evidenceTone(value));
      expect(line.text).toBe(channelExplanation(line.key, value));
    }
  });

  it('never upgrades a channel: false stays ✕/miss, null stays —/default', () => {
    const allMiss = receiptDetail(
      makeShot({ outcome: 'miss', signals: { geo: false, net: false, cls: false } }),
    );
    for (const line of allMiss.channels) {
      expect(line.glyph).toBe('✕');
      expect(line.tone).toBe('miss');
    }
    const allSilent = receiptDetail(
      makeShot({ outcome: 'unsure', signals: { geo: null, net: null, cls: null } }),
    );
    for (const line of allSilent.channels) {
      expect(line.glyph).toBe('—');
      expect(line.tone).toBe('default');
    }
  });

  it('unsure detail copy never claims a make', () => {
    const detail = receiptDetail(
      makeShot({ outcome: 'unsure', signals: { geo: null, net: true, cls: null } }),
    );
    expect(detail.narrative).toContain('UNSURE');
    expect(detail.narrative).not.toMatch(/Called MAKE/);
  });

  it('omits the provenance phrase when 2/3 estimation did not run', () => {
    expect(receiptDetail(makeShot()).provenance).toBeNull();
  });

  it('phrases the provenance verbatim from valueSourcePhrase', () => {
    for (const source of ['court', 'metric', 'heuristic', 'manual'] as const) {
      expect(receiptDetail(makeShot({ valueSource: source })).provenance).toBe(
        `2/3 call: ${valueSourcePhrase(source)}`,
      );
    }
  });
});

describe('EVIDENCE_TONE_COLOR', () => {
  it('maps tones onto the token colors the chips already use', () => {
    expect(EVIDENCE_TONE_COLOR.make).toBe(color.make);
    expect(EVIDENCE_TONE_COLOR.miss).toBe(color.miss);
    expect(EVIDENCE_TONE_COLOR.default).toBe(color.textFaint);
  });
});
