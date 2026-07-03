/**
 * AppState guard — fires callbacks on active <-> background transitions so the
 * live session screen can pause the camera/recording cleanly when the user
 * backgrounds the app (incoming call, app switch, lock screen) and resume on
 * return.
 *
 * iOS passes through 'inactive' on the way to 'background'; any departure
 * from 'active' is treated as backgrounding (fired once per departure).
 * Handler errors are swallowed so a bad callback can never crash the app
 * during a state transition.
 */
import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

export function useAppStateGuard(handlers: {
  onBackground?: () => void;
  onForeground?: () => void;
}): void {
  // Keep the latest handlers without re-subscribing on every render.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let last: AppStateStatus = AppState.currentState;

    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      const wasActive = last === 'active';
      const isActive = next === 'active';
      last = next;
      if (wasActive && !isActive) {
        try {
          handlersRef.current.onBackground?.();
        } catch (err) {
          console.warn('[useAppStateGuard] onBackground handler failed', err);
        }
      } else if (!wasActive && isActive) {
        try {
          handlersRef.current.onForeground?.();
        } catch (err) {
          console.warn('[useAppStateGuard] onForeground handler failed', err);
        }
      }
    });

    return () => subscription.remove();
  }, []);
}
