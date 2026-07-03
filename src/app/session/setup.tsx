/**
 * Session setup — the pre-flight checklist before opening the camera.
 * No camera renders here; we only check permissions and session options.
 */
import React from 'react';
import { Linking, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
  useCameraPermission,
  useMicrophonePermission,
} from 'react-native-vision-camera';

import { Card, Chip, Eyebrow, PillButton, Row, Screen } from '../../components/ui';
import { color, radius, space, touch, type } from '../../constants/tokens';
import { getModeDef } from '../../core/gameModes';
import { useMode } from '../../state/modeStore';
import { useSession } from '../../state/sessionStore';
import { useSettings, type KeepMode } from '../../state/settingsStore';

const CHECKLIST = [
  {
    title: 'Rim fully visible',
    body: 'Frame the whole hoop — rim, net and a bit of backboard.',
  },
  {
    title: '15–30 ft side view',
    body: 'Place the phone 15–30 ft away, 30–60° off the backboard. Straight-on views hide makes.',
  },
  {
    title: 'Phone stable',
    body: 'Use a tripod, or lean the phone against a bag or bottle — portrait or landscape both work. A bumped camera pauses tracking.',
  },
  {
    title: 'Good light',
    body: 'Bright, even light keeps the ball easy to track. Dim gyms cut the frame rate.',
  },
] as const;

const KEEP_OPTIONS: { mode: KeepMode; label: string }[] = [
  { mode: 'makes', label: 'Makes only' },
  { mode: 'decided', label: 'Makes + misses' },
  { mode: 'all', label: 'Every shot' },
  { mode: 'none', label: 'No clips' },
];

export default function SessionSetupScreen() {
  const camera = useCameraPermission();
  const mic = useMicrophonePermission();
  const recordVideo = useSettings((s) => s.recordVideo);
  const keepMode = useSettings((s) => s.keepMode);
  const set = useSettings((s) => s.set);
  const beginSetup = useSession((s) => s.beginSetup);
  const activeMode = useMode((s) => s.activeMode);
  const modeDef = activeMode != null ? getModeDef(activeMode.modeId) : null;

  const openCamera = async () => {
    if (!camera.hasPermission && camera.canRequestPermission) {
      const granted = await camera.requestPermission();
      if (!granted) return;
    }
    if (recordVideo && !mic.hasPermission && mic.canRequestPermission) {
      // Best effort — recording works without game audio if declined.
      await mic.requestPermission();
    }
    beginSetup();
    router.push('/session/live');
  };

  return (
    <Screen scroll>
      <Eyebrow>New session</Eyebrow>
      <Text style={styles.title}>Get the hoop in frame</Text>
      <Text style={styles.lede}>
        One minute of setup keeps make/miss calls accurate all session.
      </Text>

      {/* Chosen game mode (or Free Play when none picked) */}
      <Card style={styles.card}>
        <Row style={styles.modeRow} gap={space.md}>
          <View style={styles.modeBadge}>
            <Text style={styles.modeEmoji}>{modeDef?.emoji ?? '🏀'}</Text>
          </View>
          <View style={styles.checkBody}>
            <Eyebrow>Game mode</Eyebrow>
            <Text style={styles.itemTitle}>{modeDef?.name ?? 'Free Play'}</Text>
            <Text style={styles.itemBody}>
              {modeDef?.tagline ?? 'Just shoot — every make counts.'}
            </Text>
          </View>
          <PillButton
            label={modeDef != null ? 'Change' : 'Choose'}
            variant="ghost"
            onPress={() => router.push('/modes')}
            style={styles.modeChange}
          />
        </Row>
      </Card>

      <Card style={styles.card}>
        {CHECKLIST.map((item, i) => (
          <Row key={item.title} style={[styles.checkRow, i > 0 && styles.checkRowGap]} gap={space.md}>
            <View style={styles.badge}>
              <Text style={styles.badgeNum}>{i + 1}</Text>
            </View>
            <View style={styles.checkBody}>
              <Text style={styles.itemTitle}>{item.title}</Text>
              <Text style={styles.itemBody}>{item.body}</Text>
            </View>
          </Row>
        ))}
      </Card>

      <Card style={styles.card}>
        <Row style={styles.optionRow} gap={space.md}>
          <View style={styles.checkBody}>
            <Text style={styles.itemTitle}>Record video</Text>
            <Text style={styles.itemBody}>Save the session so makes become replay clips.</Text>
          </View>
          <Switch
            value={recordVideo}
            onValueChange={(v) => set('recordVideo', v)}
            trackColor={{ false: color.surfaceRaised, true: color.accentTint }}
            thumbColor={recordVideo ? color.accent : color.textFaint}
            accessibilityLabel="Record video"
          />
        </Row>
        {recordVideo && (
          <View style={styles.keepBlock}>
            <Eyebrow>Keep clips</Eyebrow>
            <View style={styles.keepWrap}>
              {KEEP_OPTIONS.map((opt) => {
                const selected = keepMode === opt.mode;
                return (
                  <Pressable
                    key={opt.mode}
                    accessibilityRole="button"
                    accessibilityLabel={`Keep clips: ${opt.label}`}
                    accessibilityState={{ selected }}
                    onPress={() => set('keepMode', opt.mode)}
                    style={({ pressed }) => [
                      styles.keepChip,
                      selected && styles.keepChipSelected,
                      pressed && styles.keepChipPressed,
                    ]}
                  >
                    <Text style={[styles.keepChipLabel, selected && styles.keepChipLabelSelected]}>
                      {opt.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}
      </Card>

      <Card style={styles.card}>
        <Row style={styles.optionRow} gap={space.md}>
          <View style={styles.checkBody}>
            <Text style={styles.itemTitle}>Camera access</Text>
            <Text style={styles.itemBody}>
              {camera.hasPermission
                ? 'Granted — the live view is ready to go.'
                : camera.canRequestPermission
                  ? 'Needed to watch the rim and track shots. Nothing is uploaded.'
                  : 'Camera access is off. Turn it on in system settings to track shots.'}
            </Text>
          </View>
          {camera.hasPermission && <Chip label="Ready" tone="make" />}
        </Row>
        {!camera.hasPermission && (
          <PillButton
            label={camera.canRequestPermission ? 'Allow camera access' : 'Open settings'}
            variant="ghost"
            style={styles.permissionButton}
            onPress={() => {
              if (camera.canRequestPermission) void camera.requestPermission();
              else void Linking.openSettings();
            }}
          />
        )}
        {recordVideo && !mic.hasPermission && (
          <Text style={styles.micNote}>
            The microphone is only used for game audio in recordings.
          </Text>
        )}
      </Card>

      <PillButton
        label="Open camera"
        onPress={() => void openCamera()}
        disabled={!camera.hasPermission && !camera.canRequestPermission}
        style={styles.cta}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
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
  card: {
    marginBottom: space.lg,
  },
  modeRow: {
    alignItems: 'center',
  },
  modeBadge: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeEmoji: {
    fontSize: 24,
  },
  modeChange: {
    paddingHorizontal: space.lg,
  },
  checkRow: {
    alignItems: 'flex-start',
  },
  checkRowGap: {
    marginTop: space.lg,
  },
  badge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeNum: {
    ...type.heading,
    color: color.accent,
  },
  checkBody: {
    flex: 1,
  },
  itemTitle: {
    ...type.heading,
    color: color.text,
  },
  itemBody: {
    ...type.body,
    color: color.textDim,
    marginTop: 2,
  },
  optionRow: {
    alignItems: 'center',
  },
  keepBlock: {
    marginTop: space.lg,
  },
  keepWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  keepChip: {
    minHeight: touch.minTarget,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
  },
  keepChipSelected: {
    borderColor: color.accent,
    backgroundColor: color.accentTint,
  },
  keepChipPressed: {
    backgroundColor: color.surfaceRaised,
  },
  keepChipLabel: {
    ...type.bodyMedium,
    color: color.textDim,
  },
  keepChipLabelSelected: {
    color: color.accent,
  },
  permissionButton: {
    marginTop: space.md,
  },
  micNote: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.md,
  },
  cta: {
    marginTop: space.sm,
    marginBottom: space.xl,
  },
});
