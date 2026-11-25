import { createAsyncStorage } from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { setHapticsEnabled } from './motion';
import { defaultPreferences, parsePreferences, type Preferences } from './preferences-core';

export { defaultPreferences, type Preferences } from './preferences-core';

const storage = createAsyncStorage('lustreSettings');
const preferencesKey = 'preferences.v1';

type PreferencesContext = {
  preferences: Preferences;
  loaded: boolean;
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
};

const Context = createContext<PreferencesContext>({
  preferences: defaultPreferences,
  loaded: false,
  setPreference: () => {},
});

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void storage.getItem(preferencesKey).then((raw) => {
      if (!alive) return;
      const next = parsePreferences(raw);
      setHapticsEnabled(next.haptics);
      setPreferences(next);
      setLoaded(true);
    }).catch(() => {
      if (alive) setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const setPreference = useCallback(<K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    setPreferences((current) => {
      const next = { ...current, [key]: value };
      if (key === 'haptics') setHapticsEnabled(Boolean(value));
      void storage.setItem(preferencesKey, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const value = useMemo(() => ({ preferences, loaded, setPreference }), [preferences, loaded, setPreference]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function usePreferences() {
  return useContext(Context);
}
