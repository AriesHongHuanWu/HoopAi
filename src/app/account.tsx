/**
 * Account — sign in, or deliberately don't.
 *
 * This screen exists to make the cloud OPTIONAL and to say so out loud. Four
 * states, each with one obvious next action and none of them an error:
 *
 *   'unconfigured' — this build ships no Firebase project. The screen says the
 *       app is local-only and offers the privacy page. No form, no retry, no
 *       red. This is the state the hackathon demo runs in.
 *   'signed-out'  — sign in / create an account, or keep going as a guest.
 *   'guest'       — anonymous account: everything works, and the one offer is
 *       to turn it into a real account WITHOUT losing the history (the store
 *       links the credential onto the same uid).
 *   'account'     — email, last backup, back up now, sign out.
 *
 * THE PROMISE, printed on the screen because it is the product: only numbers
 * and labels leave the phone. That is not a claim the copy makes on trust —
 * data/firebaseRecords.ts builds every uploaded document from a field
 * whitelist and refuses to write anything else.
 *
 * Nothing here blocks. Every action is a tap, every failure lands as one line
 * of guidance in `notice`, and the screen is readable and dismissible while a
 * request is in flight.
 */
import { router } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { useCardStagger } from '@/components/motion';
import { ScreenHeader } from '@/components/ScreenHeader';
import { SegmentedTabs } from '@/components/SegmentedTabs';
import { BackPill } from '@/components/ShotList';
import { Card, PillButton, Row, Screen } from '@/components/ui';
import { color, layout, radius, space, touch, type } from '@/constants/tokens';
import { useAuth } from '@/state/authStore';

/** Which half of the signed-out form is showing. */
type Mode = 'in' | 'up';

const MODES = [
  { value: 'in' as Mode, label: 'Sign in' },
  { value: 'up' as Mode, label: 'Create account' },
];

/** "2 minutes ago" is over-engineering here — a date and time is the receipt. */
function formatSyncTime(at: number): string {
  const d = new Date(at);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return `today ${time}`;
  return `${d.getDate()}/${d.getMonth() + 1} ${time}`;
}

/** The one line that never changes, in any state. */
function PrivacyLine() {
  return (
    <Text style={styles.fine}>
      Only numbers and labels are backed up — scores, angles, times. Video, frames and images never
      leave this phone.
    </Text>
  );
}

export default function AccountScreen() {
  const status = useAuth((s) => s.status);
  const email = useAuth((s) => s.email);
  const busy = useAuth((s) => s.busy);
  const notice = useAuth((s) => s.notice);
  const syncing = useAuth((s) => s.syncing);
  const lastSyncAt = useAuth((s) => s.lastSyncAt);
  const lastSyncNote = useAuth((s) => s.lastSyncNote);

  const [mode, setMode] = useState<Mode>('in');
  const [emailField, setEmailField] = useState('');
  const [password, setPassword] = useState('');
  const enter = useCardStagger();

  const signedIn = status === 'account' || status === 'guest';

  const submit = () => {
    if (status === 'guest' || mode === 'up') {
      void useAuth.getState().signUp(emailField, password);
      return;
    }
    void useAuth.getState().signIn(emailField, password);
  };

  return (
    <Screen scroll>
      <BackPill />
      <ScreenHeader
        eyebrow="Backup"
        title="Account"
        lede={
          status === 'unconfigured'
            ? 'This build keeps everything on the phone.'
            : 'Keep your history when you change phones.'
        }
        style={styles.header}
      />

      <View style={styles.stack}>
        {/* ---- NO FIREBASE IN THIS BUILD ------------------------------- */}
        {status === 'unconfigured' && (
          <Card entering={enter(0)}>
            <Text style={styles.cardHeading}>Local only</Text>
            <Text style={styles.body}>
              Cloud backup is switched off in this build, so there is nothing to sign in to. Every
              session, shot and stat lives in this app on this phone, and the whole app works
              exactly as it does now.
            </Text>
            <PillButton
              variant="ghost"
              label="How your data is handled"
              icon="lock-closed-outline"
              onPress={() => router.push('/legal/privacy')}
              style={styles.action}
            />
            <PrivacyLine />
          </Card>
        )}

        {status === 'starting' && (
          <Card entering={enter(0)}>
            <Text style={styles.body}>Checking your account…</Text>
          </Card>
        )}

        {/* ---- SIGNED IN ----------------------------------------------- */}
        {signedIn && (
          <Card entering={enter(0)}>
            <Text style={styles.cardHeading}>
              {status === 'guest' ? 'Playing as a guest' : 'Signed in'}
            </Text>
            <Text style={styles.body}>
              {status === 'guest'
                ? 'Your history is backed up to a guest account on this phone only. Add an email and it becomes yours on any phone — nothing you have already recorded is lost.'
                : (email ?? 'Your account')}
            </Text>
            {lastSyncAt != null && (
              <Text style={styles.meta}>Last backup {formatSyncTime(lastSyncAt)}</Text>
            )}
            {lastSyncNote != null && <Text style={styles.meta}>{lastSyncNote}</Text>}
            <Row gap={space.sm} style={styles.action}>
              <PillButton
                label={syncing ? 'Backing up…' : 'Back up now'}
                icon="cloud-upload-outline"
                onPress={() => {
                  void useAuth.getState().syncNow();
                }}
                disabled={syncing}
                style={styles.grow}
              />
            </Row>
            <PrivacyLine />
          </Card>
        )}

        {/* ---- THE FORM ------------------------------------------------ */}
        {(status === 'signed-out' || status === 'guest') && (
          <Card entering={enter(1)}>
            <Text style={styles.cardHeading}>
              {status === 'guest' ? 'Save my history to an account' : 'Email and password'}
            </Text>
            {status === 'signed-out' && (
              <SegmentedTabs
                segments={MODES}
                value={mode}
                onChange={(next) => {
                  setMode(next);
                  useAuth.getState().clearNotice();
                }}
                accessibilityLabel="Sign in or create an account"
                style={styles.tabs}
              />
            )}
            <Text style={styles.label}>Email</Text>
            <TextInput
              accessibilityLabel="Email address"
              value={emailField}
              onChangeText={setEmailField}
              placeholder="you@example.com"
              placeholderTextColor={color.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              style={styles.input}
            />
            <Text style={styles.label}>Password</Text>
            <TextInput
              accessibilityLabel="Password"
              value={password}
              onChangeText={setPassword}
              placeholder="At least 6 characters"
              placeholderTextColor={color.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              textContentType="password"
              style={styles.input}
            />
            <PillButton
              label={
                busy
                  ? 'Working…'
                  : status === 'guest'
                    ? 'Save my history'
                    : mode === 'in'
                      ? 'Sign in'
                      : 'Create account'
              }
              icon={status === 'guest' ? 'shield-checkmark-outline' : 'log-in-outline'}
              onPress={submit}
              disabled={busy}
              style={styles.action}
            />
            {status === 'signed-out' && mode === 'in' && (
              <PillButton
                variant="ghost"
                label="Email me a reset link"
                onPress={() => {
                  void useAuth.getState().resetPassword(emailField);
                }}
                disabled={busy}
                style={styles.action}
              />
            )}
            {notice != null && <Text style={styles.notice}>{notice}</Text>}
          </Card>
        )}

        {/* ---- NO ACCOUNT AT ALL --------------------------------------- */}
        {status === 'signed-out' && (
          <Card entering={enter(2)}>
            <Text style={styles.cardHeading}>Or keep going without one</Text>
            <Text style={styles.body}>
              Shoot now, decide later. A guest account backs up your numbers straight away, and you
              can put an email on it any time without losing a session.
            </Text>
            <PillButton
              variant="ghost"
              label={busy ? 'Working…' : 'Keep going as a guest'}
              icon="basketball-outline"
              onPress={() => {
                void useAuth.getState().continueAsGuest();
              }}
              disabled={busy}
              style={styles.action}
            />
            <PrivacyLine />
          </Card>
        )}

        {/* ---- LEAVING ------------------------------------------------- */}
        {signedIn && (
          <Card entering={enter(2)}>
            <Text style={styles.cardHeading}>Sign out</Text>
            <Text style={styles.body}>
              Your sessions stay on this phone. Sign back in on any phone to bring them together.
            </Text>
            <PillButton
              variant="ghost"
              label="Sign out"
              icon="log-out-outline"
              onPress={() => {
                void useAuth.getState().signOutNow();
              }}
              disabled={busy}
              style={styles.action}
            />
          </Card>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    marginBottom: layout.sectionGap,
  },
  stack: {
    gap: layout.sectionGap,
  },
  cardHeading: {
    ...type.headingLarge,
    color: color.text,
    marginBottom: space.xs,
  },
  body: {
    ...type.body,
    color: color.textDim,
  },
  meta: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.sm,
  },
  fine: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.md,
  },
  label: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.md,
    marginBottom: space.xs,
  },
  input: {
    ...type.body,
    color: color.text,
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    minHeight: touch.minTarget,
  },
  tabs: {
    marginTop: space.md,
  },
  action: {
    marginTop: space.lg,
  },
  grow: {
    flex: 1,
  },
  notice: {
    ...type.body,
    color: color.unsure,
    marginTop: space.md,
  },
});
