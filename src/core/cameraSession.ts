/**
 * Camera-session status -> the ONE line a live rail shows.
 *
 * WHY THIS EXISTS: VisionCamera reports a session that failed, was
 * interrupted, or simply never started through callbacks that this app wired
 * to NOTHING (a repo-wide grep for the session callback props returned zero
 * hits in src/ — Form Check, jump.tsx and session/live.tsx alike). With no
 * listener, `useCamera` falls back to its default handler, which is
 * `console.error(error)` — invisible on a phone. Worse, the two bring-up
 * paths cannot reach `onError` at all: `useCameraController.load()` awaits
 * `session.configure(...)` and `useCameraSessionIsRunning.load()` awaits
 * `session.start()`, both with no `.catch()`, so a rejection there is an
 * unhandled promise rejection and the session is simply never started
 * (node_modules/react-native-vision-camera/lib/hooks/internal/*.js). A screen
 * waiting on frames then looks EXACTLY like one that is warming up, forever.
 *
 * So this module does not rely on catching the failure. It reads the POSITIVE
 * signals — `onConfigured`, `onStarted` — and calls their ABSENCE after a
 * deadline what it is. That is the only report that survives a rejection we
 * are never handed.
 *
 * HONESTY CONTRACT: nothing here measures, relaxes, or overrides anything.
 * It reports whether the camera said it started, and turns that into copy
 * that names the next action. It never claims a capture happened, and the
 * raw library message is carried in `detail` for the console — never
 * rendered, because on-screen copy says what to DO, not what broke inside.
 *
 * Pure: no clock, no timers. The caller measures `elapsedMs` (the same shape
 * as `frameStall(framesDelta, elapsedMs, started)` on the Form Check screen).
 */

// Type-only: erased at compile time, so `src/core` keeps no runtime
// dependency on the camera library. It buys the exhaustiveness pin below —
// if VisionCamera adds an interruption reason, `tsc --noEmit` goes red here
// instead of the app silently showing nothing for it.
import type { InterruptionReason } from 'react-native-vision-camera';

/**
 * How long the session gets to report `onConfigured` / `onStarted` before
 * silence is treated as a diagnosis rather than a warm-up.
 *
 * Sized between the two neighbours it must not collide with: a healthy
 * AVCaptureSession starts well inside a second, and the pose-model watchdog
 * on the Form Check screen fires at 12 s. Anything shorter would call a slow
 * cold start a failure; anything longer and the presenter is already talking
 * over a black screen.
 */
export const CAMERA_START_TIMEOUT_MS = 5000;

/** Internal id for the fault — logged and tested, never rendered. */
export type CameraSessionFault =
  | 'error'
  | 'interrupted'
  | 'never-configured'
  | 'never-started';

/** What the screen has actually observed from the camera session so far. */
export interface CameraSessionStatus {
  /** Message from `onError`, if it has fired. Never shown to the user. */
  errorMessage?: string | null;
  /**
   * Reason from `onInterruptionStarted`, cleared by `onInterruptionEnded`.
   */
  interruption?: InterruptionReason | null;
  /** `onConfigured` has fired at least once this run. */
  configured: boolean;
  /** `onStarted` has fired at least once this run. */
  started: boolean;
  /** Wall clock since the live view mounted the camera, in ms. */
  elapsedMs: number;
}

/** One banner line, in the shape the Form Check rail already renders. */
export interface CameraSessionBanner {
  /** The line shown to the user. Always names the next action. */
  text: string;
  /**
   * Always true: every state this module reports means no frames are being
   * read, so rep counting is genuinely paused and the rail says so.
   */
  pauses: true;
  fault: CameraSessionFault;
  /**
   * True when the session REPORTED this (`onError` / `onInterruptionStarted`),
   * false when it was inferred from a deadline passing in silence.
   *
   * The caller needs the difference. A told reason carries information no
   * watchdog can guess — another app holds the camera, the phone is too hot —
   * and its fix is external, so it must outrank (and suppress the action of)
   * any generic "no frames yet" recovery. An inferred one says only that
   * nothing arrived, which a frame-counter watchdog already says better and
   * with a working control attached.
   */
  told: boolean;
  /** Raw library text, for the console only. */
  detail?: string;
}

/**
 * The recovery that actually rebuilds the capture session today.
 *
 * Cancel unmounts the live subtree (and with it the `<Camera>`), so starting
 * again builds a fresh session. Restart deliberately keeps the screen mounted
 * to preserve the warmed pose model, which means it does NOT touch the camera
 * — so pointing the user at Restart here would be pointing them at a control
 * that cannot fix any of these states. If Restart is ever changed to tear the
 * session down, change this string with it.
 */
const REOPEN = 'tap Cancel, then start again';

/** The same recovery, worded to follow another instruction in one line. */
const REOPEN_AFTER = 'start the check again';

/**
 * Copy per interruption reason, or `null` for reasons this screen must NOT
 * pause on. Exhaustive over the library's union by construction.
 */
const INTERRUPTION_TEXT: Record<InterruptionReason, string | null> = {
  // Someone else holds the camera — the one interruption the user can
  // genuinely clear, and the most likely one on a demo phone.
  'video-device-in-use-by-another-client': `Another app is using the camera — close it, then ${REOPEN_AFTER}.`,
  // This screen captures no audio, so an audio-device interruption costs it
  // nothing. Pausing rep counting for it would be a refusal with no cause.
  'audio-device-in-use-by-another-client': null,
  // The app is in the background: nobody is reading this banner, the
  // foreground guard has already stopped the session, and if frames never
  // come back the frame-stall watchdog owns that state.
  'video-device-not-available-in-background': null,
  'video-device-not-available-with-multiple-foreground-apps':
    'The camera is off in Split View — go full screen to run the check.',
  'video-device-not-available-due-to-system-pressure': `The phone is too hot — let it cool, then ${REOPEN_AFTER}.`,
  'sensitive-content-mitigation-activated': `The system blocked the camera feed — ${REOPEN}.`,
  unknown: `The camera was interrupted — ${REOPEN}.`,
};

/**
 * The line for one interruption reason, or `null` when this screen keeps
 * running through it.
 */
export function interruptionText(reason: InterruptionReason): string | null {
  const text = INTERRUPTION_TEXT[reason];
  // A mapped `null` is a deliberate "this one does not pause the screen".
  // Only a MISSING key — a reason a newer library version added — falls back
  // to the generic line. `??` here would swallow the deliberate nulls and
  // pause rep counting for an audio interruption this screen does not use.
  return text === undefined ? INTERRUPTION_TEXT.unknown : text;
}

/**
 * Resolve the camera-session banner, or `null` when the camera has nothing
 * to report and the rest of the screen (model warm-up, frame counter, gates)
 * owns the message.
 *
 * Priority: a reported error, then a live interruption, then the two
 * deadlines. The deadlines are last because they are inferences from
 * silence — a reason we were actually told always outranks one we deduced.
 */
export function cameraSessionBanner(
  status: CameraSessionStatus,
): CameraSessionBanner | null {
  const { errorMessage, interruption, configured, started } = status;
  const elapsedMs = Number.isFinite(status.elapsedMs) ? status.elapsedMs : 0;

  if (errorMessage != null && errorMessage !== '') {
    return {
      text: `The camera stopped — ${REOPEN}.`,
      pauses: true,
      fault: 'error',
      told: true,
      detail: errorMessage,
    };
  }

  if (interruption != null) {
    const text = interruptionText(interruption);
    if (text != null) {
      return {
        text,
        pauses: true,
        fault: 'interrupted',
        told: true,
        detail: interruption,
      };
    }
  }

  // Deadline branches. Before the deadline this returns null on purpose:
  // "Starting the camera…" is the honest word for a session that is still
  // within its normal bring-up time.
  if (elapsedMs < CAMERA_START_TIMEOUT_MS) return null;

  if (!configured) {
    return {
      text: `The camera didn't start — ${REOPEN}.`,
      pauses: true,
      fault: 'never-configured',
      told: false,
    };
  }
  if (!started) {
    return {
      text: `The camera didn't start — ${REOPEN}.`,
      pauses: true,
      fault: 'never-started',
      told: false,
    };
  }
  return null;
}
