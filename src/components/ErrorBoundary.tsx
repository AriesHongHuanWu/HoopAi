/**
 * App-level error boundary.
 *
 * Catches render/lifecycle crashes anywhere below it and swaps in a branded
 * recovery screen (coal background, broadcast type) instead of a white screen
 * or a hard native crash. "Restart" clears the error and remounts the whole
 * subtree via a fresh key, so transient render bugs recover in place.
 *
 * Deliberately dependency-light: no safe-area hooks, no Skia, no animation —
 * the fallback must render even when most of the app is broken.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { color, space, type } from '../constants/tokens';
import { PillButton } from './ui';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** Bumped on each restart; used as a key to force-remount the children. */
  attempt: number;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary] Uncaught render error', error, info.componentStack ?? '');
  }

  private handleRestart = (): void => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render(): React.ReactNode {
    const { error, attempt } = this.state;
    if (error) {
      const message =
        typeof error.message === 'string' && error.message.length > 0
          ? error.message
          : String(error);
      return (
        <View
          style={styles.root}
          accessibilityRole="alert"
          accessibilityLabel="Something went wrong. The app hit an unexpected error."
        >
          <Text
            style={styles.mark}
            importantForAccessibility="no"
            accessibilityElementsHidden
          >
            🏀
          </Text>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.message} numberOfLines={5}>
            {message}
          </Text>
          <PillButton label="Restart" onPress={this.handleRestart} style={styles.button} />
        </View>
      );
    }
    // Key forces a clean remount of the entire subtree after a restart.
    return <React.Fragment key={attempt}>{this.props.children}</React.Fragment>;
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.bg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  mark: {
    fontSize: 56,
    lineHeight: 68,
    marginBottom: space.lg,
  },
  title: {
    ...type.title,
    color: color.text,
    textAlign: 'center',
  },
  message: {
    ...type.caption,
    color: color.textFaint,
    textAlign: 'center',
    marginTop: space.sm,
    maxWidth: 320,
  },
  button: {
    marginTop: space.xl,
    minWidth: 180,
  },
});
