import { NativeModules } from 'react-native';

const native: { version?: string; build?: string; getConstants?: () => { version?: string; build?: string } } | undefined =
  NativeModules.LustreAppInfo;

/** The installed app's version and build, or empty strings on builds without the module. */
export function appVersion(): { version: string; build: string } {
  const constants = native?.getConstants?.() ?? native ?? {};
  return { version: constants.version ?? '', build: constants.build ?? '' };
}

export const sourceCodeUrl = 'https://github.com/Kenbak/pearlet';

export const privacyPolicyUrl = 'https://pearlet.io/privacy';
