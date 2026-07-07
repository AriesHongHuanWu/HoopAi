/**
 * ShareCard — a 1080×1350 (4:5, feed-friendly) branded stats card drawn with
 * Skia, plus the never-throw share pipeline around it.
 *
 * RENDERING
 * ---------
 * The card is a pure Skia element ({@link ShareCardGraphic}) rendered fully
 * offscreen via Skia 2.6's `drawAsImage(element, size)` — no hidden Canvas
 * needs to be mounted, and the snapshot is always exactly CARD_W×CARD_H
 * regardless of device pixel ratio. A small {@link ShareCard} preview
 * component (a scaled `<Canvas>`) is exported for screens that want to show
 * the card inline.
 *
 * TYPE
 * ----
 * Skia can't see fonts loaded through expo-font (Barlow lives in RN's font
 * registry, not the system font manager), so numerals use `matchFont` against
 * a condensed SYSTEM face (Avenir Next Condensed / sans-serif-condensed) and
 * the design stays shape-led: the signature arc sweep, drawn make/miss pips,
 * and rounded 2PT/3PT split chips carry the brand.
 *
 * SHARING
 * -------
 * snapshot → PNG base64 → expo-file-system cache → RN Share.
 * iOS shares the image file directly (Share.share({ url })). Android's RN
 * Share can't attach files, so the card is saved to the photo library
 * (best-effort, write-only permission) and the text caption is shared.
 * Every public entry point resolves a boolean and NEVER throws.
 */
import {
  BlurMask,
  Canvas,
  Circle,
  Group,
  Image as SkiaImage,
  ImageFormat,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  RoundedRect,
  Skia,
  Text as SkText,
  drawAsImage,
  matchFont,
  useImage,
  vec,
  type SkFont,
  type SkImage,
} from '@shopify/react-native-skia';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
import React from 'react';
import { Platform, Share, type StyleProp, type ViewStyle } from 'react-native';

import { color } from '../constants/tokens';
import type { ResolvedShot, SessionStats, ShotOutcome } from '../core/types';

// ---------------------------------------------------------------------------
// Geometry constants (all drawing happens in this fixed design space)
// ---------------------------------------------------------------------------

export const CARD_W = 1080;
export const CARD_H = 1350;
/** Instagram-Story height (9:16) — the DEFAULT share format: full-bleed
 *  background, the familiar 4:5 composition centered inside the story-safe
 *  zone, and a brand hook at the bottom. Every share is an ad. */
export const CARD_H_STORY = 1920;

/** Card aspect: 'story' (IG-first default) or the classic 4:5 'feed'. */
export type CardFormat = 'story' | 'feed';
const PAD = 84;
const CONTENT_W = CARD_W - PAD * 2;

/** Alpha-0 endpoint of palette.leather for the radial glow fade. */
const GLOW_FADE = 'rgba(240, 90, 36, 0)';

// Photo-background legibility scrim (coal #100F0E = rgb 16,15,14): dark top +
// bottom where text sits, lighter middle so the shot frame shows through.
const SCRIM_TOP = 'rgba(16, 15, 14, 0.78)';
const SCRIM_MID = 'rgba(16, 15, 14, 0.40)';
const SCRIM_BOT = 'rgba(16, 15, 14, 0.88)';
/** Fainter accent wash over a photo (the full accentTint would muddy it). */
const ACCENT_WASH = 'rgba(240, 90, 36, 0.16)';

// ---------------------------------------------------------------------------
// Fonts — condensed SYSTEM face via matchFont (see module doc)
// ---------------------------------------------------------------------------

const DISPLAY_FAMILY = Platform.select({
  ios: 'Avenir Next Condensed',
  default: 'sans-serif-condensed',
});

const fontCache = new Map<number, SkFont>();

function displayFont(size: number): SkFont {
  let font = fontCache.get(size);
  if (font == null) {
    font = matchFont({
      fontFamily: DISPLAY_FAMILY,
      fontSize: size,
      fontStyle: 'normal',
      fontWeight: 'bold',
    });
    fontCache.set(size, font);
  }
  return font;
}

function textW(font: SkFont, text: string): number {
  return font.measureText(text).width;
}

/** Largest font ≤ `size` whose rendering of `text` fits in `maxW`. */
function fitFont(text: string, size: number, maxW: number): SkFont {
  let current = size;
  let font = displayFont(current);
  for (let i = 0; i < 3; i++) {
    const w = textW(font, text);
    if (w <= maxW || current <= 24) break;
    current = Math.max(24, Math.floor((current * maxW) / w));
    font = displayFont(current);
  }
  return font;
}

function trackedWidth(font: SkFont, text: string, tracking: number): number {
  let w = 0;
  for (const ch of text) w += textW(font, ch) + tracking;
  return Math.max(0, w - tracking);
}

/** Letter-spaced text (Skia Text has no letterSpacing — drawn per glyph). */
function TrackedText({
  text,
  x,
  y,
  font,
  tracking,
  fg,
  accentFromIndex,
}: {
  text: string;
  x: number;
  y: number;
  font: SkFont;
  tracking: number;
  fg: string;
  /** Characters from this index on render in the accent color. */
  accentFromIndex?: number;
}) {
  const nodes: React.JSX.Element[] = [];
  let cx = x;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    nodes.push(
      <SkText
        key={i}
        x={cx}
        y={y}
        text={ch}
        font={font}
        color={accentFromIndex != null && i >= accentFromIndex ? color.accent : fg}
      />,
    );
    cx += textW(font, ch) + tracking;
  }
  return <>{nodes}</>;
}

// ---------------------------------------------------------------------------
// Card data
// ---------------------------------------------------------------------------

interface ChipSpec {
  text: string;
  bg: string;
  fg: string;
}

/** Everything the graphic needs, precomputed so drawing stays dumb. */
export interface ShareCardData {
  /** Small tracked line above the title, e.g. "SESSION REPORT". */
  eyebrow: string;
  /** Big title line — session label or mode name. */
  title: string;
  /** Top-right date, e.g. "JUL 3, 2026". */
  dateLabel: string;
  /** The giant numeral, e.g. "68%" or "24". */
  hero: string;
  /** Tracked label under the hero, e.g. "FIELD GOALS". */
  heroLabel: string;
  /** Shot outcomes for the pip row (drawn newest-last, capped at 36). */
  pips: readonly ShotOutcome[];
  /** Rows of stat chips (makes / best run / 2PT / 3PT splits). */
  chips: readonly (readonly ChipSpec[])[];
  /**
   * Optional shot-frame background: a local image URI (a frame grabbed from the
   * session video at the shooting moment). When set, the card composites this
   * photo full-bleed behind a dark scrim so the stats stay legible; when absent
   * it falls back to the original coal + radial-glow background.
   */
  backgroundUri?: string;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function formatDate(ms: number): string {
  const d = new Date(ms);
  const month = MONTHS[d.getMonth()] ?? '';
  return `${month} ${d.getDate()}, ${d.getFullYear()}`.toUpperCase();
}

function buildChipRows(stats: SessionStats): ChipSpec[][] {
  const rows: ChipSpec[][] = [
    [
      {
        text: `${stats.makes}/${stats.attempts} MAKES`,
        bg: color.makeTint,
        fg: color.make,
      },
      {
        text: `BEST RUN ${stats.bestStreak}`,
        bg: color.accentTint,
        fg: color.accent,
      },
    ],
  ];
  const splits: ChipSpec[] = [];
  if (stats.twoPtAttempts > 0) {
    splits.push({
      text: `2PT ${stats.twoPtMakes}/${stats.twoPtAttempts}`,
      bg: color.surfaceRaised,
      fg: color.textDim,
    });
  }
  if (stats.threePtAttempts > 0) {
    splits.push({
      text: `3PT ${stats.threePtMakes}/${stats.threePtAttempts}`,
      bg: color.threePtTint,
      fg: color.threePt,
    });
  }
  if (splits.length > 0) rows.push(splits);
  return rows;
}

/** Card data for a finished shooting session (hero = FG%). */
export function sessionCardData(opts: {
  stats: SessionStats;
  shots: readonly ResolvedShot[];
  label: string;
  /** Session start (epoch ms); defaults to now. */
  dateMs?: number;
}): ShareCardData {
  const { stats, shots } = opts;
  const decided = stats.makes + stats.misses;
  const pct = decided > 0 ? Math.round(stats.fgPct * 100) : 0;
  return {
    eyebrow: 'SESSION REPORT',
    title: opts.label.trim() !== '' ? opts.label.trim() : 'Shooting session',
    dateLabel: formatDate(opts.dateMs ?? Date.now()),
    hero: `${pct}%`,
    heroLabel: 'FIELD GOALS',
    pips: shots.map((s) => s.outcome),
    chips: buildChipRows(stats),
  };
}

/** Card data for a completed game mode (hero = the mode's score). */
export function modeCardData(opts: {
  /** Mode display name, e.g. "Timed Challenge". */
  modeName: string;
  /** Hero numeral, e.g. "24" or "HORSE". */
  value: string;
  /** Label under the hero, e.g. "makes" / "points" / "in a row". */
  unit: string;
  stats: SessionStats;
  shots: readonly ResolvedShot[];
  dateMs?: number;
}): ShareCardData {
  return {
    eyebrow: 'GAME MODE',
    title: opts.modeName,
    dateLabel: formatDate(opts.dateMs ?? Date.now()),
    hero: opts.value,
    heroLabel: (opts.unit !== '' ? opts.unit : 'Final').toUpperCase(),
    pips: opts.shots.map((s) => s.outcome),
    chips: buildChipRows(opts.stats),
  };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Make/miss/unsure pips — always color + shape (dot / X / ring). */
function Pips({ pips }: { pips: readonly ShotOutcome[] }) {
  const PITCH = 46;
  const PER_ROW = 18;
  const shown = pips.slice(-PER_ROW * 2);
  if (shown.length === 0) return null;
  const rows: (readonly ShotOutcome[])[] =
    shown.length <= PER_ROW
      ? [shown]
      : [shown.slice(0, Math.ceil(shown.length / 2)), shown.slice(Math.ceil(shown.length / 2))];
  const nodes: React.JSX.Element[] = [];
  rows.forEach((row, ri) => {
    const cy = 1084 + ri * 48;
    const startX = (CARD_W - (row.length - 1) * PITCH) / 2;
    row.forEach((outcome, i) => {
      const cx = startX + i * PITCH;
      const key = `${ri}-${i}`;
      if (outcome === 'make') {
        nodes.push(<Circle key={key} cx={cx} cy={cy} r={13} color={color.make} />);
      } else if (outcome === 'miss') {
        const x = Skia.Path.Make();
        x.moveTo(cx - 9, cy - 9);
        x.lineTo(cx + 9, cy + 9);
        x.moveTo(cx + 9, cy - 9);
        x.lineTo(cx - 9, cy + 9);
        nodes.push(
          <Path
            key={key}
            path={x}
            style="stroke"
            strokeWidth={5}
            strokeCap="round"
            color={color.miss}
          />,
        );
      } else {
        nodes.push(
          <Circle
            key={key}
            cx={cx}
            cy={cy}
            r={11}
            style="stroke"
            strokeWidth={4}
            color={color.unsure}
          />,
        );
      }
    });
  });
  return <>{nodes}</>;
}

/** One centered row of rounded stat chips. */
function ChipRow({ chips, top }: { chips: readonly ChipSpec[]; top: number }) {
  if (chips.length === 0) return null;
  const H = 62;
  const GAP = 20;
  let font = displayFont(30);
  let padX = 34;
  let widths = chips.map((c) => textW(font, c.text) + padX * 2);
  let total = widths.reduce((a, w) => a + w, 0) + GAP * (chips.length - 1);
  if (total > CONTENT_W) {
    font = displayFont(26);
    padX = 26;
    widths = chips.map((c) => textW(font, c.text) + padX * 2);
    total = widths.reduce((a, w) => a + w, 0) + GAP * (chips.length - 1);
  }
  const nodes: React.JSX.Element[] = [];
  let x = (CARD_W - total) / 2;
  chips.forEach((chip, i) => {
    const w = widths[i]!;
    nodes.push(
      <RoundedRect key={`bg-${i}`} x={x} y={top} width={w} height={H} r={H / 2} color={chip.bg} />,
      <SkText
        key={`tx-${i}`}
        x={x + padX}
        y={top + 42}
        text={chip.text}
        font={font}
        color={chip.fg}
      />,
    );
    x += w + GAP;
  });
  return <>{nodes}</>;
}

/**
 * The card itself — a pure Skia element in CARD_W×CARD_H space. Renderable
 * inside any `<Canvas>` or offscreen via `drawAsImage`. No hooks, so it is
 * safe under Skia's offscreen reconciler.
 */
export function ShareCardGraphic({
  data,
  bgImage,
  format = 'story',
}: {
  data: ShareCardData;
  /** Pre-decoded shot-frame background (loaded by the caller — offscreen-safe). */
  bgImage?: SkImage | null;
  format?: CardFormat;
}) {
  const H = format === 'story' ? CARD_H_STORY : CARD_H;
  /** Story mode: the 4:5 composition drops by this much, clearing IG's
   *  top chrome and centering in the safe zone. */
  const dy = format === 'story' ? 235 : 0;
  const wordmarkFont = displayFont(60);
  const dateFont = displayFont(30);
  const eyebrowFont = displayFont(30);
  const titleFont = fitFont(data.title, 76, CONTENT_W);
  const heroFont = fitFont(data.hero, 330, 900);
  const labelFont = displayFont(30);

  // Signature arc sweep landing at a glowing ball, sparks fanning out.
  const landX = 846;
  const landY = 540;
  const arc = Skia.Path.Make();
  arc.moveTo(130, 592);
  arc.quadTo(430, 330, landX, landY);
  const sparks = Skia.Path.Make();
  for (const deg of [-78, -42, -8]) {
    const rad = (deg * Math.PI) / 180;
    sparks.moveTo(landX + Math.cos(rad) * 26, landY + Math.sin(rad) * 26);
    sparks.lineTo(landX + Math.cos(rad) * 46, landY + Math.sin(rad) * 46);
  }

  const heroW = textW(heroFont, data.hero);
  const heroLabelW = trackedWidth(labelFont, data.heroLabel, 6);
  const dateW = textW(dateFont, data.dateLabel);

  return (
    <Group>
      {/* Coal base (also the letterbox fill if the photo isn't a perfect fit). */}
      <Rect x={0} y={0} width={CARD_W} height={H} color={color.bg} />
      {bgImage != null ? (
        <>
          {/* Shot-frame photo, full-bleed cover. */}
          <SkiaImage image={bgImage} x={0} y={0} width={CARD_W} height={H} fit="cover" />
          {/* Legibility scrim: darker at the top (wordmark/title) and bottom
              (hero/pips/chips), letting the photo show through the middle band. */}
          <Rect x={0} y={0} width={CARD_W} height={H}>
            <LinearGradient
              start={vec(0, 0)}
              end={vec(0, H)}
              colors={[SCRIM_TOP, SCRIM_MID, SCRIM_BOT]}
              positions={[0, 0.45, 1]}
            />
          </Rect>
          {/* Keep a touch of the leather glow so the brand read survives. */}
          <Rect x={0} y={0} width={CARD_W} height={H}>
            <RadialGradient c={vec(CARD_W / 2, 840 + dy)} r={660} colors={[ACCENT_WASH, GLOW_FADE]} />
          </Rect>
        </>
      ) : (
        /* No photo → the original coal + subtle leather radial glow. */
        <Rect x={0} y={0} width={CARD_W} height={H}>
          <RadialGradient c={vec(CARD_W / 2, 840 + dy)} r={660} colors={[color.accentTint, GLOW_FADE]} />
        </Rect>
      )}
      {/* The classic 4:5 composition, dropped into the story-safe zone. */}
      <Group transform={[{ translateY: dy }]}>
      {/* Faint center-court circle grounding the hero numeral. */}
      <Circle
        cx={CARD_W / 2}
        cy={870}
        r={290}
        style="stroke"
        strokeWidth={2}
        color={color.border}
        opacity={0.9}
      />

      {/* Header: wordmark + date, hairline divider. */}
      <TrackedText
        text="HOOPILOT"
        x={PAD}
        y={148}
        font={wordmarkFont}
        tracking={8}
        fg={color.text}
        accentFromIndex={4}
      />
      <SkText
        x={CARD_W - PAD - dateW}
        y={144}
        text={data.dateLabel}
        font={dateFont}
        color={color.textDim}
      />
      <Rect x={PAD} y={190} width={CONTENT_W} height={2} color={color.border} />

      {/* Eyebrow + title. */}
      <TrackedText
        text={data.eyebrow}
        x={PAD}
        y={272}
        font={eyebrowFont}
        tracking={6}
        fg={color.accent}
      />
      <SkText x={PAD} y={358} text={data.title} font={titleFont} color={color.text} />

      {/* Arc sweep: bloom, core stroke, sparks, landing ball. */}
      <Path path={arc} style="stroke" strokeWidth={14} strokeCap="round" color={color.accent} opacity={0.25}>
        <BlurMask blur={16} style="normal" />
      </Path>
      <Path path={arc} style="stroke" strokeWidth={5} strokeCap="round" color={color.accent} opacity={0.75} />
      <Path path={sparks} style="stroke" strokeWidth={5} strokeCap="round" color={color.threePt} opacity={0.9} />
      <Circle cx={landX} cy={landY} r={26} color={color.accent} opacity={0.4}>
        <BlurMask blur={12} style="normal" />
      </Circle>
      <Circle cx={landX} cy={landY} r={13} color={color.accent} />

      {/* Hero numeral + tracked label. */}
      <SkText x={(CARD_W - heroW) / 2} y={950} text={data.hero} font={heroFont} color={color.text} />
      <TrackedText
        text={data.heroLabel}
        x={(CARD_W - heroLabelW) / 2}
        y={1012}
        font={labelFont}
        tracking={6}
        fg={color.textDim}
      />

      {/* Make/miss pip rows. */}
      <Pips pips={data.pips} />

      {/* Stat chips. */}
      {data.chips.map((row, i) => (
        <ChipRow key={i} chips={row} top={1180 + i * 82} />
      ))}
      </Group>

      {/* Story-only bottom brand hook — the line every viewer reads. */}
      {format === 'story' && (
        <TrackedText
          text="TRACK YOUR GAME · HOOPILOT"
          x={(CARD_W - trackedWidth(displayFont(30), 'TRACK YOUR GAME · HOOPILOT', 6)) / 2}
          y={H - 84}
          font={displayFont(30)}
          tracking={6}
          fg={color.textDim}
        />
      )}
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Inline preview component
// ---------------------------------------------------------------------------

/** Scaled inline preview of the card (the share pipeline renders offscreen). */
export function ShareCard({
  data,
  width = 270,
  style,
  format = 'story',
}: {
  data: ShareCardData;
  /** Rendered width in dp; height follows the format's aspect. */
  width?: number;
  style?: StyleProp<ViewStyle>;
  format?: CardFormat;
}) {
  const scale = width / CARD_W;
  const H = format === 'story' ? CARD_H_STORY : CARD_H;
  // Load the optional shot-frame background for the inline preview (async, safe
  // to call with null — returns null until/unless a uri decodes).
  const bgImage = useImage(data.backgroundUri ?? null);
  return (
    <Canvas
      style={[{ width, height: Math.round(H * scale) }, style]}
      accessible
      accessibilityLabel={`Share card: ${data.title}, ${data.hero} ${data.heroLabel.toLowerCase()}`}
    >
      <Group transform={[{ scale }]}>
        <ShareCardGraphic data={data} bgImage={bgImage} format={format} />
      </Group>
    </Canvas>
  );
}

// ---------------------------------------------------------------------------
// Share pipeline (never throws)
// ---------------------------------------------------------------------------

async function shareText(message: string): Promise<boolean> {
  try {
    await Share.share({ message });
    return true;
  } catch {
    return false;
  }
}

/** Best-effort save to the photo library (Android path). Never throws. */
async function saveToLibrary(uri: string): Promise<void> {
  try {
    // writeOnly → add-only scope where the platform supports it.
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) return;
    await MediaLibrary.saveToLibraryAsync(uri);
  } catch (err) {
    console.warn('[shareCard] Could not save card to library', err);
  }
}

/**
 * Render `data` to a PNG and hand it to the native share sheet.
 * iOS: shares the image file. Android: saves the card to Photos
 * (best-effort) and shares the text caption. Any failure anywhere falls back
 * to a plain text share. Resolves false only when even that failed
 * (including the user having dismissed nothing — a plain sheet dismissal
 * still resolves true). NEVER throws.
 */
export async function shareCardImage(
  data: ShareCardData,
  fallbackMessage: string,
): Promise<boolean> {
  // Decode the optional shot-frame background off the file URI first (offscreen
  // drawAsImage can't run the useImage hook). Best-effort — a bad frame just
  // falls back to the coal background.
  let bgImage: SkImage | null = null;
  let bgData: ReturnType<typeof Skia.Data.fromBytes> | null = null;
  if (data.backgroundUri != null && data.backgroundUri !== '') {
    try {
      bgData = await Skia.Data.fromURI(data.backgroundUri);
      bgImage = Skia.Image.MakeImageFromEncoded(bgData);
    } catch {
      bgImage = null;
    }
  }
  try {
    const image = await drawAsImage(
      <ShareCardGraphic data={data} bgImage={bgImage} format="story" />,
      {
        width: CARD_W,
        height: CARD_H_STORY,
      },
    );
    const base64 = image?.encodeToBase64(ImageFormat.PNG);
    const dir = FileSystem.cacheDirectory;
    if (image == null || base64 == null || base64.length === 0 || dir == null) {
      return shareText(fallbackMessage);
    }
    const uri = `${dir}hoopai-card-${Date.now()}.png`;
    await FileSystem.writeAsStringAsync(uri, base64, { encoding: 'base64' });
    if (Platform.OS === 'ios') {
      await Share.share({ url: uri });
      return true;
    }
    await saveToLibrary(uri);
    return shareText(fallbackMessage);
  } catch (err) {
    console.warn('[shareCard] Card share failed, falling back to text', err);
    return shareText(fallbackMessage);
  } finally {
    bgImage?.dispose?.();
    bgData?.dispose?.();
  }
}

/**
 * "My NBA twin" card data — the Shot Lab's most shareable artifact. Reuses
 * the session-card composition: the similarity % is the hero numeral, the
 * you-vs-him stat rows become the chips.
 */
export function twinCardData(match: {
  player: { name: string; style: string; motion: string };
  similarity: number;
  rows: readonly { label: string; unit: string; user: number; player: number }[];
}): ShareCardData {
  const chipRows: ChipSpec[][] = [];
  let row: ChipSpec[] = [];
  for (const r of match.rows) {
    row.push({
      text: `${r.label.toUpperCase()} ME ${Math.round(r.user)}${r.unit} · HIM ${Math.round(r.player)}${r.unit}`,
      bg: color.surfaceRaised,
      fg: color.text,
    });
    if (row.length === 2) {
      chipRows.push(row);
      row = [];
    }
  }
  if (row.length > 0) chipRows.push(row);
  return {
    eyebrow: 'MY NBA TWIN',
    title: match.player.name,
    dateLabel: match.player.motion.toUpperCase(),
    hero: `${match.similarity}%`,
    heroLabel: match.player.style.toUpperCase(),
    pips: [],
    chips: chipRows.slice(0, 2),
  };
}

/** Share the "My NBA twin" story card. Never throws. */
export async function shareTwinCard(match: Parameters<typeof twinCardData>[0]): Promise<boolean> {
  const fallback = `🏀 My jumper is ${match.similarity}% ${match.player.name} — measured on Hoopilot.`;
  return shareCardImage(twinCardData(match), fallback);
}

/**
 * One-call session share: build the card from stats/shots and share it.
 * Never throws; resolves false when even the text fallback failed.
 */
export async function shareSessionCard(opts: {
  stats: SessionStats;
  shots: readonly ResolvedShot[];
  label: string;
  /** Session start (epoch ms); defaults to now. */
  dateMs?: number;
  /** Optional shot-frame background (local image URI) grabbed from the video. */
  backgroundUri?: string;
}): Promise<boolean> {
  const { stats } = opts;
  const decided = stats.makes + stats.misses;
  const pct = decided > 0 ? Math.round(stats.fgPct * 100) : 0;
  const fallback = `🏀 ${stats.makes}/${stats.attempts} makes (${pct}% FG), best run ${stats.bestStreak} — tracked on Hoopilot.`;
  return shareCardImage(
    { ...sessionCardData(opts), backgroundUri: opts.backgroundUri },
    fallback,
  );
}
