/**
 * History — list of past sessions as cards: date, attempts/makes/FG% and a
 * mini pip row of the actual shot sequence. Tapping a card opens the full
 * session detail at /history/[id].
 */
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  BackPill,
  PipRow,
  formatSessionDate,
  formatSessionTime,
} from '@/components/ShotList';
import {
  Card,
  Eyebrow,
  PillButton,
  Row,
  Screen,
  StatNumber,
} from '@/components/ui';
import { color, space, type } from '@/constants/tokens';
import type { ShotOutcome } from '@/core/types';
import { listSessions, sessionShots, type SessionSummaryRow } from '@/data/db';

interface HistoryItem {
  row: SessionSummaryRow;
  /** Shot outcome sequence for the mini pip row. */
  pips: ShotOutcome[];
}

export default function HistoryScreen() {
  const [items, setItems] = useState<HistoryItem[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void (async () => {
        const rows = await listSessions(30);
        const pips = await Promise.all(
          rows.map((r) =>
            sessionShots(r.id).then((shots) => shots.map((s) => s.outcome)),
          ),
        );
        if (!alive) return;
        setItems(rows.map((row, i) => ({ row, pips: pips[i] ?? [] })));
      })();
      return () => {
        alive = false;
      };
    }, []),
  );

  return (
    <Screen scroll>
      <Row style={{ marginBottom: space.lg }}>
        <BackPill />
      </Row>
      <Eyebrow>Your sessions</Eyebrow>
      <Text style={styles.title}>History</Text>

      {items === null ? (
        <Text style={styles.dim}>Loading sessions…</Text>
      ) : items.length === 0 ? (
        <Card>
          <Text style={styles.heading}>No sessions yet</Text>
          <Text style={[styles.dim, { marginTop: space.xs }]}>
            Finish your first tracked session and it will show up here with
            makes, misses and shot angles.
          </Text>
          <PillButton
            label="Start a session"
            onPress={() => router.replace('/')}
            style={{ marginTop: space.lg }}
          />
        </Card>
      ) : (
        <View style={{ gap: space.md }}>
          {items.map(({ row, pips }) => {
            const makes = row.makes ?? 0;
            const fg = Math.round(row.fgPct * 100);
            return (
              <Card
                key={row.id}
                onPress={() =>
                  router.push({
                    pathname: '/history/[id]',
                    params: { id: String(row.id) },
                  })
                }
              >
                <Row style={{ justifyContent: 'space-between' }}>
                  <View>
                    <Text style={styles.heading}>
                      {formatSessionDate(row.startedAt)}
                    </Text>
                    <Text style={styles.caption}>
                      {formatSessionTime(row.startedAt)}
                    </Text>
                  </View>
                  <StatNumber value={`${fg}%`} size="medium" label="FG" />
                </Row>
                <Text style={[styles.caption, { marginTop: space.sm }]}>
                  {row.attempts} {row.attempts === 1 ? 'shot' : 'shots'} ·{' '}
                  {makes} {makes === 1 ? 'make' : 'makes'}
                </Text>
                {pips.length > 0 && (
                  <PipRow
                    outcomes={pips}
                    size={10}
                    max={24}
                    style={{ marginTop: space.sm }}
                  />
                )}
              </Card>
            );
          })}
        </View>
      )}

      {items !== null && items.length > 0 && (
        <PillButton
          variant="ghost"
          label="View trends"
          onPress={() => router.push('/trends')}
          style={{ marginTop: space.xl, alignSelf: 'center' }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    ...type.title,
    color: color.text,
    marginBottom: space.lg,
  },
  heading: {
    ...type.heading,
    color: color.text,
  },
  caption: {
    ...type.caption,
    color: color.textFaint,
  },
  dim: {
    ...type.body,
    color: color.textDim,
  },
});
