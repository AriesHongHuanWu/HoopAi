import {
  AUTO_ORBIT_DEG_PER_SEC,
  DEFAULT_CAMERA,
  DIST_MAX,
  DIST_MIN,
  PITCH_MAX,
  PITCH_MIN,
  autoOrbitStep,
  groundGrid,
  orbitFromDrag,
  pinchZoom,
  presetCamera,
  projectPoint,
  projectSkeleton,
  strokeWidthFor,
  tweenCamera,
} from '../camera3d';
import type { CameraPresetId, OrbitCamera } from '../camera3d';
import type { ShootingHand } from '../../types';
import type { Frame3D, Joint3D } from '../lift';

const VP = { w: 300, h: 340 };

/** Camera looking straight down +z at the target — easiest to reason about. */
const FRONT_CAM: OrbitCamera = { ...DEFAULT_CAMERA, yawDeg: 0, pitchDeg: 0 };

const joint = (x: number, y: number, z: number, c = 1): Joint3D => ({ x, y, z, c });

describe('camera3d', () => {
  test('target point projects to the viewport center at DEFAULT_CAMERA', () => {
    const p = projectPoint({ x: 0, y: DEFAULT_CAMERA.targetY, z: 0 }, DEFAULT_CAMERA, VP);
    expect(p).not.toBeNull();
    expect(Math.abs(p!.x - VP.w / 2)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(p!.y - VP.h / 2)).toBeLessThanOrEqual(0.5);
    expect(p!.depth).toBeCloseTo(DEFAULT_CAMERA.distance);
  });

  test('+z (toward viewer at yaw 0) has smaller depth than -z', () => {
    const near = projectPoint({ x: 0, y: FRONT_CAM.targetY, z: 0.5 }, FRONT_CAM, VP);
    const far = projectPoint({ x: 0, y: FRONT_CAM.targetY, z: -0.5 }, FRONT_CAM, VP);
    expect(near).not.toBeNull();
    expect(far).not.toBeNull();
    expect(near!.depth).toBeLessThan(far!.depth);
  });

  test('yaw 90 moves the camera to +x: +x points become nearer', () => {
    const cam: OrbitCamera = { ...FRONT_CAM, yawDeg: 90 };
    const right = projectPoint({ x: 0.5, y: cam.targetY, z: 0 }, cam, VP);
    const left = projectPoint({ x: -0.5, y: cam.targetY, z: 0 }, cam, VP);
    expect(right!.depth).toBeLessThan(left!.depth);
  });

  test('point behind the camera returns null', () => {
    const p = projectPoint(
      { x: 0, y: FRONT_CAM.targetY, z: FRONT_CAM.distance + 1 },
      FRONT_CAM,
      VP,
    );
    expect(p).toBeNull();
  });

  test('y-down: lower world point (larger y) projects lower on screen', () => {
    const lower = projectPoint({ x: 0, y: FRONT_CAM.targetY + 0.3, z: 0 }, FRONT_CAM, VP);
    const upper = projectPoint({ x: 0, y: FRONT_CAM.targetY - 0.3, z: 0 }, FRONT_CAM, VP);
    expect(lower!.y).toBeGreaterThan(upper!.y);
    expect(lower!.y).toBeGreaterThan(VP.h / 2);
    // +x right sanity while we are here.
    const right = projectPoint({ x: 0.3, y: FRONT_CAM.targetY, z: 0 }, FRONT_CAM, VP);
    expect(right!.x).toBeGreaterThan(VP.w / 2);
  });

  test('projectSkeleton sorts far-to-near and takes min joint confidence', () => {
    const y = FRONT_CAM.targetY;
    const frame: Frame3D = {
      left_shoulder: joint(0, y, 0.5, 0.9),
      left_elbow: joint(0.1, y, 0, 0.8),
      left_wrist: joint(0.2, y, -0.5, 0.7),
    };
    const bones = [
      ['left_shoulder', 'left_elbow'],
      ['left_elbow', 'left_wrist'],
    ] as const;
    const segs = projectSkeleton(frame, bones, FRONT_CAM, VP);
    expect(segs).toHaveLength(2);
    // elbow-wrist bone sits deeper (depths 3.2 and 3.7 vs 2.7 and 3.2).
    expect(segs[0].joints).toEqual(['left_elbow', 'left_wrist']);
    expect(segs[0].depth).toBeGreaterThan(segs[1].depth);
    expect(segs[0].depth).toBeCloseTo(3.45);
    expect(segs[1].depth).toBeCloseTo(2.95);
    expect(segs[0].c).toBeCloseTo(0.7);
    expect(segs[1].c).toBeCloseTo(0.8);
  });

  test('projectSkeleton skips bones with a missing joint', () => {
    const frame: Frame3D = { left_shoulder: joint(0, 0, 0) };
    const segs = projectSkeleton(
      frame,
      [['left_shoulder', 'left_elbow']] as const,
      FRONT_CAM,
      VP,
    );
    expect(segs).toHaveLength(0);
  });

  test('orbitFromDrag: full-viewport drag adds 180 deg yaw, wrapped', () => {
    expect(orbitFromDrag(FRONT_CAM, 300, 0, 300).yawDeg).toBeCloseTo(180);
    // 25 + 180 = 205 wraps into (-180, 180].
    const wrapped = orbitFromDrag({ ...FRONT_CAM, yawDeg: 25 }, 300, 0, 300);
    expect(wrapped.yawDeg).toBeCloseTo(-155);
  });

  test('orbitFromDrag clamps pitch and never mutates its input', () => {
    const before = { ...FRONT_CAM };
    const up = orbitFromDrag(FRONT_CAM, 0, -10000, 300);
    expect(up.pitchDeg).toBe(PITCH_MIN);
    const down = orbitFromDrag(FRONT_CAM, 0, 10000, 300);
    expect(down.pitchDeg).toBe(PITCH_MAX);
    expect(up).not.toBe(FRONT_CAM);
    expect(FRONT_CAM).toEqual(before);
  });

  test('pinchZoom clamps distance to [DIST_MIN, DIST_MAX]', () => {
    expect(pinchZoom(FRONT_CAM, 100).distance).toBe(DIST_MIN);
    expect(pinchZoom(FRONT_CAM, 0.005).distance).toBe(DIST_MAX);
    expect(pinchZoom(FRONT_CAM, 1).distance).toBeCloseTo(FRONT_CAM.distance);
    const out = pinchZoom(FRONT_CAM, 1.25);
    expect(out).not.toBe(FRONT_CAM);
    expect(out.distance).toBeCloseTo(FRONT_CAM.distance / 1.25);
  });

  test('strokeWidthFor scales by distance/depth and clamps both ends', () => {
    const base = 4;
    expect(strokeWidthFor(DEFAULT_CAMERA.distance, DEFAULT_CAMERA, base)).toBeCloseTo(base);
    expect(strokeWidthFor(100, DEFAULT_CAMERA, base)).toBeCloseTo(0.5 * base);
    expect(strokeWidthFor(0.01, DEFAULT_CAMERA, base)).toBeCloseTo(1.8 * base);
  });

  test('groundGrid: extent 1.2 step 0.3 gives 9 lines per direction', () => {
    const explicit = groundGrid(DEFAULT_CAMERA, VP, { y: 0.45, extent: 1.2, step: 0.3 });
    expect(explicit).toHaveLength(18);
    // Same values are the defaults.
    expect(groundGrid(DEFAULT_CAMERA, VP, { y: 0.45 })).toEqual(explicit);
  });

  test('groundGrid drops lines with an endpoint behind the near plane', () => {
    // Camera 1 body-height from target: the z = +1.2 grid edge is behind it,
    // killing that x-parallel line and every z-parallel line (they all end
    // at z = +1.2). 8 x-parallel lines survive.
    const cam: OrbitCamera = { ...FRONT_CAM, distance: 1 };
    const lines = groundGrid(cam, VP, { y: 0, extent: 1.2, step: 0.3 });
    expect(lines).toHaveLength(8);
  });

  test('projection is deterministic across repeated calls', () => {
    const frame: Frame3D = {
      left_shoulder: joint(-0.13, -0.53, 0.05, 0.9),
      right_shoulder: joint(0.13, -0.53, -0.05, 0.85),
      left_hip: joint(-0.1, 0, 0.03, 0.95),
    };
    const bones = [
      ['left_shoulder', 'right_shoulder'],
      ['left_shoulder', 'left_hip'],
    ] as const;
    expect(projectSkeleton(frame, bones, DEFAULT_CAMERA, VP)).toEqual(
      projectSkeleton(frame, bones, DEFAULT_CAMERA, VP),
    );
    expect(groundGrid(DEFAULT_CAMERA, VP, { y: 0.45 })).toEqual(
      groundGrid(DEFAULT_CAMERA, VP, { y: 0.45 }),
    );
  });
});

describe('presetCamera', () => {
  const IDS: readonly CameraPresetId[] = ['default', 'front', 'side', 'top'];
  const HANDS: readonly ShootingHand[] = ['left', 'right'];

  test('every preset x hand satisfies the pitch and distance clamps', () => {
    for (const id of IDS) {
      for (const hand of HANDS) {
        const cam = presetCamera(id, hand);
        expect(cam.pitchDeg).toBeGreaterThanOrEqual(PITCH_MIN);
        expect(cam.pitchDeg).toBeLessThanOrEqual(PITCH_MAX);
        expect(cam.distance).toBeGreaterThanOrEqual(DIST_MIN);
        expect(cam.distance).toBeLessThanOrEqual(DIST_MAX);
        // Yaw already lives in the wrapped range.
        expect(cam.yawDeg).toBeGreaterThan(-180 - 1e-9);
        expect(cam.yawDeg).toBeLessThanOrEqual(180);
      }
    }
  });

  test('default preset deep-equals DEFAULT_CAMERA but is a fresh object', () => {
    const cam = presetCamera('default', 'right');
    expect(cam).toEqual(DEFAULT_CAMERA);
    expect(cam).not.toBe(DEFAULT_CAMERA);
  });

  test('SIDE honesty lock: the shooting-side wrist is nearer the camera', () => {
    // Mirror-ambiguity source of truth. The lift copies image x, and a
    // camera-facing right-handed shooter's right wrist sits at NEGATIVE
    // world x (image-left). If this test fails, flip the ternary in
    // presetCamera('side', ...) — do NOT change this test.
    const vp = { w: 400, h: 400 };
    const frame: Frame3D = {
      right_wrist: joint(-0.2, -0.4, 0.05, 1),
      left_wrist: joint(0.2, -0.4, 0.05, 1),
    };
    const rightCam = presetCamera('side', 'right');
    expect(projectPoint(frame.right_wrist!, rightCam, vp)!.depth).toBeLessThan(
      projectPoint(frame.left_wrist!, rightCam, vp)!.depth,
    );
    const leftCam = presetCamera('side', 'left');
    expect(projectPoint(frame.left_wrist!, leftCam, vp)!.depth).toBeLessThan(
      projectPoint(frame.right_wrist!, leftCam, vp)!.depth,
    );
  });
});

describe('tweenCamera', () => {
  const FROM: OrbitCamera = { yawDeg: 0, pitchDeg: -8, distance: 3.2, fovDeg: 40, targetY: -0.25 };
  const TO: OrbitCamera = { yawDeg: 90, pitchDeg: -30, distance: 2.0, fovDeg: 46, targetY: -0.1 };

  test('t = 0 returns from; t >= 1 returns exact deep-equal arrival', () => {
    expect(tweenCamera(FROM, TO, 0)).toEqual(FROM);
    expect(tweenCamera(FROM, TO, 1)).toEqual(TO);
    expect(tweenCamera(FROM, TO, 1)).not.toBe(TO); // new object, not the input
    // t is clamped: overshoot and undershoot pin to the endpoints.
    expect(tweenCamera(FROM, TO, 7)).toEqual(TO);
    expect(tweenCamera(FROM, TO, -3)).toEqual(FROM);
  });

  test('midpoint uses smoothstep (te = 0.5 exactly at t = 0.5)', () => {
    const mid = tweenCamera(FROM, TO, 0.5);
    expect(mid.yawDeg).toBeCloseTo(45);
    expect(mid.pitchDeg).toBeCloseTo(-19);
    expect(mid.distance).toBeCloseTo(2.6);
    expect(mid.fovDeg).toBeCloseTo(43);
    expect(mid.targetY).toBeCloseTo(-0.175);
  });

  test('smoothstep eases: quarter progress travels less than linear', () => {
    // te(0.25) = 0.25^2 * (3 - 0.5) = 0.15625.
    const q = tweenCamera(FROM, TO, 0.25);
    expect(q.yawDeg).toBeCloseTo(90 * 0.15625);
    expect(q.yawDeg).toBeLessThan(90 * 0.25);
  });

  test('yaw takes the SHORTEST arc across the ±180 seam', () => {
    const from = { ...FROM, yawDeg: 170 };
    const to = { ...FROM, yawDeg: -170 };
    const mid = tweenCamera(from, to, 0.5);
    // Halfway across the seam lives in ±180 territory — never near 0.
    expect(Math.abs(mid.yawDeg)).toBeGreaterThan(90);
    expect(tweenCamera(from, to, 1).yawDeg).toBe(-170);
  });

  test('never mutates its inputs', () => {
    const from = { ...FROM };
    const to = { ...TO };
    tweenCamera(from, to, 0.5);
    expect(from).toEqual(FROM);
    expect(to).toEqual(TO);
  });
});

describe('autoOrbitStep', () => {
  test('advances yaw by dt * rate and wraps across the seam', () => {
    const cam: OrbitCamera = { ...DEFAULT_CAMERA, yawDeg: 179 };
    expect(autoOrbitStep(cam, 0.2, 10).yawDeg).toBeCloseTo(-179);
  });

  test('clamps dt to [0, 0.25] — an rAF hiccup cannot jump the camera', () => {
    const cam: OrbitCamera = { ...DEFAULT_CAMERA, yawDeg: 0 };
    expect(autoOrbitStep(cam, 10, 10).yawDeg).toBeCloseTo(2.5);
    expect(autoOrbitStep(cam, -5, 10).yawDeg).toBeCloseTo(0);
  });

  test('defaults to AUTO_ORBIT_DEG_PER_SEC and never mutates its input', () => {
    const cam: OrbitCamera = { ...DEFAULT_CAMERA, yawDeg: 0 };
    const before = { ...cam };
    const out = autoOrbitStep(cam, 0.1);
    expect(out.yawDeg).toBeCloseTo(0.1 * AUTO_ORBIT_DEG_PER_SEC);
    expect(out).not.toBe(cam);
    expect(cam).toEqual(before);
    // Only yaw changes; the rest of the camera rides through untouched.
    expect(out.pitchDeg).toBe(cam.pitchDeg);
    expect(out.distance).toBe(cam.distance);
    expect(out.fovDeg).toBe(cam.fovDeg);
    expect(out.targetY).toBe(cam.targetY);
  });
});
