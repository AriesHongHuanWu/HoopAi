/**
 * Evidence-receipt helpers: the chip content, the accessibility summary and
 * the correction-undo bookkeeping must stay honest — a channel with no data
 * reads as "no data", never as a confirmation or a denial, and undoing a
 * correction restores BOTH the outcome and the pre-correction edited flag.
 */
import {
  EVIDENCE_CHANNELS,
  confidenceLabel,
  confidenceLevel,
  correctionMessage,
  correctionRevert,
  evidenceGlyph,
  evidenceSummary,
  evidenceTone,
  valueSourceLabel,
  valueSourcePhrase,
} from '../evidence';
import type { ShotSignals, ShotValueSource } from '../types';

describe('EVIDENCE_CHANNELS', () => {
  test('covers exactly the three fusion channels, in receipt order', () => {
    expect(EVIDENCE_CHANNELS.map((c) => c.key)).toEqual(['geo', 'net', 'cls']);
  });
});

describe('evidenceGlyph / evidenceTone', () => {
  test('true reads as a green check', () => {
    expect(evidenceGlyph(true)).toBe('✓');
    expect(evidenceTone(true)).toBe('make');
  });

  test('false reads as a red x', () => {
    expect(evidenceGlyph(false)).toBe('✕');
    expect(evidenceTone(false)).toBe('miss');
  });

  test('null (channel unavailable) reads as a dim dash', () => {
    expect(evidenceGlyph(null)).toBe('—');
    expect(evidenceTone(null)).toBe('default');
  });
});

describe('evidenceSummary', () => {
  test('names every channel with its state', () => {
    const signals: ShotSignals = { geo: true, net: false, cls: null };
    expect(evidenceSummary(signals, false)).toBe(
      'Evidence: ball path through hoop yes, net movement no, ball seen in hoop no data',
    );
  });

  test('appends rim bounce when present', () => {
    const signals: ShotSignals = { geo: true, net: true, cls: true };
    expect(evidenceSummary(signals, true)).toMatch(/, rim bounce$/);
  });

  test('an all-null receipt is still an honest sentence', () => {
    const signals: ShotSignals = { geo: null, net: null, cls: null };
    const summary = evidenceSummary(signals, false);
    expect(summary).toContain('no data');
    expect(summary).not.toContain('yes');
    expect(summary).not.toContain('rim bounce');
  });
});

describe('correctionMessage', () => {
  test('reads naturally for each outcome', () => {
    expect(correctionMessage(4, 'make')).toBe('Shot 4 marked a make');
    expect(correctionMessage(9, 'miss')).toBe('Shot 9 marked a miss');
    expect(correctionMessage(2, 'unsure')).toBe('Shot 2 marked unsure');
  });
});

describe('correctionRevert', () => {
  test('restores the pre-correction outcome', () => {
    expect(correctionRevert({ outcome: 'miss', corrected: false })).toEqual({
      outcome: 'miss',
      corrected: false,
    });
  });

  test('a never-corrected shot reverts with corrected false (no stale Edited badge)', () => {
    // `corrected` is optional on ResolvedShot — undefined must mean false.
    expect(correctionRevert({ outcome: 'unsure' })).toEqual({
      outcome: 'unsure',
      corrected: false,
    });
  });

  test('a previously corrected shot keeps its edited flag on revert', () => {
    expect(correctionRevert({ outcome: 'make', corrected: true })).toEqual({
      outcome: 'make',
      corrected: true,
    });
  });
});

describe('confidence language (one shared scale)', () => {
  test('tiers at 0.8 (high) and 0.55 (medium)', () => {
    expect(confidenceLevel(0.95)).toBe('high');
    expect(confidenceLevel(0.8)).toBe('high');
    expect(confidenceLevel(0.79)).toBe('medium');
    expect(confidenceLevel(0.55)).toBe('medium');
    expect(confidenceLevel(0.54)).toBe('low');
    expect(confidenceLevel(0)).toBe('low');
  });

  test('labels are stable', () => {
    expect(confidenceLabel('high')).toBe('High');
    expect(confidenceLabel('medium')).toBe('Medium');
    expect(confidenceLabel('low')).toBe('Low');
  });
});

describe('2/3 value provenance labels', () => {
  const sources: ShotValueSource[] = ['court', 'metric', 'heuristic', 'manual'];

  test('every source has a non-empty label and phrase', () => {
    for (const s of sources) {
      expect(valueSourceLabel(s).length).toBeGreaterThan(0);
      expect(valueSourcePhrase(s).length).toBeGreaterThan(0);
    }
  });

  test('court reads as the corner-accurate registered source', () => {
    expect(valueSourceLabel('court')).toBe('Court-registered');
    expect(valueSourcePhrase('court')).toMatch(/corner-accurate/);
  });
});
