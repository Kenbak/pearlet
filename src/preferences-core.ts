export type Preferences = {
  /** Ask for Face ID or the passcode when returning to Pearlet. */
  appLock: boolean;
  /** Mask the balance and activity amounts. */
  hideBalance: boolean;
  /** Show the Mainnet mining payout address in Receive. */
  showMiningPayouts: boolean;
  /** Play haptic feedback. */
  haptics: boolean;
  /** Add the optional 0.5% Pearlet tip to Mainnet sends (off unless the user turns it on). */
  supportTip: boolean;
};

export const defaultPreferences: Preferences = Object.freeze({
  appLock: false,
  hideBalance: false,
  showMiningPayouts: true,
  haptics: true,
  supportTip: false,
});

/** Keep only known boolean fields so a corrupt or older value falls back safely. */
export function parsePreferences(raw: string | null): Preferences {
  if (!raw) return { ...defaultPreferences };
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof Preferences, unknown>> | null;
    const next = { ...defaultPreferences };
    for (const key of Object.keys(defaultPreferences) as (keyof Preferences)[]) {
      if (typeof value?.[key] === 'boolean') next[key] = value[key] as boolean;
    }
    return next;
  } catch {
    return { ...defaultPreferences };
  }
}

/** Lock again only after this long in the background, so quick app switches and system prompts don't re-lock. */
export const relockAfterMs = 30_000;

/** Whether returning to the app should lock it. */
export function shouldRelock(enabled: boolean, backgroundedAt: number | null, now: number): boolean {
  return enabled && backgroundedAt !== null && now - backgroundedAt >= relockAfterMs;
}
