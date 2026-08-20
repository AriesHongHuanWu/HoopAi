/**
 * Unit tests for the pure setup-screen vocabulary (setupDefaults).
 * Everything here is store-free string/record logic, so tests assert exact
 * outputs. Drill/mode names are asserted against the LIVE catalogs so a
 * rename in drills.ts / gameModes.ts fails here instead of shipping a stale
 * subtitle.
 */
import { getDrill } from '@/core/drills';
import { getModeDef } from '@/core/gameModes';
import type { KeepMode } from '@/state/settingsStore';
import {
  HERO_CHIP_DEFS,
  SETUP_SECTION_ORDER,
  cameraSubtitle,
  courtBallSubtitle,
  defaultExpanded,
  modeSubtitle,
  recordingSubtitle,
  startSummaryLine,
  type SetupSectionId,
} from '../setupDefaults';

// ---------------------------------------------------------------------------
// Section vocabulary
// ---------------------------------------------------------------------------

describe('SETUP_SECTION_ORDER', () => {
  it('lists the five sections in render order', () => {
    expect(SETUP_SECTION_ORDER).toEqual([
      'mode',
      'camera',
      'recording',
      'courtBall',
      'calibration',
    ]);
  });
});

describe('HERO_CHIP_DEFS', () => {
  it('exposes mode/camera/recording chips, each targeting a real section', () => {
    expect(HERO_CHIP_DEFS.map((c) => c.id)).toEqual(['mode', 'camera', 'recording']);
    for (const chip of HERO_CHIP_DEFS) {
      expect(SETUP_SECTION_ORDER).toContain(chip.id);
      expect(chip.icon.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// defaultExpanded — all four modeArmed × cameraGranted combos
// ---------------------------------------------------------------------------

describe('defaultExpanded', () => {
  const fixed = { recording: false, courtBall: false, calibration: true };

  it('mode armed + camera granted → only mode and calibration open', () => {
    expect(defaultExpanded({ modeArmed: true, cameraGranted: true })).toEqual({
      mode: true,
      camera: false,
      ...fixed,
    });
  });

  it('mode armed + camera not granted → mode, camera, calibration open', () => {
    expect(defaultExpanded({ modeArmed: true, cameraGranted: false })).toEqual({
      mode: true,
      camera: true,
      ...fixed,
    });
  });

  it('no mode + camera granted → only calibration open', () => {
    expect(defaultExpanded({ modeArmed: false, cameraGranted: true })).toEqual({
      mode: false,
      camera: false,
      ...fixed,
    });
  });

  it('no mode + camera not granted → camera and calibration open', () => {
    expect(defaultExpanded({ modeArmed: false, cameraGranted: false })).toEqual({
      mode: false,
      camera: true,
      ...fixed,
    });
  });

  it('covers every section id exactly once', () => {
    const record = defaultExpanded({ modeArmed: false, cameraGranted: false });
    expect(Object.keys(record).sort()).toEqual([...SETUP_SECTION_ORDER].sort());
  });
});

// ---------------------------------------------------------------------------
// startSummaryLine
// ---------------------------------------------------------------------------

describe('startSummaryLine', () => {
  it('joins mode, orientation, and clip policy with middots', () => {
    expect(
      startSummaryLine({
        modeName: 'Free Play',
        orient: 'portrait',
        recordVideo: true,
        keepMode: 'makes',
      }),
    ).toBe('Free Play · Portrait · Clips: makes only');
  });

  it('null modeName falls back to Free Play', () => {
    expect(
      startSummaryLine({ modeName: null, orient: 'portrait', recordVideo: true, keepMode: 'makes' }),
    ).toBe('Free Play · Portrait · Clips: makes only');
  });

  it('landscape orientation reads Landscape', () => {
    expect(
      startSummaryLine({
        modeName: 'Timed Challenge',
        orient: 'landscape',
        recordVideo: true,
        keepMode: 'all',
      }),
    ).toBe('Timed Challenge · Landscape · Clips: every shot');
  });

  it('recording off reads No video regardless of keepMode', () => {
    expect(
      startSummaryLine({ modeName: null, orient: 'portrait', recordVideo: false, keepMode: 'all' }),
    ).toBe('Free Play · Portrait · No video');
  });

  it.each<[KeepMode, string]>([
    ['makes', 'Clips: makes only'],
    ['decided', 'Clips: makes + misses'],
    ['all', 'Clips: every shot'],
    ['none', 'Clips: none'],
  ])('keepMode %s → "%s"', (keepMode, suffix) => {
    expect(
      startSummaryLine({ modeName: null, orient: 'portrait', recordVideo: true, keepMode }),
    ).toBe(`Free Play · Portrait · ${suffix}`);
  });
});

// ---------------------------------------------------------------------------
// modeSubtitle
// ---------------------------------------------------------------------------

describe('modeSubtitle', () => {
  const base = { drillId: null, durationSec: 60, makesPerSpot: 5 };

  it('null modeId → Free Play', () => {
    expect(modeSubtitle({ ...base, modeId: null })).toBe('Free Play');
  });

  it("'free' → Free Play", () => {
    expect(modeSubtitle({ ...base, modeId: 'free' })).toBe('Free Play');
  });

  it('timed includes the configured duration', () => {
    expect(modeSubtitle({ ...base, modeId: 'timed', durationSec: 90 })).toBe(
      'Timed Challenge · 90s',
    );
  });

  it('spotShooting includes makes per spot', () => {
    expect(modeSubtitle({ ...base, modeId: 'spotShooting', makesPerSpot: 7 })).toBe(
      'Spot Shooting · 7 per spot',
    );
  });

  it('an armed drill wins over the mode id and shows the live catalog title', () => {
    // Drills run AS spotShooting — the drill name must win over the mode line.
    expect(
      modeSubtitle({ modeId: 'spotShooting', drillId: 'corners3', durationSec: 60, makesPerSpot: 5 }),
    ).toBe(getDrill('corners3').title);
  });

  it('an unknown drill id falls back to Drill without throwing', () => {
    expect(modeSubtitle({ ...base, drillId: 'not-a-drill', modeId: 'spotShooting' })).toBe('Drill');
  });

  it('other catalog modes use their live catalog name', () => {
    expect(modeSubtitle({ ...base, modeId: 'horse' })).toBe(getModeDef('horse').name);
    expect(modeSubtitle({ ...base, modeId: 'ghost' })).toBe(getModeDef('ghost').name);
  });

  it('an unknown mode id returns the raw id without throwing', () => {
    expect(modeSubtitle({ ...base, modeId: 'nope' })).toBe('nope');
  });
});

// ---------------------------------------------------------------------------
// cameraSubtitle / recordingSubtitle / courtBallSubtitle
// ---------------------------------------------------------------------------

describe('cameraSubtitle', () => {
  it('granted portrait → Portrait · Camera ready', () => {
    expect(cameraSubtitle({ granted: true, orient: 'portrait' })).toBe('Portrait · Camera ready');
  });

  it('granted landscape → Landscape · Camera ready', () => {
    expect(cameraSubtitle({ granted: true, orient: 'landscape' })).toBe('Landscape · Camera ready');
  });

  it('not granted → Camera access needed, regardless of orientation', () => {
    expect(cameraSubtitle({ granted: false, orient: 'portrait' })).toBe('Camera access needed');
    expect(cameraSubtitle({ granted: false, orient: 'landscape' })).toBe('Camera access needed');
  });
});

describe('recordingSubtitle', () => {
  it.each<[KeepMode, string]>([
    ['makes', 'On · Makes only'],
    ['decided', 'On · Makes + misses'],
    ['all', 'On · Every shot'],
    ['none', 'On · No clips'],
  ])('on + keepMode %s → "%s"', (keepMode, expected) => {
    expect(recordingSubtitle({ recordVideo: true, keepMode })).toBe(expected);
  });

  it('recording off → Off regardless of keepMode', () => {
    expect(recordingSubtitle({ recordVideo: false, keepMode: 'all' })).toBe('Off');
    expect(recordingSubtitle({ recordVideo: false, keepMode: 'makes' })).toBe('Off');
  });
});

describe('courtBallSubtitle', () => {
  it('standard rim, size 7, auto range → no pinned suffix', () => {
    expect(courtBallSubtitle({ rimHeightM: 3.05, ballSize: 7, courtRange: 'auto' })).toBe(
      'Standard rim · Size 7',
    );
  });

  it('youth rim, size 5, auto range', () => {
    expect(courtBallSubtitle({ rimHeightM: 2.6, ballSize: 5, courtRange: 'auto' })).toBe(
      'Youth rim · Size 5',
    );
  });

  it('pinned 2s appends the override honestly', () => {
    expect(courtBallSubtitle({ rimHeightM: 3.05, ballSize: 6, courtRange: '2pt' })).toBe(
      'Standard rim · Size 6 · Pinned 2s',
    );
  });

  it('pinned 3s appends the override honestly', () => {
    expect(courtBallSubtitle({ rimHeightM: 2.6, ballSize: 7, courtRange: '3pt' })).toBe(
      'Youth rim · Size 7 · Pinned 3s',
    );
  });
});
