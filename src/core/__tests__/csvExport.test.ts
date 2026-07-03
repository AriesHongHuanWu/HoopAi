/**
 * csvExport: pure RFC-4180 builders + the never-throw write/share pipeline.
 * expo-file-system and RN Share are mocked — no real filesystem/native share
 * sheet is involved.
 */
import { describe, expect, it } from '@jest/globals';

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (obj: Record<string, unknown>) => obj.ios },
  Share: { share: jest.fn().mockResolvedValue({ action: 'sharedAction' }) },
}));

import * as FileSystem from 'expo-file-system/legacy';
import { Platform, Share } from 'react-native';

import {
  csvField,
  csvRow,
  exportCsv,
  sessionsToCsv,
  shotsToCsv,
  type CsvShotInput,
} from '../csvExport';
import type { SessionSummaryRow } from '../../data/db';

function session(overrides: Partial<SessionSummaryRow> = {}): SessionSummaryRow {
  return {
    id: 1,
    startedAt: new Date(2026, 6, 3, 14, 5).getTime(), // Fri Jul 3 2026, 2:05 PM
    endedAt: null,
    label: '',
    videoPath: null,
    keepMode: 'makes',
    recordingStartSec: null,
    modeId: null,
    modeResultJson: null,
    attempts: 10,
    makes: 7,
    fgPct: 0.7,
    ...overrides,
  };
}

describe('csvField', () => {
  it('passes plain values through unquoted', () => {
    expect(csvField('hello')).toBe('hello');
    expect(csvField(42)).toBe('42');
    expect(csvField(true)).toBe('true');
  });

  it('renders null/undefined as an empty field', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('quotes fields containing a comma', () => {
    expect(csvField('Morning, Session')).toBe('"Morning, Session"');
  });

  it('quotes fields containing a double quote and doubles it', () => {
    expect(csvField('He said "go"')).toBe('"He said ""go"""');
  });

  it('quotes fields containing a line break', () => {
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
  });
});

describe('csvRow', () => {
  it('joins fields with commas and terminates with CRLF', () => {
    expect(csvRow(['a', 'b,c', 1])).toBe('a,"b,c",1\r\n');
  });
});

describe('sessionsToCsv', () => {
  it('emits a header row followed by one row per session', () => {
    const csv = sessionsToCsv([session({ id: 1, label: 'Morning shootaround' })]);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      'Session ID,Date,Time,Tag,Mode,Attempts,Makes,FG%',
    );
    expect(lines[1]).toBe('1,2026-07-03,14:05,Morning shootaround,,10,7,70');
  });

  it('quotes a tag containing a comma', () => {
    const csv = sessionsToCsv([session({ label: 'Gym, night session' })]);
    expect(csv).toContain('"Gym, night session"');
  });

  it('rounds FG% to one decimal place', () => {
    const csv = sessionsToCsv([session({ attempts: 3, makes: 1, fgPct: 1 / 3 })]);
    expect(csv).toContain(',33.3\r\n');
  });

  it('reports 0% for sessions with no attempts', () => {
    const csv = sessionsToCsv([session({ attempts: 0, makes: 0, fgPct: 0 })]);
    expect(csv).toContain(',0,0,0\r\n');
  });

  it('emits only the header for an empty list', () => {
    expect(sessionsToCsv([])).toBe(
      'Session ID,Date,Time,Tag,Mode,Attempts,Makes,FG%\r\n',
    );
  });

  it('includes the mode id when the session has one', () => {
    const csv = sessionsToCsv([session({ modeId: 'horse' })]);
    expect(csv.split('\r\n')[1]).toContain(',horse,');
  });
});

describe('shotsToCsv', () => {
  function shot(overrides: Partial<CsvShotInput> = {}): CsvShotInput {
    return {
      id: 1,
      tResolved: 12.34,
      outcome: 'make',
      entryAngleDeg: 45.6,
      releaseAngleDeg: 50.2,
      ...overrides,
    };
  }

  it('emits a header row followed by one row per shot', () => {
    const csv = shotsToCsv([{ sessionId: 1, shots: [shot()] }]);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      'Session ID,Shot #,Time (s),Outcome,Points,Entry angle,Release angle,Corrected',
    );
    expect(lines[1]).toBe('1,1,12.3,make,2,46,50,no');
  });

  it('defaults a missing shotValue to 2 points and marks 3s explicitly', () => {
    const csv = shotsToCsv([
      { sessionId: 1, shots: [shot({ shotValue: 3 }), shot({ id: 2, shotValue: undefined })] },
    ]);
    const lines = csv.trim().split('\r\n');
    expect(lines[1]).toContain(',3,');
    expect(lines[2]).toContain(',2,');
  });

  it('renders null angles as empty fields', () => {
    const csv = shotsToCsv([
      { sessionId: 1, shots: [shot({ entryAngleDeg: null, releaseAngleDeg: null })] },
    ]);
    expect(csv.trim().split('\r\n')[1]).toBe('1,1,12.3,make,2,,,no');
  });

  it('marks user-corrected shots', () => {
    const csv = shotsToCsv([{ sessionId: 1, shots: [shot({ corrected: true })] }]);
    expect(csv).toContain(',yes\r\n');
  });

  it('joins shots across multiple sessions, tagging each row with its session id', () => {
    const csv = shotsToCsv([
      { sessionId: 1, shots: [shot({ id: 1 })] },
      { sessionId: 2, shots: [shot({ id: 1 })] },
    ]);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1].startsWith('1,')).toBe(true);
    expect(lines[2].startsWith('2,')).toBe(true);
  });
});

describe('exportCsv', () => {
  const writeSpy = FileSystem.writeAsStringAsync as jest.Mock;
  const shareSpy = Share.share as jest.Mock;

  beforeEach(() => {
    writeSpy.mockClear().mockResolvedValue(undefined);
    shareSpy.mockClear().mockResolvedValue({ action: 'sharedAction' });
    (Platform as { OS: string }).OS = 'ios';
  });

  it('writes the CSV to the cache dir and shares the file url on iOS', async () => {
    const ok = await exportCsv('a,b\r\n1,2\r\n', 'sessions.csv');
    expect(ok).toBe(true);
    expect(writeSpy).toHaveBeenCalledWith(
      'file:///cache/sessions.csv',
      'a,b\r\n1,2\r\n',
      { encoding: 'utf8' },
    );
    expect(shareSpy).toHaveBeenCalledWith({ url: 'file:///cache/sessions.csv' });
  });

  it('falls back to a text share on Android', async () => {
    (Platform as { OS: string }).OS = 'android';
    const ok = await exportCsv('a,b\r\n1,2\r\n');
    expect(ok).toBe(true);
    expect(shareSpy).toHaveBeenCalledWith({ message: 'a,b\r\n1,2\r\n' });
  });

  it('falls back to a text share when the write fails, never throwing', async () => {
    writeSpy.mockRejectedValue(new Error('disk full'));
    const ok = await exportCsv('a,b\r\n1,2\r\n');
    expect(ok).toBe(true);
    expect(shareSpy).toHaveBeenCalledWith({ message: 'a,b\r\n1,2\r\n' });
  });

  it('resolves false when even the text fallback fails', async () => {
    writeSpy.mockRejectedValue(new Error('disk full'));
    shareSpy.mockRejectedValue(new Error('share sheet unavailable'));
    const ok = await exportCsv('a,b\r\n1,2\r\n');
    expect(ok).toBe(false);
  });
});
