/**
 * mockDetector: confirms the demo-mode frame size stays in sync with
 * DETECTION.inputSize (regression guard for the previously-hardcoded
 * `SIZE = 640` constant desyncing from a tuned detector input size).
 */
import { describe, expect, test } from '@jest/globals';

import { DETECTION } from '../../core/config';
import { createMockDetector } from '../mockDetector';

describe('createMockDetector', () => {
  test('inputSize matches DETECTION.inputSize', () => {
    const detector = createMockDetector();
    expect(detector.inputSize).toBe(DETECTION.inputSize);
  });

  test('frameWidth/frameHeight of every emitted frame match DETECTION.inputSize', () => {
    const detector = createMockDetector();
    for (let t = 0; t < 20; t += 0.5) {
      const frame = detector.frameAt(t);
      expect(frame.frameWidth).toBe(DETECTION.inputSize);
      expect(frame.frameHeight).toBe(DETECTION.inputSize);
    }
  });

  test('always includes rim and person detections', () => {
    const detector = createMockDetector();
    const frame = detector.frameAt(0);
    const classes = frame.detections.map((d) => d.cls);
    expect(classes).toContain('rim');
    expect(classes).toContain('person');
  });
});
