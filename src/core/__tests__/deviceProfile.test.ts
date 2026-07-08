import {
  appleMajor,
  classifyDevice,
  DEVICE_TUNING,
  minTier,
  resolveTier,
  tierFromBenchmarkMs,
  tierLabel,
  type DeviceSignals,
} from '../deviceProfile';

const sig = (over: Partial<DeviceSignals>): DeviceSignals => ({
  os: 'ios',
  modelId: null,
  deviceYearClass: null,
  totalMemoryBytes: null,
  ...over,
});

describe('appleMajor', () => {
  test('parses iPhone / iPad / iPod identifiers', () => {
    expect(appleMajor('iPhone11,8')).toBe(11); // XR
    expect(appleMajor('iPhone16,2')).toBe(16); // 15 Pro Max
    expect(appleMajor('iPad13,4')).toBe(13);
    expect(appleMajor('iPod9,1')).toBe(9);
  });
  test('null for non-Apple / malformed', () => {
    expect(appleMajor('SM-G991B')).toBeNull();
    expect(appleMajor('Pixel 7')).toBeNull();
    expect(appleMajor(null)).toBeNull();
    expect(appleMajor('iPhone')).toBeNull();
  });
});

describe('classifyDevice — iPhone generations', () => {
  test('A12/older = entry (XR is our floor)', () => {
    expect(classifyDevice(sig({ modelId: 'iPhone11,8' }))).toBe('entry'); // XR
    expect(classifyDevice(sig({ modelId: 'iPhone11,2' }))).toBe('entry'); // XS
    expect(classifyDevice(sig({ modelId: 'iPhone10,6' }))).toBe('entry'); // X
  });
  test('A13/A14 = mid', () => {
    expect(classifyDevice(sig({ modelId: 'iPhone12,1' }))).toBe('mid'); // 11
    expect(classifyDevice(sig({ modelId: 'iPhone12,8' }))).toBe('mid'); // SE2
    expect(classifyDevice(sig({ modelId: 'iPhone13,2' }))).toBe('mid'); // 12
  });
  test('A15+ = high, and FUTURE iPhones auto-classify high', () => {
    expect(classifyDevice(sig({ modelId: 'iPhone14,5' }))).toBe('high'); // 13
    expect(classifyDevice(sig({ modelId: 'iPhone15,3' }))).toBe('high'); // 14 Pro Max
    expect(classifyDevice(sig({ modelId: 'iPhone16,1' }))).toBe('high'); // 15 Pro
    expect(classifyDevice(sig({ modelId: 'iPhone17,2' }))).toBe('high'); // 16-era
    expect(classifyDevice(sig({ modelId: 'iPhone99,1' }))).toBe('high'); // some 2030 phone
  });
});

describe('classifyDevice — iPad floored at mid', () => {
  test('an old iPad that would be entry is bumped to mid', () => {
    expect(classifyDevice(sig({ modelId: 'iPad7,11', deviceYearClass: 2018 }))).toBe('mid');
  });
  test('a modern iPad stays high', () => {
    expect(classifyDevice(sig({ modelId: 'iPad14,3', deviceYearClass: 2022 }))).toBe('high');
  });
});

describe('classifyDevice — Android via year/memory', () => {
  test('flagship: recent year OR >=6GB → high', () => {
    expect(classifyDevice(sig({ os: 'android', modelId: 'SM-S911B', deviceYearClass: 2023 }))).toBe('high');
    expect(classifyDevice(sig({ os: 'android', modelId: 'X', totalMemoryBytes: 8 * 1024 ** 3 }))).toBe('high');
  });
  test('mid: 2019-2020 OR 4GB', () => {
    expect(classifyDevice(sig({ os: 'android', modelId: 'X', deviceYearClass: 2020 }))).toBe('mid');
    expect(classifyDevice(sig({ os: 'android', modelId: 'X', totalMemoryBytes: 4 * 1024 ** 3 }))).toBe('mid');
  });
  test('entry: old year, low memory', () => {
    expect(classifyDevice(sig({ os: 'android', modelId: 'X', deviceYearClass: 2017, totalMemoryBytes: 2 * 1024 ** 3 }))).toBe('entry');
  });
  test('no signal at all → mid (safe middle, benchmark corrects)', () => {
    expect(classifyDevice(sig({ os: 'android' }))).toBe('mid');
  });
});

describe('tierFromBenchmarkMs — ground truth, model-DB-free', () => {
  test('fast/usable/slow bands', () => {
    expect(tierFromBenchmarkMs(30)).toBe('high');
    expect(tierFromBenchmarkMs(45)).toBe('high');
    expect(tierFromBenchmarkMs(46)).toBe('mid');
    expect(tierFromBenchmarkMs(120)).toBe('mid');
    expect(tierFromBenchmarkMs(500)).toBe('entry'); // XR running Tiny@640
  });
});

describe('resolveTier — benchmark can only lower, never raise', () => {
  test('a "high" model string that benchmarks slow drops to its measured tier', () => {
    // e.g. thermal throttle, or a labelled-fast phone under heavy load.
    expect(resolveTier('high', 500)).toBe('entry');
    expect(resolveTier('high', 90)).toBe('mid');
    expect(resolveTier('high', 30)).toBe('high');
  });
  test('a fast benchmark on an "entry" phone does NOT over-promote it', () => {
    expect(resolveTier('entry', 20)).toBe('entry');
  });
  test('no benchmark → static tier unchanged', () => {
    expect(resolveTier('mid', null)).toBe('mid');
    expect(resolveTier('high', 0)).toBe('high');
    expect(resolveTier('high', NaN)).toBe('high');
  });
});

describe('DEVICE_TUNING coherence', () => {
  test('entry is the most conservative, high the most aggressive', () => {
    expect(DEVICE_TUNING.entry.startRung).toBe('nano');
    expect(DEVICE_TUNING.entry.detectorAccel).toBe('cpu');
    expect(DEVICE_TUNING.entry.poseSafe).toBe(false);
    expect(DEVICE_TUNING.high.startRung).toBe('tiny');
    expect(DEVICE_TUNING.high.poseSafe).toBe(true);
    // every tier keeps 416 (the measured-better input size)
    expect(DEVICE_TUNING.entry.perfMode).toBe('speed');
    expect(DEVICE_TUNING.high.perfMode).toBe('speed');
  });
  test('minTier / tierLabel', () => {
    expect(minTier('high', 'entry')).toBe('entry');
    expect(minTier('mid', 'high')).toBe('mid');
    expect(tierLabel('entry')).toBe('Entry');
    expect(tierLabel('high')).toBe('High');
  });
});
