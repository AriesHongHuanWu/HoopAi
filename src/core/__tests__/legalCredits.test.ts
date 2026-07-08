/**
 * Guards the legal credit registry — the store-review data that the Licenses
 * screen and docs/APPSTORE-CHECKLIST.md both depend on.
 */
import {
  CREDIT_SECTIONS,
  DATA_CREDITS,
  LICENSE_LABEL,
  MODEL_CREDITS,
  NBA_REFERENCE_NAMES,
  RUNTIME_CREDITS,
  type CreditRow,
} from '../legalCredits';

const ALL_ROWS: CreditRow[] = CREDIT_SECTIONS.flatMap((s) => [...s.rows]);

describe('legalCredits registry', () => {
  it('every credit row has a name, a known license, and an https link', () => {
    for (const row of ALL_ROWS) {
      expect(row.name.length).toBeGreaterThan(0);
      expect(LICENSE_LABEL[row.license]).toBeDefined();
      expect(row.link).toMatch(/^https:\/\//);
    }
  });

  it('flags exactly one row (the AGPL YOLO11 fallback) and it is AGPL', () => {
    const flagged = ALL_ROWS.filter((r) => r.flagged === true);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.license).toBe('AGPL-3.0');
    expect(flagged[0]!.name).toMatch(/YOLO11/);
  });

  it('the default detector and pose model are Apache-2.0, not AGPL', () => {
    const apache = MODEL_CREDITS.filter((r) => r.license === 'Apache-2.0');
    // YOLOX default + MoveNet pose.
    expect(apache.length).toBeGreaterThanOrEqual(2);
    expect(apache.every((r) => r.flagged !== true)).toBe(true);
  });

  it('all training datasets are CC BY 4.0 (attribution satisfied by listing)', () => {
    expect(DATA_CREDITS.length).toBeGreaterThan(0);
    expect(DATA_CREDITS.every((r) => r.license === 'CC-BY-4.0')).toBe(true);
  });

  it('all runtime libraries are MIT', () => {
    expect(RUNTIME_CREDITS.every((r) => r.license === 'MIT')).toBe(true);
  });

  it('NBA reference names are present for the content-rights note', () => {
    expect(NBA_REFERENCE_NAMES.length).toBeGreaterThan(0);
    expect(NBA_REFERENCE_NAMES).toContain('Stephen Curry');
  });
});
