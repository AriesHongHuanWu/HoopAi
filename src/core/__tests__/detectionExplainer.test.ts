/**
 * detectionExplainer tests. The explainer is a trust surface — these lock the
 * copy to the receipt channels it claims to describe and enforce the honesty
 * invariants: a make demo must carry geometric evidence (bread-ball rule at
 * the copy layer), and no line may ever claim corrections retrain detection
 * (corrections rewrite outcome only — nothing learns from them).
 */
import { EXPLAINER } from '../detectionExplainer';
import { EVIDENCE_CHANNELS, evidenceGlyph, evidenceSummary, evidenceTone } from '../evidence';

/** Every user-facing string in the module, flattened. */
function allCopy(): string[] {
  return [
    EXPLAINER.headline,
    EXPLAINER.lede,
    ...EXPLAINER.signals.flatMap((s) => [s.title, s.body]),
    ...EXPLAINER.rules.flatMap((r) => [r.title, r.body]),
  ];
}

describe('signals', () => {
  test('keys exactly equal EVIDENCE_CHANNELS keys, in receipt order', () => {
    expect(EXPLAINER.signals.map((s) => s.key)).toEqual(EVIDENCE_CHANNELS.map((c) => c.key));
  });

  test('every signal has a nonempty title and body', () => {
    for (const s of EXPLAINER.signals) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
    }
  });

  test('headline and lede are nonempty', () => {
    expect(EXPLAINER.headline.length).toBeGreaterThan(0);
    expect(EXPLAINER.lede.length).toBeGreaterThan(0);
  });
});

describe('rules', () => {
  test('exactly three rules, each with nonempty icon, title and body', () => {
    expect(EXPLAINER.rules).toHaveLength(3);
    for (const r of EXPLAINER.rules) {
      expect(r.icon.length).toBeGreaterThan(0);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.body.length).toBeGreaterThan(0);
    }
  });
});

describe('receipt demo', () => {
  test('renders through the real evidence helpers for every channel', () => {
    for (const c of EVIDENCE_CHANNELS) {
      const value = EXPLAINER.receiptDemo.signals[c.key];
      expect([true, false, null]).toContain(value);
      expect(['✓', '✕', '—']).toContain(evidenceGlyph(value));
      expect(['make', 'miss', 'default']).toContain(evidenceTone(value));
    }
  });

  test('produces a real accessibility summary sentence', () => {
    const summary = evidenceSummary(EXPLAINER.receiptDemo.signals, EXPLAINER.receiptDemo.rimBounce);
    expect(summary).toContain('Evidence:');
    for (const c of EVIDENCE_CHANNELS) expect(summary).toContain(c.phrase);
  });
});

describe('honesty invariants', () => {
  test('a make demo MUST carry geometric evidence (bread-ball rule)', () => {
    // Iron rule at the copy layer: the geometric path is the only signal that
    // can establish a make, so the teaching sample may never show a make
    // without geo — that would demonstrate corroborators outvoting the path.
    if (EXPLAINER.receiptDemo.outcome === 'make') {
      expect(EXPLAINER.receiptDemo.signals.geo).toBe(true);
    }
  });

  test('copy never claims corrections retrain or teach detection', () => {
    // The app never learns from corrections — corrections rewrite outcome
    // only, never signals, and no model retrains on them. Any copy implying
    // otherwise ("trains sharper detection", "learns from your edits") lies.
    const banned = /train|learn(s|ing)? from/i;
    for (const line of allCopy()) {
      expect(line).not.toMatch(banned);
    }
  });
});
