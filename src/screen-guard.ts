import { useEffect, useState } from 'react';
import { NativeModules, Platform } from 'react-native';

const native: {
  setSecure?: (secure: boolean) => Promise<void>;
  isCaptured?: () => Promise<boolean>;
} | undefined = NativeModules.LustreScreenGuard;

let holders = 0;

function setSecure(secure: boolean) {
  void native?.setSecure?.(secure).catch(() => {});
}

/**
 * Guard a screen that shows or takes a recovery phrase. While mounted, Android
 * blocks screenshots, recording and the recents preview. iOS cannot block
 * them, so this returns true while the screen is recorded or mirrored and the
 * caller hides the phrase.
 */
export function useScreenGuard(): boolean {
  const [captured, setCaptured] = useState(false);

  useEffect(() => {
    let alive = true;
    holders += 1;
    if (holders === 1) setSecure(true);
    const check = () => {
      void native?.isCaptured?.().then((value) => {
        if (alive) setCaptured(value === true);
      }).catch(() => {});
    };
    check();
    const timer = Platform.OS === 'ios' ? setInterval(check, 1000) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      holders -= 1;
      if (holders === 0) setSecure(false);
    };
  }, []);

  return captured;
}

export const captureNotice = 'Stop screen recording or mirroring to continue.';
