/**
 * Height units — the ONE place centimetres turn into something a human reads,
 * and the ONE place a reading turns back into centimetres.
 *
 * CANONICAL STORAGE IS CENTIMETRES. profileStore.heightCm stays an integer
 * number of centimetres no matter which unit the player picked, because height
 * feeds real measurement downstream (the metre scale in formCheck.ts, the
 * body-archetype comparisons, Jump Lab's pixel ruler). A wrong unit there is a
 * wrong metric everywhere, so nothing downstream ever sees feet or inches:
 * conversion happens ONLY at the display edge, in this file.
 *
 * ROUND-TRIP STABILITY. An inch is coarser than a centimetre, so the first
 * cm -> ft/in -> cm hop can move the stored value by up to 1 cm (190 cm reads
 * as 6'3" and comes back as 191 cm). What must never happen is a WALK: a value
 * that keeps drifting every time the readout re-renders or the unit is toggled
 * back and forth. Rounding to whole inches and back to whole centimetres has a
 * fixed point after exactly one hop for every value in the slider's range,
 * which heightUnits.test.ts pins across the whole domain and both boundaries.
 *
 * Pure: no React, no store, no RN imports. Bounds are passed in by the caller
 * (they live in state/profileStore.ts) so core never depends on state.
 */

/** Which unit every height readout speaks in. Persisted in settingsStore. */
export type HeightUnit = 'cm' | 'ftin';

/** The exact, definitional inch. Never re-derive this by hand anywhere else. */
export const CM_PER_INCH = 2.54;

const INCHES_PER_FOOT = 12;

/** The unit toggle's options, in display order. */
export const HEIGHT_UNIT_OPTIONS: readonly { value: HeightUnit; label: string }[] = [
  { value: 'cm', label: 'cm' },
  { value: 'ftin', label: 'ft · in' },
] as const;

/** Human name of a unit, for the toggle's group label and spoken strings. */
export function heightUnitName(unit: HeightUnit): string {
  return unit === 'cm' ? 'centimetres' : 'feet and inches';
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Centimetres -> whole inches. Whole inches ARE the imperial resolution. */
export function cmToInches(cm: number): number {
  if (!Number.isFinite(cm)) return 0;
  return Math.round(cm / CM_PER_INCH);
}

/** Whole inches -> whole centimetres. */
export function inchesToCm(inches: number): number {
  if (!Number.isFinite(inches)) return 0;
  return Math.round(inches * CM_PER_INCH);
}

/** Split total inches into feet + inches, rolling 12" up (never "5'12""). */
export function splitFeetInches(totalInches: number): { feet: number; inches: number } {
  const t = Math.max(0, Math.round(Number.isFinite(totalInches) ? totalInches : 0));
  return { feet: Math.floor(t / INCHES_PER_FOOT), inches: t % INCHES_PER_FOOT };
}

/** Feet + inches -> total inches. */
export function joinFeetInches(feet: number, inches: number): number {
  return Math.round(feet) * INCHES_PER_FOOT + Math.round(inches);
}

/** `5'11"` — standard imperial notation, readable without a caption. */
export function formatFeetInches(totalInches: number): string {
  const { feet, inches } = splitFeetInches(totalInches);
  return `${feet}'${inches}"`;
}

/** Bounds the slider works in, in whatever unit is on screen. */
export interface HeightScale {
  min: number;
  max: number;
  step: number;
}

/**
 * The slider's domain for a unit. Imperial steps in whole inches, so the knob
 * lands exactly on the values the readout can show — a slider that could stop
 * between two displayable inches would look stuck.
 */
export function heightScale(unit: HeightUnit, minCm: number, maxCm: number): HeightScale {
  if (unit === 'cm') return { min: minCm, max: maxCm, step: 1 };
  return { min: cmToInches(minCm), max: cmToInches(maxCm), step: 1 };
}

/** Canonical cm -> the number the slider and readout work in. */
export function toDisplayHeight(cm: number, unit: HeightUnit): number {
  return unit === 'cm' ? Math.round(cm) : cmToInches(cm);
}

/**
 * A slider/readout number -> canonical cm, clamped back inside the real cm
 * bounds. The clamp is what keeps both ends reachable: 47" converts to 119 cm,
 * one below a 120 cm floor, and 87" to 221 cm, one above a 220 cm ceiling.
 */
export function fromDisplayHeight(
  value: number,
  unit: HeightUnit,
  minCm: number,
  maxCm: number,
): number {
  const cm = unit === 'cm' ? Math.round(value) : inchesToCm(value);
  return clamp(cm, minCm, maxCm);
}

/** The big numeral only — `178` or `5'11"`. The unit chip is drawn separately. */
export function formatDisplayHeight(value: number, unit: HeightUnit): string {
  return unit === 'cm' ? `${Math.round(value)}` : formatFeetInches(value);
}

/**
 * The trailing unit shown small after the numeral, or null when the numeral
 * already carries its own marks (`5'11"` needs no caption).
 */
export function heightUnitSuffix(unit: HeightUnit): string | null {
  return unit === 'cm' ? 'cm' : null;
}

/** One complete height for a row, chip or stat — `178 cm`, `5'11"`, or a dash. */
export function formatHeight(cm: number | null | undefined, unit: HeightUnit): string {
  if (cm == null || !Number.isFinite(cm)) return '—';
  const shown = formatDisplayHeight(toDisplayHeight(cm, unit), unit);
  const suffix = heightUnitSuffix(unit);
  return suffix == null ? shown : `${shown} ${suffix}`;
}

/**
 * The same height spelled out for a screen reader. `5'11"` is punctuation a
 * voice cannot be trusted to read as a measurement, so imperial is spoken in
 * words. Always carries BOTH the number and the unit.
 */
export function spokenHeight(cm: number | null | undefined, unit: HeightUnit): string {
  if (cm == null || !Number.isFinite(cm)) return 'not set';
  if (unit === 'cm') return `${Math.round(cm)} centimetres`;
  const { feet, inches } = splitFeetInches(cmToInches(cm));
  const ft = `${feet} ${feet === 1 ? 'foot' : 'feet'}`;
  if (inches === 0) return ft;
  return `${ft} ${inches} ${inches === 1 ? 'inch' : 'inches'}`;
}

/** Spoken form of a slider value already in the display unit. */
export function spokenDisplayHeight(value: number, unit: HeightUnit): string {
  return unit === 'cm'
    ? `${Math.round(value)} centimetres`
    : spokenHeight(inchesToCm(value), 'ftin');
}
