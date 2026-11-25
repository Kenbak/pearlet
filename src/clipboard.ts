import { NativeModules } from 'react-native';

const native: {
  getString?: () => Promise<string>;
  setString?: (text: string) => Promise<void>;
} | undefined = NativeModules.LustreSecureClipboard;

/** The text on the clipboard, or an empty string. */
export async function getClipboardString(): Promise<string> {
  if (!native?.getString) throw new Error('Paste is not available in this build.');
  return native.getString();
}

/** An ordinary copy, for public values such as addresses. Secrets use `copySensitive`. */
export async function setClipboardString(text: string): Promise<void> {
  if (!native?.setString) throw new Error('Copy is not available in this build.');
  await native.setString(text);
}
