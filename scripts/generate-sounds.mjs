#!/usr/bin/env node
/**
 * generate-sounds.mjs — synthesizes HoopAI's feedback sounds as WAV files.
 *
 * Pure Node ESM, zero dependencies: a tiny additive synth (decaying sine
 * stacks + lowpassed noise bursts) renders each cue and a hand-rolled
 * RIFF/WAVE encoder writes 44.1 kHz / 16-bit PCM / mono files into
 * assets/sounds/.
 *
 * Every sound is ≤ 0.8 s, normalized to −3 dBFS peak, with a 5 ms fade-in
 * and a ≥30 ms fade-out to avoid clicks. Fully deterministic: noise comes
 * from a seeded mulberry32 PRNG, so re-running the script reproduces
 * byte-identical files.
 *
 * Usage:  node scripts/generate-sounds.mjs
 */
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 44100;
/** Target peak: −3 dBFS. */
const PEAK = Math.pow(10, -3 / 20);
const FADE_IN_SEC = 0.005;
const FADE_OUT_SEC = 0.04; // ≥ 30 ms per spec

/** Note frequencies (Hz), equal temperament A4 = 440. */
const NOTE = {
  C5: 523.2511,
  D5: 587.3295,
  E5: 659.2551,
  G5: 783.9909,
  A5: 880.0,
  B5: 987.7666,
  C6: 1046.5023,
  E6: 1318.5102,
};

// ---------------------------------------------------------------------------
// Tiny synth toolkit
// ---------------------------------------------------------------------------

/**
 * Deterministic 32-bit PRNG (mulberry32). Returns a function yielding
 * floats in [0, 1).
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Allocates a silent Float64Array mix buffer of `durationSec` seconds. */
function makeBuffer(durationSec) {
  return new Float64Array(Math.round(durationSec * SAMPLE_RATE));
}

/**
 * Mixes a decaying sine "pluck" into `buf`.
 *
 * @param {Float64Array} buf   mix buffer
 * @param {object} opts
 * @param {number} opts.freq        fundamental frequency, Hz
 * @param {number} [opts.startSec]  onset time within the buffer
 * @param {number} opts.durSec      tone length (clipped to buffer end)
 * @param {number} [opts.amp]       linear amplitude of the whole stack
 * @param {number} [opts.decay]     exponential decay rate, 1/s (bigger = shorter)
 * @param {Array<{mult:number, amp:number}>} [opts.harmonics]
 *                                  partials relative to freq (karplus-ish stack)
 * @param {number} [opts.attackSec] short linear attack to soften the onset
 */
function addTone(
  buf,
  { freq, startSec = 0, durSec, amp = 1, decay = 10, harmonics = [{ mult: 1, amp: 1 }], attackSec = 0.003 },
) {
  const start = Math.round(startSec * SAMPLE_RATE);
  const n = Math.min(Math.round(durSec * SAMPLE_RATE), buf.length - start);
  const w = (2 * Math.PI * freq) / SAMPLE_RATE;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const attack = attackSec > 0 ? Math.min(1, t / attackSec) : 1;
    const env = Math.exp(-decay * t) * attack;
    let s = 0;
    for (let h = 0; h < harmonics.length; h++) {
      s += harmonics[h].amp * Math.sin(w * harmonics[h].mult * i);
    }
    buf[start + i] += amp * env * s;
  }
}

/**
 * Mixes a lowpassed white-noise burst into `buf`. Lowpass is a simple
 * `smooth`-sample moving average — enough to tame the hiss into a thud
 * (large `smooth`) or a soft "sh" (small `smooth`).
 *
 * @param {Float64Array} buf   mix buffer
 * @param {object} opts
 * @param {number} [opts.startSec]  onset time within the buffer
 * @param {number} opts.durSec      burst length (clipped to buffer end)
 * @param {number} [opts.amp]       linear amplitude
 * @param {number} [opts.decay]     exp decay rate (used when envelope='decay')
 * @param {number} [opts.smooth]    moving-average window, samples (≥1)
 * @param {number} [opts.seed]      PRNG seed for deterministic output
 * @param {'decay'|'swell'} [opts.envelope]
 *        'decay'  = exponential decay burst (impacts),
 *        'swell'  = sin² rise-and-fall over the burst ("crowd swell")
 */
function addNoise(
  buf,
  { startSec = 0, durSec, amp = 1, decay = 30, smooth = 8, seed = 1, envelope = 'decay' },
) {
  const rand = mulberry32(seed);
  const start = Math.round(startSec * SAMPLE_RATE);
  const n = Math.min(Math.round(durSec * SAMPLE_RATE), buf.length - start);
  const win = new Float64Array(Math.max(1, smooth));
  let sum = 0;
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const white = rand() * 2 - 1;
    sum += white - win[idx];
    win[idx] = white;
    idx = idx + 1 === win.length ? 0 : idx + 1;
    const t = i / SAMPLE_RATE;
    const env =
      envelope === 'swell'
        ? Math.pow(Math.sin((Math.PI * i) / n), 2)
        : Math.exp(-decay * t);
    buf[start + i] += amp * env * (sum / win.length);
  }
}

/**
 * Applies fade-in/fade-out, normalizes to −3 dBFS peak, and converts the
 * float mix to clamped 16-bit PCM (the clamp is the clipping guard —
 * normalization should keep everything inside [−1, 1] already).
 */
function finalize(buf) {
  const fadeIn = Math.round(FADE_IN_SEC * SAMPLE_RATE);
  const fadeOut = Math.round(FADE_OUT_SEC * SAMPLE_RATE);
  for (let i = 0; i < fadeIn && i < buf.length; i++) buf[i] *= i / fadeIn;
  for (let i = 0; i < fadeOut && i < buf.length; i++) {
    buf[buf.length - 1 - i] *= i / fadeOut;
  }
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  const gain = peak > 0 ? PEAK / peak : 0;
  const pcm = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const v = Math.max(-1, Math.min(1, buf[i] * gain));
    pcm[i] = Math.round(v * 32767);
  }
  return pcm;
}

/** Encodes mono 16-bit PCM as a canonical 44-byte-header RIFF/WAVE buffer. */
function encodeWav(pcm, sampleRate) {
  const dataBytes = pcm.length * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16); // fmt chunk size
  b.writeUInt16LE(1, 20); // audio format: PCM
  b.writeUInt16LE(1, 22); // channels: mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono 16-bit)
  b.writeUInt16LE(2, 32); // block align
  b.writeUInt16LE(16, 34); // bits per sample
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i], 44 + i * 2);
  return b;
}

// ---------------------------------------------------------------------------
// Sound designs
// ---------------------------------------------------------------------------

/** Karplus-ish pluck voicing: fundamental + soft 2nd + a little 3rd. */
const PLUCK = [
  { mult: 1, amp: 1 },
  { mult: 2, amp: 0.3 },
  { mult: 3, amp: 0.18 },
];

/** make.wav — bright two-note "swish" chime (E5 → B5), ~250 ms. A reward. */
function designMake() {
  const buf = makeBuffer(0.25);
  addTone(buf, { freq: NOTE.E5, startSec: 0, durSec: 0.25, amp: 0.9, decay: 13, harmonics: PLUCK });
  addTone(buf, { freq: NOTE.B5, startSec: 0.07, durSec: 0.18, amp: 1.0, decay: 11, harmonics: PLUCK });
  return buf;
}

/** miss.wav — soft neutral low thud (110 Hz + dull noise), ~140 ms. Never harsh. */
function designMiss() {
  const buf = makeBuffer(0.14);
  addTone(buf, {
    freq: 110,
    durSec: 0.14,
    amp: 1.0,
    decay: 24,
    harmonics: [
      { mult: 1, amp: 1 },
      { mult: 2, amp: 0.15 },
    ],
    attackSec: 0.002,
  });
  addNoise(buf, { durSec: 0.08, amp: 0.35, decay: 55, smooth: 14, seed: 0xb0d1 });
  return buf;
}

/** streak3.wav — rising 3-note major arpeggio (C5-E5-G5), ~350 ms. */
function designStreak3() {
  const buf = makeBuffer(0.35);
  const notes = [NOTE.C5, NOTE.E5, NOTE.G5];
  for (let i = 0; i < notes.length; i++) {
    addTone(buf, {
      freq: notes[i],
      startSec: i * 0.09,
      durSec: 0.35 - i * 0.09,
      amp: 0.85 + i * 0.05,
      decay: 11,
      harmonics: PLUCK,
    });
  }
  return buf;
}

/** streak5.wav — rising 4-note arpeggio + subtle detuned shimmer, ~450 ms. */
function designStreak5() {
  const buf = makeBuffer(0.45);
  const notes = [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6];
  for (let i = 0; i < notes.length; i++) {
    addTone(buf, {
      freq: notes[i],
      startSec: i * 0.08,
      durSec: 0.45 - i * 0.08,
      amp: 0.8 + i * 0.06,
      decay: 10,
      harmonics: PLUCK,
    });
  }
  // Shimmer: a detuned high pair riding above the last note, slow decay.
  addTone(buf, { freq: NOTE.C6 * 2, startSec: 0.24, durSec: 0.21, amp: 0.12, decay: 7, attackSec: 0.02 });
  addTone(buf, { freq: NOTE.C6 * 2 * 1.004, startSec: 0.24, durSec: 0.21, amp: 0.12, decay: 7, attackSec: 0.02 });
  return buf;
}

/** streak10.wav — 5-note fanfare, layered octave, gentle crowd swell, ~700 ms. */
function designStreak10() {
  const buf = makeBuffer(0.7);
  const fanfare = [
    { mult: 1, amp: 1 },
    { mult: 2, amp: 0.5 }, // layered octave
    { mult: 3, amp: 0.15 },
  ];
  const notes = [NOTE.C5, NOTE.D5, NOTE.E5, NOTE.G5, NOTE.C6];
  for (let i = 0; i < notes.length; i++) {
    const last = i === notes.length - 1;
    addTone(buf, {
      freq: notes[i],
      startSec: i * 0.1,
      durSec: 0.7 - i * 0.1,
      amp: 0.75 + i * 0.06,
      decay: last ? 6 : 12,
      harmonics: fanfare,
    });
  }
  // Gentle "crowd swell" underneath: heavily lowpassed noise, sin² envelope.
  addNoise(buf, { durSec: 0.7, amp: 0.5, smooth: 26, seed: 0xc501d, envelope: 'swell' });
  return buf;
}

/** session_start.wav — single clean ready beep (A5), ~120 ms. */
function designSessionStart() {
  const buf = makeBuffer(0.12);
  addTone(buf, {
    freq: NOTE.A5,
    durSec: 0.12,
    amp: 1,
    decay: 14,
    harmonics: [
      { mult: 1, amp: 1 },
      { mult: 2, amp: 0.1 },
    ],
  });
  return buf;
}

/** rim_locked.wav — soft two-tone confirmation blip (G5 → C6), ~180 ms. */
function designRimLocked() {
  const buf = makeBuffer(0.18);
  const soft = [
    { mult: 1, amp: 1 },
    { mult: 2, amp: 0.12 },
  ];
  addTone(buf, { freq: NOTE.G5, startSec: 0, durSec: 0.1, amp: 0.8, decay: 22, harmonics: soft });
  addTone(buf, { freq: NOTE.C6, startSec: 0.08, durSec: 0.1, amp: 0.9, decay: 20, harmonics: soft });
  return buf;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const SOUNDS = [
  ['make.wav', designMake],
  ['miss.wav', designMiss],
  ['streak3.wav', designStreak3],
  ['streak5.wav', designStreak5],
  ['streak10.wav', designStreak10],
  ['session_start.wav', designSessionStart],
  ['rim_locked.wav', designRimLocked],
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(scriptDir, '..', 'assets', 'sounds');
mkdirSync(outDir, { recursive: true });

for (const [name, design] of SOUNDS) {
  const wav = encodeWav(finalize(design()), SAMPLE_RATE);
  const outPath = join(outDir, name);
  writeFileSync(outPath, wav);
  const kb = (statSync(outPath).size / 1024).toFixed(1);
  console.log(`wrote ${outPath} (${kb} KB)`);
}
console.log(`done: ${SOUNDS.length} sounds in ${outDir}`);
