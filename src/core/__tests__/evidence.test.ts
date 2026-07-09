/**
 * Evidence-receipt helpers: the chip content, the accessibility summary and
 * the correction-undo bookkeeping must stay honest — a channel with no data
 * reads as "no data", never as a confirmation or a denial, and undoing a
 * correction restores BOTH the outcome and the pre-correction edited flag.
 */
import {
  EVIDENCE_CHANNELS,
  channelExplanation,
  confidenceLabel,
  confidenceLevel,
  correctionMessage,
  correctionRevert,
  evidenceGlyph,
  evidenceSummary,
  evidenceTone,
  illusionChipLabel,
  illusionPhrase,
  valueSourceLabel,
  valueSourcePhrase,
  verdictNarrative,
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

  test('explains a depth-illusion veto in the summary', () => {
    const signals: ShotSignals = { geo: false, net: null, cls: false, illusion: 'front' };
    expect(evidenceSummary(signals, false)).toMatch(/in front of the hoop — optical illusion/);
  });
});

describe('illusionChipLabel / illusionPhrase (depth-illusion receipt)', () => {
  test('a front-pass veto reads as an IN FRONT miss chip + human phrase', () => {
    const signals: ShotSignals = { geo: false, net: null, cls: false, illusion: 'front' };
    expect(illusionChipLabel(signals)).toBe('✕ IN FRONT');
    expect(illusionPhrase(signals)).toMatch(/front of the hoop/);
  });

  test('a behind-pass veto reads as a BEHIND miss chip', () => {
    const signals: ShotSignals = { geo: false, net: null, cls: false, illusion: 'behind' };
    expect(illusionChipLabel(signals)).toBe('✕ BEHIND');
    expect(illusionPhrase(signals)).toMatch(/behind the hoop/);
  });

  test('no illusion tag → no chip, no phrase (silent on ordinary shots)', () => {
    const signals: ShotSignals = { geo: true, net: true, cls: false };
    expect(illusionChipLabel(signals)).toBeNull();
    expect(illusionPhrase(signals)).toBeNull();
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

describe('receipt detail — channelExplanation + verdictNarrative', () => {
  test('all nine channel/state combos are pinned exactly', () => {
    expect(channelExplanation('geo', true)).toBe(
      'Path — the tracked flight crossed down through the hoop',
    );
    expect(channelExplanation('geo', false)).toBe(
      'Path — the tracked flight never went through the hoop',
    );
    expect(channelExplanation('geo', null)).toBe(
      'Path — the crossing was blocked from view',
    );
    expect(channelExplanation('net', true)).toBe(
      'Net — the net moved right when the ball arrived',
    );
    expect(channelExplanation('net', false)).toBe('Net — the net stayed still');
    expect(channelExplanation('net', null)).toBe('Net — no net in view on this hoop');
    expect(channelExplanation('cls', true)).toBe(
      'Seen — the AI saw the ball inside the hoop',
    );
    expect(channelExplanation('cls', false)).toBe(
      'Seen — the AI never saw the ball inside the hoop',
    );
    expect(channelExplanation('cls', null)).toBe('Seen — no clear look inside the hoop');
  });

  test('make with path + net agreement cites both', () => {
    const signals: ShotSignals = { geo: true, net: true, cls: null };
    expect(verdictNarrative('make', signals, false)).toContain('path and the net agree');
  });

  test('make on a netless hoop explains the missing net', () => {
    const signals: ShotSignals = { geo: true, net: null, cls: true };
    expect(verdictNarrative('make', signals, false)).toContain('no net in view');
  });

  test('make from net + seen (path blocked) cites the inside look', () => {
    const signals: ShotSignals = { geo: null, net: true, cls: true };
    expect(verdictNarrative('make', signals, false)).toContain('seen inside');
  });

  test('miss with a failed path test explains the path', () => {
    const signals: ShotSignals = { geo: false, net: false, cls: false };
    expect(verdictNarrative('miss', signals, false)).toContain('never went through');
  });

  test('miss from a depth-illusion veto explains the angle trick', () => {
    const signals: ShotSignals = { geo: false, net: null, cls: false, illusion: 'front' };
    expect(verdictNarrative('miss', signals, false)).toContain('LOOKED like');
  });

  test('unsure says the app declined to guess and never says MAKE', () => {
    const signals: ShotSignals = { geo: true, net: false, cls: null };
    const narrative = verdictNarrative('unsure', signals, false);
    expect(narrative).toContain('no guess');
    expect(narrative).not.toContain('MAKE');
  });

  test('no miss narrative ever contains the word MAKE (bread-ball copy rule)', () => {
    const missSignals: ShotSignals[] = [
      { geo: false, net: false, cls: false },
      { geo: false, net: null, cls: false, illusion: 'front' },
      { geo: false, net: null, cls: false, illusion: 'behind' },
      { geo: null, net: null, cls: null },
      { geo: null, net: false, cls: null },
    ];
    for (const signals of missSignals) {
      for (const rimBounce of [false, true]) {
        expect(verdictNarrative('miss', signals, rimBounce)).not.toContain('MAKE');
      }
    }
  });

  // Corrections rewrite outcome but never signalsJson, so a corrected shot's
  // signals still describe the ORIGINAL machine call. The machine-verdict
  // sentences would fabricate attribution ("Called MAKE — the strongest
  // signals pointed in." over three ✕ channels) — corrected shots must get
  // the honest correction sentence instead.
  test('a corrected shot never claims a machine verdict', () => {
    const allNo: ShotSignals = { geo: false, net: false, cls: false };
    // Swipe-corrected miss→make over all-NO signals: the exact fabrication case.
    const n = verdictNarrative('make', allNo, false, true);
    expect(n).not.toContain('Called');
    expect(n).not.toContain('signals pointed in');
    expect(n).toContain('You corrected this to MAKE');
    expect(n).toContain('original call');
    // Corrected to miss / unsure keep the bread-ball copy rule: no MAKE.
    const yes: ShotSignals = { geo: true, net: true, cls: true };
    expect(verdictNarrative('miss', yes, false, true)).not.toContain('MAKE');
    expect(verdictNarrative('miss', yes, false, true)).toContain('You corrected this to MISS');
    expect(verdictNarrative('unsure', yes, true, true)).not.toContain('MAKE');
    expect(verdictNarrative('unsure', yes, true, true)).toContain('UNSURE');
    // The rattle suffix is a machine observation of the ORIGINAL call — the
    // correction sentence stays clean of it.
    expect(verdictNarrative('make', allNo, true, true)).not.toContain('rattled');
  });

  test('corrected=false / omitted keeps the machine narrative byte-identical', () => {
    const signals: ShotSignals = { geo: true, net: true, cls: null };
    expect(verdictNarrative('make', signals, false, false)).toBe(
      verdictNarrative('make', signals, false),
    );
    expect(verdictNarrative('make', signals, false)).toContain('Called MAKE');
  });

  test('rim bounce appends the rattle sentence for make and miss but not unsure', () => {
    const signals: ShotSignals = { geo: true, net: true, cls: true };
    expect(verdictNarrative('make', signals, true)).toMatch(
      / It rattled the rim on the way\.$/,
    );
    expect(verdictNarrative('miss', { geo: false, net: false, cls: false }, true)).toMatch(
      / It rattled the rim on the way\.$/,
    );
    expect(verdictNarrative('unsure', signals, true)).not.toContain('rattled');
    expect(verdictNarrative('make', signals, false)).not.toContain('rattled');
  });
});
