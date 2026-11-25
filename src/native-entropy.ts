import { base64 } from '@scure/base';
import { NativeModules } from 'react-native';

const native: { randomBase64?: (byteLength: number) => Promise<string> } | undefined = NativeModules.LustreEntropy;

export async function getRandomBytesAsync(length: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(length) || length < 1 || length > 65_536) {
    throw new Error('Invalid entropy length.');
  }

  // The operating system's generator, through this app's own module. There is
  // no JavaScript fallback: without the module, nothing is generated.
  if (!native?.randomBase64) throw new Error('Secure randomness is unavailable in this build.');
  const bytes = base64.decode(await native.randomBase64(length));
  if (bytes.length !== length) {
    bytes.fill(0);
    throw new Error('The device returned incomplete secure randomness.');
  }
  return bytes;
}
