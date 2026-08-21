/**
 * Pins for the camera-session banner.
 *
 * The defect this guards: on Form Check every bring-up failure collapsed into
 * the same eternal "Starting the camera…". These tests pin the boundary
 * between "still coming up" (say nothing new) and "it did not come up" (say
 * so, and name the control that fixes it).
 */
import type { InterruptionReason } from 'react-native-vision-camera';

import {
  CAMERA_START_TIMEOUT_MS,
  cameraSessionBanner,
  interruptionText,
  type CameraSessionStatus,
} from '../cameraSession';

/** A healthy, freshly mounted session: nothing observed yet. */
const cold: CameraSessionStatus = {
  configured: false,
  started: false,
  elapsedMs: 0,
};

/** Every reason in the library union — the exhaustiveness fixture. */
const ALL_REASONS: InterruptionReason[] = [
  'video-device-not-available-in-background',
  'audio-device-in-use-by-another-client',
  'video-device-in-use-by-another-client',
  'video-device-not-available-with-multiple-foreground-apps',
  'video-device-not-available-due-to-system-pressure',
  'sensitive-content-mitigation-activated',
  'unknown',
];

describe('cameraSessionBanner — silence while it is genuinely starting', () => {
  test('says nothing during normal bring-up', () => {
    expect(cameraSessionBanner(cold)).toBeNull();
    expect(
      cameraSessionBanner({ ...cold, elapsedMs: CAMERA_START_TIMEOUT_MS - 1 }),
    ).toBeNull();
  });

  test('says nothing once the session reported started, however long it runs', () => {
    expect(
      cameraSessionBanner({ configured: true, started: true, elapsedMs: 600_000 }),
    ).toBeNull();
  });

  test('a non-finite clock makes no claim', () => {
    expect(
      cameraSessionBanner({ ...cold, elapsedMs: Number.NaN }),
    ).toBeNull();
  });
});

describe('cameraSessionBanner — the deadline turns silence into a diagnosis', () => {
  test('never configured, at the deadline', () => {
    const b = cameraSessionBanner({ ...cold, elapsedMs: CAMERA_START_TIMEOUT_MS });
    expect(b).not.toBeNull();
    expect(b?.fault).toBe('never-configured');
    expect(b?.pauses).toBe(true);
    expect(b?.text).toBe("The camera didn't start — tap Cancel, then start again.");
  });

  test('configured but never started is its own fault id', () => {
    const b = cameraSessionBanner({
      configured: true,
      started: false,
      elapsedMs: CAMERA_START_TIMEOUT_MS + 1,
    });
    expect(b?.fault).toBe('never-started');
    expect(b?.text).toBe("The camera didn't start — tap Cancel, then start again.");
  });

  test('the deadline is a floor, not a window — it stays reported', () => {
    expect(
      cameraSessionBanner({ ...cold, elapsedMs: 120_000 })?.fault,
    ).toBe('never-configured');
  });
});

describe('cameraSessionBanner — a reason we were told outranks one we deduced', () => {
  test('a reported error outranks the deadlines and every interruption', () => {
    const b = cameraSessionBanner({
      errorMessage: 'session/camera-has-been-disconnected',
      interruption: 'video-device-in-use-by-another-client',
      configured: false,
      started: false,
      elapsedMs: 60_000,
    });
    expect(b?.fault).toBe('error');
    expect(b?.text).toBe('The camera stopped — tap Cancel, then start again.');
  });

  test('the raw library message is carried for the console, never rendered', () => {
    const raw = 'RuntimeError: -[AVCaptureDevice lockForConfiguration:] failed';
    const b = cameraSessionBanner({ ...cold, errorMessage: raw, elapsedMs: 0 });
    expect(b?.detail).toBe(raw);
    expect(b?.text).not.toContain('AVCaptureDevice');
    expect(b?.text).not.toContain('RuntimeError');
  });

  test('an empty error message is not an error', () => {
    expect(cameraSessionBanner({ ...cold, errorMessage: '' })).toBeNull();
  });

  test('an interruption outranks the deadlines', () => {
    const b = cameraSessionBanner({
      interruption: 'video-device-not-available-due-to-system-pressure',
      configured: false,
      started: false,
      elapsedMs: 60_000,
    });
    expect(b?.fault).toBe('interrupted');
    expect(b?.text).toBe('The phone is too hot — let it cool, then start the check again.');
  });
});

describe('told — what the session reported vs what we inferred from silence', () => {
  test('error and interruption are told; the deadlines are not', () => {
    expect(
      cameraSessionBanner({ ...cold, errorMessage: 'boom' })?.told,
    ).toBe(true);
    expect(
      cameraSessionBanner({ ...cold, interruption: 'unknown' })?.told,
    ).toBe(true);
    expect(
      cameraSessionBanner({ ...cold, elapsedMs: CAMERA_START_TIMEOUT_MS })?.told,
    ).toBe(false);
    expect(
      cameraSessionBanner({
        configured: true,
        started: false,
        elapsedMs: CAMERA_START_TIMEOUT_MS,
      })?.told,
    ).toBe(false);
  });

  test('a told reason arrives immediately — no deadline to wait out', () => {
    // The whole point: an interruption at t=0 must not be held back behind
    // the same silence budget that the inferred faults wait for.
    const b = cameraSessionBanner({
      ...cold,
      interruption: 'video-device-in-use-by-another-client',
      elapsedMs: 0,
    });
    expect(b?.told).toBe(true);
    expect(b?.fault).toBe('interrupted');
  });
});

describe('interruptionText — only pause for what actually stops the capture', () => {
  test('every reason in the library union is mapped', () => {
    for (const r of ALL_REASONS) {
      // `undefined` would mean an unmapped key falling through the Record.
      expect(interruptionText(r)).not.toBeUndefined();
    }
  });

  test('audio-only and background never pause this screen', () => {
    expect(interruptionText('audio-device-in-use-by-another-client')).toBeNull();
    expect(interruptionText('video-device-not-available-in-background')).toBeNull();
    expect(
      cameraSessionBanner({
        ...cold,
        interruption: 'audio-device-in-use-by-another-client',
      }),
    ).toBeNull();
  });

  test('another app holding the camera names the fix', () => {
    expect(interruptionText('video-device-in-use-by-another-client')).toBe(
      'Another app is using the camera — close it, then start the check again.',
    );
  });

  test('every line that pauses names an action the user can take', () => {
    const texts = ALL_REASONS.map(interruptionText).filter(
      (t): t is string => t != null,
    );
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) {
      expect(t).toContain('—');
      // Never blame the internals: the copy says what to do next.
      expect(t.toLowerCase()).not.toContain('configure');
      expect(t.toLowerCase()).not.toContain('promise');
    }
  });
});
