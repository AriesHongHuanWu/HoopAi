/**
 * Height units — the conversion contract.
 *
 * Height feeds real measurement downstream (formCheck's metre scale, the body
 * archetype comparisons, Jump Lab's pixel ruler), so the ONE thing that must
 * never happen is a stored centimetre value that walks every time the readout
 * renders or the unit is toggled. These tests pin:
 *
 *  - the canonical value stays in centimetres and only the DISPLAY changes;
 *  - cm -> ft/in -> cm settles after exactly one hop, for EVERY value in the
 *    slider's range and at both boundaries (an inch is coarser than a cm, so
 *    one hop may move by 1 cm — a second hop may not move at all);
 *  - both ends of the cm range stay reachable through the imperial slider;
 *  - 12 inches rolls up to the next foot (never "5'12"");
 *  - every formatted string carries a number AND its unit, including the
 *    spoken (screen-reader) form.
 */
import {
  CM_PER_INCH,
  cmToInches,
  formatDisplayHeight,
  formatFeetInches,
  formatHeight,
  fromDisplayHeight,
  heightScale,
  heightUnitSuffix,
  inchesToCm,
  joinFeetInches,
  splitFeetInches,
  spokenDisplayHeight,
  spokenHeight,
  toDisplayHeight,
  type HeightUnit,
} from '../heightUnits';

// The real slider bounds (state/profileStore.ts). Duplicated as literals on
// purpose: if someone widens the profile bounds, these numbers still describe
// the range this contract was proven over.
const MIN_CM = 120;
const MAX_CM = 220;

const everyCm = (): number[] =>
  Array.from({ length: MAX_CM - MIN_CM + 1 }, (_, i) => MIN_CM + i);

describe('inch <-> centimetre conversion', () => {
  it('uses the definitional inch', () => {
    expect(CM_PER_INCH).toBe(2.54);
  });

  it('converts the reported example: 5\'11" is 71 in, ~180 cm', () => {
    expect(joinFeetInches(5, 11)).toBe(71);
    expect(inchesToCm(71)).toBe(180);
    expect(cmToInches(180)).toBe(71);
  });

  it('rounds to whole units in both directions', () => {
    expect(cmToInches(178)).toBe(70); // 70.08"
    expect(inchesToCm(70)).toBe(178); // 177.8 cm
  });

  it('never returns NaN for junk input', () => {
    expect(cmToInches(Number.NaN)).toBe(0);
    expect(inchesToCm(Number.POSITIVE_INFINITY)).toBe(0);
    expect(formatHeight(Number.NaN, 'ftin')).toBe('—');
    expect(formatHeight(null, 'cm')).toBe('—');
    expect(formatHeight(undefined, 'ftin')).toBe('—');
  });
});

describe('feet + inches split', () => {
  it('rolls 12 inches up to the next foot', () => {
    expect(splitFeetInches(72)).toEqual({ feet: 6, inches: 0 });
    expect(formatFeetInches(72)).toBe("6'0\"");
    expect(formatFeetInches(71)).toBe("5'11\"");
  });

  it('never renders a 12-inch remainder anywhere in the range', () => {
    for (const cm of everyCm()) {
      const { inches } = splitFeetInches(cmToInches(cm));
      expect(inches).toBeGreaterThanOrEqual(0);
      expect(inches).toBeLessThan(12);
    }
  });

  it('round-trips through join', () => {
    for (let total = 40; total <= 96; total++) {
      const { feet, inches } = splitFeetInches(total);
      expect(joinFeetInches(feet, inches)).toBe(total);
    }
  });
});

describe('round-trip stability (the value must not walk)', () => {
  it('settles after ONE cm -> ft/in -> cm hop, for every value in range', () => {
    for (const cm of everyCm()) {
      const once = fromDisplayHeight(toDisplayHeight(cm, 'ftin'), 'ftin', MIN_CM, MAX_CM);
      const twice = fromDisplayHeight(toDisplayHeight(once, 'ftin'), 'ftin', MIN_CM, MAX_CM);
      const thrice = fromDisplayHeight(toDisplayHeight(twice, 'ftin'), 'ftin', MIN_CM, MAX_CM);
      // The first hop may move by at most 1 cm (an inch is coarser).
      expect(Math.abs(once - cm)).toBeLessThanOrEqual(1);
      // Every later hop must be a no-op — this is the anti-walk assertion.
      expect(twice).toBe(once);
      expect(thrice).toBe(once);
    }
  });

  it('is stable across repeated unit toggling, both directions', () => {
    for (const start of [MIN_CM, 150, 178, 180, 190, 199, MAX_CM]) {
      let cm = start;
      let unit: HeightUnit = 'cm';
      const seen: number[] = [];
      for (let i = 0; i < 20; i++) {
        unit = unit === 'cm' ? 'ftin' : 'cm';
        cm = fromDisplayHeight(toDisplayHeight(cm, unit), unit, MIN_CM, MAX_CM);
        seen.push(cm);
      }
      // At most one settling move, then a constant value forever.
      expect(new Set(seen.slice(2)).size).toBe(1);
      expect(Math.abs(seen[seen.length - 1]! - start)).toBeLessThanOrEqual(1);
    }
  });

  it('every imperial slider position is already a fixed point', () => {
    const scale = heightScale('ftin', MIN_CM, MAX_CM);
    for (let inches = scale.min; inches <= scale.max; inches += scale.step) {
      const cm = fromDisplayHeight(inches, 'ftin', MIN_CM, MAX_CM);
      const back = fromDisplayHeight(toDisplayHeight(cm, 'ftin'), 'ftin', MIN_CM, MAX_CM);
      expect(back).toBe(cm);
    }
  });

  it('metric is exactly lossless', () => {
    for (const cm of everyCm()) {
      expect(fromDisplayHeight(toDisplayHeight(cm, 'cm'), 'cm', MIN_CM, MAX_CM)).toBe(cm);
    }
  });
});

describe('slider domain and boundaries', () => {
  it('metric spans the raw cm bounds', () => {
    expect(heightScale('cm', MIN_CM, MAX_CM)).toEqual({ min: 120, max: 220, step: 1 });
  });

  it('imperial spans whole inches covering the same range', () => {
    expect(heightScale('ftin', MIN_CM, MAX_CM)).toEqual({ min: 47, max: 87, step: 1 });
    expect(formatDisplayHeight(47, 'ftin')).toBe("3'11\"");
    expect(formatDisplayHeight(87, 'ftin')).toBe("7'3\"");
  });

  it('keeps BOTH cm boundaries reachable from the imperial slider', () => {
    // 47" is 119 cm and 87" is 221 cm — the clamp is what makes the floor and
    // the ceiling selectable instead of one-off-unreachable.
    expect(fromDisplayHeight(47, 'ftin', MIN_CM, MAX_CM)).toBe(MIN_CM);
    expect(fromDisplayHeight(87, 'ftin', MIN_CM, MAX_CM)).toBe(MAX_CM);
  });

  it('never escapes the cm bounds, whatever the slider hands over', () => {
    for (const v of [-999, 0, 40, 47, 87, 200, 9999]) {
      for (const unit of ['cm', 'ftin'] as HeightUnit[]) {
        const cm = fromDisplayHeight(v, unit, MIN_CM, MAX_CM);
        expect(cm).toBeGreaterThanOrEqual(MIN_CM);
        expect(cm).toBeLessThanOrEqual(MAX_CM);
      }
    }
  });
});

describe('formatting always shows a number and a unit', () => {
  it('metric pairs the numeral with a cm suffix', () => {
    expect(formatDisplayHeight(178, 'cm')).toBe('178');
    expect(heightUnitSuffix('cm')).toBe('cm');
    expect(formatHeight(178, 'cm')).toBe('178 cm');
  });

  it('imperial carries its own marks and needs no suffix', () => {
    expect(heightUnitSuffix('ftin')).toBeNull();
    expect(formatHeight(180, 'ftin')).toBe("5'11\"");
    expect(formatHeight(178, 'ftin')).toBe("5'10\"");
  });

  it('produces a non-empty numeral for EVERY value in range, in both units', () => {
    for (const cm of everyCm()) {
      for (const unit of ['cm', 'ftin'] as HeightUnit[]) {
        const shown = formatDisplayHeight(toDisplayHeight(cm, unit), unit);
        expect(shown).not.toBe('');
        expect(shown).toMatch(/\d/);
        expect(formatHeight(cm, unit)).toMatch(/\d/);
      }
    }
  });

  it('speaks the number and the unit in words', () => {
    expect(spokenHeight(178, 'cm')).toBe('178 centimetres');
    expect(spokenHeight(180, 'ftin')).toBe('5 feet 11 inches');
    expect(spokenHeight(183, 'ftin')).toBe('6 feet');
    expect(spokenHeight(null, 'cm')).toBe('not set');
    expect(spokenDisplayHeight(70, 'ftin')).toBe('5 feet 10 inches');
    expect(spokenDisplayHeight(178, 'cm')).toBe('178 centimetres');
  });

  it('spoken imperial agrees with the printed imperial, across the range', () => {
    for (const cm of everyCm()) {
      const { feet, inches } = splitFeetInches(cmToInches(cm));
      const spoken = spokenHeight(cm, 'ftin');
      expect(spoken).toContain(`${feet} f`);
      if (inches > 0) expect(spoken).toContain(`${inches} inch`);
      expect(formatHeight(cm, 'ftin')).toBe(`${feet}'${inches}"`);
    }
  });
});
