import { NativeModules, Platform } from 'react-native';

const native: { copySensitive?: (text: string, seconds: number) => Promise<void> } | undefined =
  NativeModules.LustreSecureClipboard;

export const sensitiveClipboardSeconds = 60;

/**
 * Android before 13 shows copied text in previews and keyboards may keep it in
 * their clipboard history, which the timed clear cannot reach. A recovery
 * phrase is not offered for copying there.
 */
export const canCopyRecoveryPhrase = Platform.OS !== 'android' || Number(Platform.Version) >= 33;

/**
 * Copy a secret for this device only, cleared after a minute. Throws when the
 * native module is missing rather than falling back to an ordinary copy.
 */
export async function copySensitive(text: string): Promise<void> {
  if (!native?.copySensitive) throw new Error('Secure copy is not available in this build.');
  await native.copySensitive(text, sensitiveClipboardSeconds);
}
