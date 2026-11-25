import { TurboModuleRegistry, type TurboModule } from 'react-native';

interface DeviceAuthenticationModule extends TurboModule {
  authenticate(reason: string): Promise<void>;
}

const reasons = {
  send: 'Authorize this Pearl transfer.',
  reveal: 'Unlock your recovery phrase.',
  verify: 'Unlock your wallet to verify its recovery phrase.',
  retry: 'Authorize broadcasting this signed Pearl transfer again.',
  migrate: 'Unlock your existing Testnet2 wallet to protect its recovery phrase.',
  create: 'Authenticate before creating your Pearl wallet.',
  restore: 'Authenticate before restoring your Pearl wallet.',
  unlock: 'Unlock Pearlet.',
  remove: 'Remove this Pearl wallet from this device.',
  erase: 'Erase every Pearl wallet on this device.',
};

export type DeviceAuthenticationReason = keyof typeof reasons;

export function authenticationReason(reason: DeviceAuthenticationReason): string {
  return reasons[reason];
}

export async function requireDeviceAuthentication(reason: DeviceAuthenticationReason): Promise<void> {
  const device = TurboModuleRegistry.get<DeviceAuthenticationModule>('LustreDeviceAuth');
  if (!device) throw new Error('Device authentication is unavailable in this build.');
  await device.authenticate(authenticationReason(reason));
}
