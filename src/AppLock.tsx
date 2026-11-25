import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Modal, StyleSheet, Text, View } from 'react-native';

import { requireDeviceAuthentication } from './device-auth';
import { PearlLoader, PressScale, haptic } from './motion';
import { PearlBackdrop, PearlButtonFill, palette } from './PearlDesign';
import { usePreferences } from './preferences';
import { shouldRelock } from './preferences-core';

/**
 * Covers Pearlet with a pearl lock screen until device authentication succeeds,
 * at launch and after returning from the background, when App lock is on.
 */
export default function AppLock({ children }: { children: ReactNode }) {
  const { preferences, loaded } = usePreferences();
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const decidedInitial = useRef(false);
  const backgroundedAt = useRef<number | null>(null);
  const enabled = useRef(preferences.appLock);
  enabled.current = preferences.appLock;

  useEffect(() => {
    if (!loaded || decidedInitial.current) return;
    decidedInitial.current = true;
    setLocked(preferences.appLock);
  }, [loaded, preferences.appLock]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        backgroundedAt.current = Date.now();
      } else if (state === 'active') {
        if (shouldRelock(enabled.current, backgroundedAt.current, Date.now())) setLocked(true);
        backgroundedAt.current = null;
      }
    });
    return () => subscription.remove();
  }, []);

  async function unlock() {
    if (unlocking) return;
    setUnlocking(true);
    setError('');
    try {
      await requireDeviceAuthentication('unlock');
      haptic('success');
      setLocked(false);
    } catch (failure) {
      haptic('error');
      setError(failure instanceof Error ? failure.message : 'Could not unlock Pearlet.');
    } finally {
      setUnlocking(false);
    }
  }

  useEffect(() => {
    if (locked && AppState.currentState === 'active') void unlock();
    // Prompt once each time the lock appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  if (!loaded) {
    return (
      <View style={styles.cover}>
        <PearlLoader />
      </View>
    );
  }

  return (
    <>
      {children}
      <Modal visible={locked} animationType="fade" presentationStyle="fullScreen" onRequestClose={() => {}}>
        <View style={styles.lock} accessibilityViewIsModal>
          <PearlBackdrop />
          <PearlLoader label="Pearlet is locked" />
          <Text style={styles.title}>Pearlet is locked</Text>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <PressScale
            accessibilityRole="button"
            accessibilityLabel="Unlock Pearlet"
            disabled={unlocking}
            onPress={() => void unlock()}
            feedback="medium"
            style={styles.button}
          >
            <PearlButtonFill variant="primary" />
            <Text style={styles.buttonText}>{unlocking ? 'Unlocking…' : 'Unlock'}</Text>
          </PressScale>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  cover: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  lock: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18, paddingHorizontal: 32 },
  title: { color: palette.ink, fontSize: 20, fontWeight: '600', letterSpacing: -0.3, marginTop: -12 },
  error: { color: palette.danger, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  button: {
    minWidth: 200,
    height: 54,
    borderRadius: 27,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: palette.glassBorder,
    boxShadow: '0 8px 24px rgba(40, 28, 66, 0.12)',
  },
  buttonText: { color: palette.ink, fontSize: 16, fontWeight: '600' },
});
