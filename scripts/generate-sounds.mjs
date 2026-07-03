#!/usr/bin/env node
/**
 * generate-sounds.mjs — synthesizes HoopAI's feedback sounds as WAV files.
 *
 * Pure Node ESM, zero dependencies: a tiny additive synth (decaying sine /
 * square / saw stacks + lowpassed noise bursts) renders each cue and a
 * hand-rolled RIFF/WAVE encoder writes 44.1 kHz / 16-bit PCM / mono files.
 *
 * THREE sound packs are produced, one directory each under assets/sounds/:
 *
 *   classic/  — the original swish-chime voice (plucked sines).
 *   arcade/   — chippy 8-bit square-wave blips (coin make, arpeggio streaks).
 *   stadium/  — deeper broadcast voice (air-horn triads, crowd swells, thuds).
 *
 * The classic designs are ALSO written flat into assets/sounds/ for
 * backwards compatibility with existing static require()s.
 *
 * Every sound is ≤ 0.9 s, normalized to −3 dBFS peak, with a 5 ms fade-in
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
  G3: 195.9977,
  C4: 261.6256,
  A4: 440.0,
  CS5: 554.3653,
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
 * @param {'decay'|'swell'|'rise'} [opts.envelope]
 *        'decay'  = exponential decay burst (impacts),
 *        'swell'  = sin² rise-and-fall over the burst ("crowd swell"),
 *        'rise'   = quadratic ramp up over the burst ("rising crowd")
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
        : envelope === 'rise'
          ? Math.pow(i / n, 2)
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
// Timbres (harmonic stacks)
// ---------------------------------------------------------------------------

/** Karplus-ish pluck voicing: fundamental + soft 2nd + a little 3rd. */
const PLUCK = [
  { mult: 1, amp: 1 },
  { mult: 2, amp: 0.3 },
  { mult: 3, amp: 0.18 },
];

/** 8-bit "square wave": odd harmonics at 1/n (band-limited to the 9th). */
const SQUARE = [
  { mult: 1, amp: 1 },
  { mult: 3, amp: 1 / 3 },
  { mult: 5, amp: 1 / 5 },
  { mult: 7, amp: 1 / 7 },
  { mult: 9, amp: 1 / 9 },
];

/** Brassy "saw" for air-horns: all harmonics at 1/n up to the 6th. */
const SAW = [
  { mult: 1, amp: 1 },
  { mult: 2, amp: 1 / 2 },
  { mult: 3, amp: 1 / 3 },
  { mult: 4, amp: 1 / 4 },
  { mult: 5, amp: 1 / 5 },
  { mult: 6, amp: 1 / 6 },
];

// ---------------------------------------------------------------------------
// CLASSIC pack — the original swish-chime voice
// ---------------------------------------------------------------------------

/** make.wav — bright two-note "swish" chime (E5 → B5), ~250 ms. A reward. */
function classicMake() {
  const buf = makeBuffer(0.25);
  addTone(buf, { freq: NOTE.E5, startSec: 0, durSec: 0.25, amp: 0.9, decay: 13, harmonics: PLUCK });
  addTone(buf, { freq: NOTE.B5, startSec: 0.07, durSec: 0.18, amp: 1.0, decay: 11, harmonics: PLUCK });
  return buf;
}

/** miss.wav — soft neutral low thud (110 Hz + dull noise), ~140 ms. Never harsh. */
function classicMiss() {
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
function classicStreak3() {
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
function classicStreak5() {
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
function classicStreak10() {
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
function classicSessionStart() {
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
function classicRimLocked() {
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
// ARCADE pack — chippy 8-bit square-wave blips
// ---------------------------------------------------------------------------

/** Short square blip helper: fast attack, chip-style gated decay. */
function chip(buf, freq, startSec, durSec, amp = 1, decay = 16) {
  addTone(buf, {
    freq,
    startSec,
    durSec,
    amp,
    decay,
    harmonics: SQUARE,
    attackSec: 0.001,
  });
}

/** make.wav — coin-like ascending blip (B5 → E6), ~300 ms. Pure NES coin. */
function arcadeMake() {
  const buf = makeBuffer(0.3);
  chip(buf, NOTE.B5, 0, 0.08, 0.9, 10);
  chip(buf, NOTE.E6, 0.08, 0.22, 1.0, 9);
  return buf;
}

/** miss.wav — soft descending blip (E5 → C5), ~220 ms. Gentle, not a fail jingle. */
function arcadeMiss() {
  const buf = makeBuffer(0.22);
  chip(buf, NOTE.E5, 0, 0.09, 0.7, 18);
  chip(buf, NOTE.C5, 0.09, 0.13, 0.55, 20);
  return buf;
}

/** streak3.wav — rising 3-note square arpeggio (C5-E5-G5), ~320 ms. */
function arcadeStreak3() {
  const buf = makeBuffer(0.32);
  const notes = [NOTE.C5, NOTE.E5, NOTE.G5];
  for (let i = 0; i < notes.length; i++) {
    chip(buf, notes[i], i * 0.07, 0.12, 0.8 + i * 0.06, 14);
  }
  return buf;
}

/** streak5.wav — rising 4-note square arpeggio topping at C6, ~420 ms. */
function arcadeStreak5() {
  const buf = makeBuffer(0.42);
  const notes = [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6];
  for (let i = 0; i < notes.length; i++) {
    chip(buf, notes[i], i * 0.07, 0.14, 0.78 + i * 0.06, 12);
  }
  return buf;
}

/** streak10.wav — 6-note power-up run (two stacked arpeggio octaves), ~600 ms. */
function arcadeStreak10() {
  const buf = makeBuffer(0.6);
  const notes = [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6, NOTE.E6, NOTE.C6 * 1.5];
  for (let i = 0; i < notes.length; i++) {
    const last = i === notes.length - 1;
    chip(buf, notes[i], i * 0.075, last ? 0.16 : 0.12, 0.72 + i * 0.05, last ? 8 : 13);
  }
  return buf;
}

/** session_start.wav — single square ready beep (A5), ~120 ms. */
function arcadeSessionStart() {
  const buf = makeBuffer(0.12);
  chip(buf, NOTE.A5, 0, 0.12, 1, 15);
  return buf;
}

/** rim_locked.wav — two-tone square lock blip (G5 → C6), ~180 ms. */
function arcadeRimLocked() {
  const buf = makeBuffer(0.18);
  chip(buf, NOTE.G5, 0, 0.08, 0.8, 22);
  chip(buf, NOTE.C6, 0.08, 0.1, 0.9, 20);
  return buf;
}

// ---------------------------------------------------------------------------
// STADIUM pack — deeper broadcast voice: air-horns, crowd, low thuds
// ---------------------------------------------------------------------------

/** Sustained brassy horn note with a slight detuned double for width. */
function horn(buf, freq, startSec, durSec, amp = 1, decay = 5) {
  addTone(buf, { freq, startSec, durSec, amp, decay, harmonics: SAW, attackSec: 0.008 });
  addTone(buf, { freq: freq * 1.006, startSec, durSec, amp: amp * 0.5, decay, harmonics: SAW, attackSec: 0.008 });
}

/** make.wav — air-horn-ish A-major triad + crowd noise burst, ~550 ms. */
function stadiumMake() {
  const buf = makeBuffer(0.55);
  horn(buf, NOTE.A4, 0, 0.42, 0.9, 6);
  horn(buf, NOTE.CS5, 0.02, 0.4, 0.7, 6);
  horn(buf, NOTE.E5, 0.04, 0.38, 0.6, 6);
  // Crowd burst riding under the horn: bright-ish noise, quick swell.
  addNoise(buf, { startSec: 0.05, durSec: 0.5, amp: 0.55, smooth: 10, seed: 0x57ad, envelope: 'swell' });
  return buf;
}

/** miss.wav — low thud (70 Hz + heavy lowpassed noise), ~180 ms. */
function stadiumMiss() {
  const buf = makeBuffer(0.18);
  addTone(buf, {
    freq: 70,
    durSec: 0.18,
    amp: 1,
    decay: 18,
    harmonics: [
      { mult: 1, amp: 1 },
      { mult: 2, amp: 0.2 },
    ],
    attackSec: 0.002,
  });
  addNoise(buf, { durSec: 0.1, amp: 0.4, decay: 45, smooth: 40, seed: 0x0dd5 });
  return buf;
}

/** streak3.wav — rising crowd + one horn stab, ~500 ms. */
function stadiumStreak3() {
  const buf = makeBuffer(0.5);
  addNoise(buf, { durSec: 0.42, amp: 0.7, smooth: 16, seed: 0x5303, envelope: 'rise' });
  horn(buf, NOTE.A4, 0.3, 0.2, 0.8, 8);
  return buf;
}

/** streak5.wav — bigger rising crowd + two horn stabs, ~650 ms. */
function stadiumStreak5() {
  const buf = makeBuffer(0.65);
  addNoise(buf, { durSec: 0.55, amp: 0.8, smooth: 14, seed: 0x5505, envelope: 'rise' });
  horn(buf, NOTE.A4, 0.28, 0.16, 0.7, 9);
  horn(buf, NOTE.CS5, 0.44, 0.2, 0.85, 8);
  return buf;
}

/** streak10.wav — full crowd roar + triad horn fanfare, ~900 ms. */
function stadiumStreak10() {
  const buf = makeBuffer(0.9);
  addNoise(buf, { durSec: 0.5, amp: 0.75, smooth: 14, seed: 0x510a, envelope: 'rise' });
  addNoise(buf, { startSec: 0.45, durSec: 0.45, amp: 0.85, smooth: 12, seed: 0x510b, envelope: 'swell' });
  horn(buf, NOTE.A4, 0.4, 0.45, 0.85, 5);
  horn(buf, NOTE.CS5, 0.44, 0.41, 0.65, 5);
  horn(buf, NOTE.E5, 0.48, 0.37, 0.55, 5);
  return buf;
}

/** session_start.wav — short single horn blip (A4), ~180 ms. */
function stadiumSessionStart() {
  const buf = makeBuffer(0.18);
  horn(buf, NOTE.A4, 0, 0.16, 1, 12);
  return buf;
}

/** rim_locked.wav — two low confirmation thumps (G3 → C4), ~220 ms. */
function stadiumRimLocked() {
  const buf = makeBuffer(0.22);
  const round = [
    { mult: 1, amp: 1 },
    { mult: 2, amp: 0.2 },
  ];
  addTone(buf, { freq: NOTE.G3, startSec: 0, durSec: 0.1, amp: 0.85, decay: 20, harmonics: round });
  addTone(buf, { freq: NOTE.C4, startSec: 0.1, durSec: 0.12, amp: 1, decay: 18, harmonics: round });
  return buf;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Pack name → { file name → design fn }. Every pack has the full event set. */
const PACKS = {
  classic: {
    'make.wav': classicMake,
    'miss.wav': classicMiss,
    'streak3.wav': classicStreak3,
    'streak5.wav': classicStreak5,
    'streak10.wav': classicStreak10,
    'session_start.wav': classicSessionStart,
    'rim_locked.wav': classicRimLocked,
  },
  arcade: {
    'make.wav': arcadeMake,
    'miss.wav': arcadeMiss,
    'streak3.wav': arcadeStreak3,
    'streak5.wav': arcadeStreak5,
    'streak10.wav': arcadeStreak10,
    'session_start.wav': arcadeSessionStart,
    'rim_locked.wav': arcadeRimLocked,
  },
  stadium: {
    'make.wav': stadiumMake,
    'miss.wav': stadiumMiss,
    'streak3.wav': stadiumStreak3,
    'streak5.wav': stadiumStreak5,
    'streak10.wav': stadiumStreak10,
    'session_start.wav': stadiumSessionStart,
    'rim_locked.wav': stadiumRimLocked,
  },
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const soundsRoot = resolve(scriptDir, '..', 'assets', 'sounds');

let written = 0;
for (const [pack, designs] of Object.entries(PACKS)) {
  const outDir = join(soundsRoot, pack);
  mkdirSync(outDir, { recursive: true });
  for (const [name, design] of Object.entries(designs)) {
    const wav = encodeWav(finalize(design()), SAMPLE_RATE);
    const outPath = join(outDir, name);
    writeFileSync(outPath, wav);
    written++;
    const kb = (statSync(outPath).size / 1024).toFixed(1);
    console.log(`wrote ${outPath} (${kb} KB)`);
  }
}

// Legacy flat copies of the classic pack (existing static require()s).
mkdirSync(soundsRoot, { recursive: true });
for (const [name, design] of Object.entries(PACKS.classic)) {
  const wav = encodeWav(finalize(design()), SAMPLE_RATE);
  const outPath = join(soundsRoot, name);
  writeFileSync(outPath, wav);
  written++;
  const kb = (statSync(outPath).size / 1024).toFixed(1);
  console.log(`wrote ${outPath} (${kb} KB, legacy flat copy)`);
}

console.log(`done: ${written} sounds under ${soundsRoot}`);
