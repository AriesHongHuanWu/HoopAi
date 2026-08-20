/**
 * Session setup — instant-start hero + collapsible options; the camera never
 * renders here.
 *
 * Layout: [header] → [StartHero: GO CTA + summary chips + tips strip] →
 * [Options header] → five CollapsibleSections (mode / camera / recording /
 * court & ball / calibration) → StickyStartBar (appears once the hero CTA
 * scrolls off-screen, with hysteresis so it never flickers at the boundary).
 *
 * All section bodies live in @/components/setup/SetupSections (pure
 * presentation); this screen owns every store read/write and the scroll
 * choreography. Seeds orientation/duration/makes-per-spot from the persisted
 * last-used values so repeat sessions are one tap.
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useCameraPermission,
  useMicrophonePermission,
} from 'react-native-vision-camera';

import { BackPill } from '@/components/ShotList';
import { useCardStagger } from '@/components/motion';
import { CollapsibleSection } from '@/components/setup/CollapsibleSection';
import {
  CalibrationSectionBody,
  CameraSectionBody,
  CourtBallSectionBody,
  ModeSectionBody,
  RecordingSectionBody,
} from '@/components/setup/SetupSections';
import { StartHero, type StartHeroChip } from '@/components/setup/StartHero';
import { StickyStartBar } from '@/components/setup/StickyStartBar';
import {
  HERO_CHIP_DEFS,
  SETUP_SECTION_ORDER,
  defaultExpanded,
  cameraSubtitle,
  courtBallSubtitle,
  modeSubtitle,
  recordingSubtitle,
  startSummaryLine,
  type SetupSectionId,
} from '@/components/setup/setupDefaults';
import { Eyebrow, Row } from '@/components/ui';
import { color, motion, space, type } from '@/constants/tokens';
import { getModeDef } from '@/core/gameModes';
import { useMode } from '@/state/modeStore';
import { useSession } from '@/state/sessionStore';
import { useSettings } from '@/state/settingsStore';

/** Pre-flight config choices — passed to ModeSectionBody as chip values. */
const TIMED_DURATIONS = [30, 60, 90, 120] as const;
const SPOT_MAKE_TARGETS = [3, 5, 7, 10] as const;

/** Collapsed-header titles for the five option sections. */
const SECTION_TITLES: Record<SetupSectionId, string> = {
  mode: 'Game mode',
  camera: 'Camera & placement',
  recording: 'Recording',
  courtBall: 'Court & ball',
  calibration: 'Calibration',
};

/**
 * Sticky-bar hysteresis half-width (px): the bar flips ON only once the
 * scroll offset passes heroBottom + 8 and OFF only below heroBottom - 8, so
 * a finger resting exactly at the boundary can't strobe the bar.
 */
const STICKY_HYSTERESIS_PX = 8;

export default function SessionSetupScreen() {
  const insets = useSafeAreaInsets();
  const camera = useCameraPermission();
  const mic = useMicrophonePermission();
  const recordVideo = useSettings((s) => s.recordVideo);
  const keepMode = useSettings((s) => s.keepMode);
  const rimHeightM = useSettings((s) => s.rimHeightM);
  const ballSize = useSettings((s) => s.ballSize);
  const courtRange = useSettings((s) => s.courtRange);
  const set = useSettings((s) => s.set);
  const beginSetup = useSession((s) => s.beginSetup);
  const activeMode = useMode((s) => s.activeMode);
  const selectMode = useMode((s) => s.selectMode);
  const modeDef = activeMode != null ? getModeDef(activeMode.modeId) : null;
  const drillArmed = activeMode?.config?.drill != null;

  // Orientation the live session LOCKS to (chosen here). Locking it in
  // live.tsx means the camera never rotates mid-session, so the detection
  // overlay can't dislocate on a portrait/landscape flip. Seeded from the
  // last session's choice — Home's quick-start reads the same key.
  const [orient, setOrient] = useState<'portrait' | 'landscape'>(
    () => useSettings.getState().lastOrient,
  );
  // Pre-flight config for the modes that need it — duration for Timed
  // Challenge, makes-per-spot for Spot Shooting. Seeded from the armed mode's
  // config first (a fresh selectMode already carries the value), then from
  // the persisted last-used value so repeat players keep their number.
  const [durationSec, setDurationSec] = useState(
    () => useMode.getState().activeMode?.config?.durationSec ?? useSettings.getState().lastDurationSec,
  );
  const [makesPerSpot, setMakesPerSpot] = useState(
    () => useMode.getState().activeMode?.config?.makesPerSpot ?? useSettings.getState().lastMakesPerSpot,
  );
  // Session-local expand/collapse state, computed ONCE at mount (deliberately
  // not reactive to later permission grants — the section stays open).
  const [expanded, setExpanded] = useState<Record<SetupSectionId, boolean>>(() =>
    defaultExpanded({
      modeArmed: useMode.getState().activeMode != null,
      cameraGranted: camera.hasPermission,
    }),
  );

  // Scroll choreography: each section wrapper records its content-container Y
  // so hero chips can scroll straight to it; the hero reports its bottom edge
  // for the sticky bar's appear boundary.
  const scrollRef = useRef<ScrollView>(null);
  const sectionY = useRef<Partial<Record<SetupSectionId, number>>>({});
  const heroBottomY = useRef(0);
  const [stickyOn, setStickyOn] = useState(false);

  const reducedMotion = useReducedMotion();
  const enter = useCardStagger({ stepMs: 70, durationMs: motion.standard });

  // Double-tap guard: exactly one /session/live push per screen visit. Reset
  // on focus so backing out of live re-arms the START CTA.
  const openingRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      openingRef.current = false;
    }, []),
  );

  const openCamera = async () => {
    if (openingRef.current) return;
    openingRef.current = true;
    if (!camera.hasPermission && camera.canRequestPermission) {
      const granted = await camera.requestPermission();
      if (!granted) {
        openingRef.current = false;
        return;
      }
    }
    if (recordVideo && !mic.hasPermission && mic.canRequestPermission) {
      // Best effort — recording works without game audio if declined.
      await mic.requestPermission();
    }
    beginSetup();
    // Remember the choice so Home's quick-start can skip this screen next time.
    useSettings.getState().set('lastOrient', orient);
    router.push(`/session/live?orient=${orient}`);
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    // Hysteresis: ON only above hero bottom + 8, OFF only below hero bottom
    // - 8. The functional update bails out when the value is unchanged, so
    // steady scrolling doesn't re-render the screen.
    setStickyOn((prev) => {
      const boundary = heroBottomY.current;
      return prev
        ? y > boundary - STICKY_HYSTERESIS_PX
        : y > boundary + STICKY_HYSTERESIS_PX;
    });
  };

  const onChipPress = (id: SetupSectionId) => {
    setExpanded((e) => ({ ...e, [id]: true }));
    scrollRef.current?.scrollTo({
      y: (sectionY.current[id] ?? 0) - space.md,
      animated: !reducedMotion,
    });
  };

  // Re-selecting the mode re-inits its running state (fresh clock/spots), so
  // this must only ever happen pre-camera — initMode is a full reset. The
  // persisted last-used value seeds the next session's chips.
  const onPickDuration = (sec: number) => {
    setDurationSec(sec);
    selectMode('timed', { durationSec: sec });
    set('lastDurationSec', sec);
  };
  const onPickMakes = (n: number) => {
    setMakesPerSpot(n);
    selectMode('spotShooting', { makesPerSpot: n });
    set('lastMakesPerSpot', n);
  };

  const startDisabled = !camera.hasPermission && !camera.canRequestPermission;
  const summary = startSummaryLine({
    modeName: modeDef?.name ?? null,
    orient,
    recordVideo,
    keepMode,
  });

  const modeSub = modeSubtitle({
    modeId: activeMode?.modeId ?? null,
    drillId: activeMode?.config?.drill?.id ?? null,
    durationSec,
    makesPerSpot,
  });
  const recordingSub = recordingSubtitle({ recordVideo, keepMode });

  // Hero summary chips — labels mirror the section subtitles they open.
  const chips: StartHeroChip[] = HERO_CHIP_DEFS.map((d) => ({
    id: d.id,
    icon: d.icon as StartHeroChip['icon'],
    label:
      d.id === 'mode'
        ? modeSub
        : d.id === 'camera'
          ? orient === 'portrait'
            ? 'Portrait'
            : 'Landscape'
          : recordingSub,
  }));

  const sectionSubtitle = (id: SetupSectionId): string | undefined => {
    switch (id) {
      case 'mode':
        return modeSub;
      case 'camera':
        return cameraSubtitle({ granted: camera.hasPermission, orient });
      case 'recording':
        return recordingSub;
      case 'courtBall':
        return courtBallSubtitle({ rimHeightM, ballSize, courtRange });
      case 'calibration':
        return undefined;
    }
  };

  const sectionBody = (id: SetupSectionId): React.ReactNode => {
    switch (id) {
      case 'mode':
        return (
          <ModeSectionBody
            modeName={modeDef?.name ?? null}
            modeTagline={modeDef?.tagline ?? null}
            modeId={activeMode?.modeId ?? 'free'}
            drillArmed={drillArmed}
            needsTimer={modeDef?.needsTimer ?? false}
            isSpotShooting={modeDef?.id === 'spotShooting'}
            durationSec={durationSec}
            makesPerSpot={makesPerSpot}
            onPickDuration={onPickDuration}
            onPickMakes={onPickMakes}
            onChangeMode={() => router.push('/modes')}
            timedDurations={TIMED_DURATIONS}
            spotTargets={SPOT_MAKE_TARGETS}
          />
        );
      case 'camera':
        return (
          <View>
            <CameraSectionBody
              orient={orient}
              onSetOrient={setOrient}
              cameraGranted={camera.hasPermission}
              canRequest={camera.canRequestPermission}
              onRequestPermission={() => void camera.requestPermission()}
              onOpenSystemSettings={() => void Linking.openSettings()}
              showMicNote={recordVideo && !mic.hasPermission}
            />
            {/* FT-seed ritual entry (ft-position) — one non-interactive tip
                row after the placement checklist. Lives here because the
                checklist body is a finished shared component. */}
            <Row style={styles.ftTipRow} gap={space.md}>
              <View style={styles.ftTipRail}>
                <View style={styles.ftTipBadge}>
                  <Ionicons name="checkmark" size={16} color={color.accent} />
                </View>
              </View>
              <View style={styles.ftTipBody}>
                <Text style={styles.ftTipText}>
                  Optional: shoot your first shot from the free-throw line — it
                  calibrates real distances.
                </Text>
              </View>
            </Row>
          </View>
        );
      case 'recording':
        return (
          <RecordingSectionBody
            recordVideo={recordVideo}
            keepMode={keepMode}
            onToggleRecord={(v) => set('recordVideo', v)}
            onSetKeepMode={(m) => set('keepMode', m)}
          />
        );
      case 'courtBall':
        return (
          <CourtBallSectionBody
            rimHeightM={rimHeightM}
            ballSize={ballSize}
            courtRange={courtRange}
            onSetRimHeight={(m) => set('rimHeightM', m)}
            onSetBallSize={(s) => set('ballSize', s)}
            onSetCourtRange={(r) => set('courtRange', r)}
          />
        );
      case 'calibration':
        // CalibrationSectionBody draws its own Card; the section renders
        // plainBody and owns the entrance, so no entering is passed here.
        return <CalibrationSectionBody onOpenGuide={() => router.push('/calibration-guide')} />;
    }
  };

  return (
    <View style={styles.root}>
      <ScrollView
        ref={scrollRef}
        scrollEventThrottle={16}
        onScroll={onScroll}
        contentContainerStyle={[
          // Screen-equivalent padding (ui.tsx Screen scroll) + clearance for
          // the absolute StickyStartBar (~96px) so the last card clears it.
          { paddingTop: insets.top, paddingBottom: insets.bottom + space.xxl + 96 },
          { paddingHorizontal: space.lg },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <Row style={styles.backRow}>
          <BackPill />
        </Row>

        <Animated.View entering={enter(0)}>
          <Eyebrow>New session</Eyebrow>
          <Text style={styles.title} accessibilityRole="header">
            Ready to shoot
          </Text>
          <Text style={styles.lede}>
            Start now, or open a section below to tweak the session first.
          </Text>
        </Animated.View>

        {/* Instant-start hero — GO CTA, summary chips, placement tips. Must
            stay a DIRECT child of the content container so its reported
            bottom edge shares the scroll offset's coordinate space. */}
        <StartHero
          entering={enter(1)}
          summary={summary}
          chips={chips}
          disabled={startDisabled}
          onStart={() => void openCamera()}
          onChipPress={onChipPress}
          onLayoutBottom={(y) => {
            heroBottomY.current = y;
          }}
        />

        <Animated.View entering={enter(2)} style={styles.optionsHeader}>
          <Eyebrow>Options</Eyebrow>
        </Animated.View>

        {SETUP_SECTION_ORDER.map((id, idx) => (
          <View
            key={id}
            onLayout={(e) => {
              sectionY.current[id] = e.nativeEvent.layout.y;
            }}
          >
            <CollapsibleSection
              title={SECTION_TITLES[id]}
              subtitle={sectionSubtitle(id)}
              expanded={expanded[id]}
              onToggle={() => setExpanded((e) => ({ ...e, [id]: !e[id] }))}
              entering={enter(3 + idx)}
              plainBody={id === 'calibration'}
            >
              {sectionBody(id)}
            </CollapsibleSection>
          </View>
        ))}
      </ScrollView>

      {/* Sticky fallback START — sibling of the ScrollView so it floats over
          the content; visibility owned here (hysteresis in onScroll). */}
      <StickyStartBar
        visible={stickyOn}
        disabled={startDisabled}
        summary={summary}
        onStart={() => void openCamera()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    // Same token ui.tsx styles.screen uses — this local ScrollView replicates
    // Screen's scroll chrome so the sticky bar can live outside it.
    backgroundColor: color.bg,
  },
  backRow: {
    marginBottom: space.md,
  },
  title: {
    ...type.title,
    color: color.text,
  },
  lede: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
    marginBottom: space.xl,
  },
  optionsHeader: {
    marginTop: space.xl,
    marginBottom: space.md,
  },
  // FT-seed tip row — mirrors SetupSections' checklist row styles (rail badge
  // + body text) so it reads as a fifth checklist item.
  ftTipRow: {
    alignItems: 'stretch',
    marginTop: space.lg,
  },
  ftTipRail: {
    width: 28,
    alignItems: 'center',
  },
  ftTipBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ftTipBody: {
    flex: 1,
  },
  ftTipText: {
    ...type.body,
    color: color.textDim,
    marginTop: 2,
  },
});
