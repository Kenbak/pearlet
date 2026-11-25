import { createAsyncStorage } from '@react-native-async-storage/async-storage';
import { hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer/transaction.js';
import { Platform } from 'react-native';
import {
  ACCESSIBLE,
  ACCESS_CONTROL,
  SECURITY_LEVEL,
  STORAGE_TYPE,
  getAllGenericPasswordServices,
  getGenericPassword,
  hasGenericPassword,
  resetGenericPassword,
  setGenericPassword,
} from 'react-native-keychain';

import { authenticationReason, requireDeviceAuthentication } from './device-auth';
import { normalizeMnemonic, openPearlWallet, pearlAddressScriptHex, validatePearlAddress, validateWatchKey, watchKeyAddress } from './pearl-keys';
import { defaultPearlNetwork, type PearlNetwork } from './pearl-network';
import type { StoredPayment } from './testnet-wallet';
import { supportAddress } from './support';
import { isWalletService, mainWalletId, parseWalletList, reconcileWalletList, storedWalletIds, type WalletEntry } from './wallets-core';

export type WalletProfile = {
  address: string;
  scriptHex: string;
  miningAddress: string | null;
  miningScriptHex: string | null;
  backupVerified: boolean;
  /** Account public key for deriving fresh receive addresses; null for older profiles. */
  watchKey: string | null;
  /** Index of the receive address shown now: 0 (the first) or 2 and up (index 1 is mining). */
  receiveIndex: number;
  /** A wallet without a recovery phrase on this device. It can receive and watch, not send. */
  watchOnly: boolean;
};

export const maxReceiveIndex = 100_000;

type SecretReason = 'send' | 'reveal' | 'verify';
type ProfileFromPhrase = (phrase: string) => WalletProfile;

const legacyTestnetService = { service: 'lustre.testnet2.mnemonic.v1', cloudSync: false };
const journalStorage = {
  mainnet: createAsyncStorage('lustreMainnet'),
  testnet2: createAsyncStorage('lustreTestnet2'),
};
const settings = createAsyncStorage('lustreSettings');
const journalKey = 'pending.v1';
const selectedNetworkKey = 'network.v1';
const txidPattern = /^[0-9a-f]{64}$/;
const signedHexPattern = /^[0-9a-f]+$/;
const maxSignedHexLength = 800_000;
const android = Platform.OS === 'android';
const authBoundAndroidStorage = android && Number(Platform.Version) >= 30;
const androidAccessControl = ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE;
const androidSecretStorage = authBoundAndroidStorage ? STORAGE_TYPE.AES_GCM : STORAGE_TYPE.AES_GCM_NO_AUTH;
const profileQueue = { current: Promise.resolve() };
const journalQueues = {
  mainnet: { current: Promise.resolve() },
  testnet2: { current: Promise.resolve() },
};
let secretReadInProgress = false;

function serialize<T>(queue: { current: Promise<void> }, operation: () => Promise<T>): Promise<T> {
  const next = queue.current.then(operation);
  queue.current = next.then(() => {}, () => {});
  return next;
}

/** A wallet on one network. The first wallet ('main') keeps the original keychain names. */
export type WalletRef = { network: PearlNetwork; id: string };
export type WalletTarget = PearlNetwork | WalletRef;
export { mainWalletId };
const walletIdPattern = /^[a-z0-9]{1,24}$/;

export function walletRef(target: WalletTarget): WalletRef {
  const ref = typeof target === 'string' ? { network: target, id: mainWalletId } : target;
  if ((ref.network !== 'mainnet' && ref.network !== 'testnet2') || !walletIdPattern.test(ref.id)) {
    throw new Error('Unknown wallet.');
  }
  return ref;
}

function networkOf(target: WalletTarget): PearlNetwork {
  return walletRef(target).network;
}

function isMainWallet(target: WalletTarget): boolean {
  return walletRef(target).id === mainWalletId;
}

function slot(target: WalletTarget): string {
  const { network, id } = walletRef(target);
  return id === mainWalletId ? network : network + '.' + id;
}

function profileService(target: WalletTarget) {
  return { service: 'lustre.' + slot(target) + '.profile.v1', cloudSync: false };
}

function protectedService(target: WalletTarget) {
  return { service: 'lustre.' + slot(target) + '.protected-mnemonic.v1', cloudSync: false };
}

function journalKeyFor(target: WalletTarget): string {
  return isMainWallet(target) ? journalKey : journalKey + '.' + walletRef(target).id;
}

function walletLabel(network: PearlNetwork) {
  return network === 'mainnet' ? 'Lustre Mainnet' : 'Lustre Testnet2';
}

export async function readSelectedNetwork(): Promise<PearlNetwork> {
  const value = await settings.getItem(selectedNetworkKey);
  if (value === null) return defaultPearlNetwork;
  if (value === 'mainnet' || value === 'testnet2') return value;
  throw new Error('The saved wallet network could not be read.');
}

export function saveSelectedNetwork(network: PearlNetwork): Promise<void> {
  return settings.setItem(selectedNetworkKey, network);
}

export function hasLegacyTestnetWallet(): Promise<boolean> {
  return hasGenericPassword(legacyTestnetService);
}

export function hasProtectedWallet(target: WalletTarget): Promise<boolean> {
  const network = networkOf(target);
  return hasGenericPassword(protectedService(target));
}

function validateProfile(value: unknown, network: PearlNetwork): WalletProfile {
  if (!value || typeof value !== 'object') throw new Error('The saved wallet profile could not be read.');
  const profile = value as Partial<WalletProfile>;
  if (typeof profile.address !== 'string' || validatePearlAddress(profile.address, network) !== profile.address
    || profile.scriptHex !== pearlAddressScriptHex(profile.address, network)
    || typeof profile.backupVerified !== 'boolean') {
    throw new Error('The saved wallet profile could not be read.');
  }

  const miningAddress = profile.miningAddress;
  const watchOnly = profile.watchOnly === true;
  const watchKey = profile.watchKey ?? null;
  const receiveIndex = profile.receiveIndex ?? 0;
  if (watchKey !== null && (typeof watchKey !== 'string' || validateWatchKey(watchKey, network) !== watchKey
    || watchKeyAddress(watchKey, network, 0).address !== profile.address
    || (typeof miningAddress === 'string' && watchKeyAddress(watchKey, network, 1).address !== miningAddress))) {
    throw new Error('The saved watch key does not match this wallet.');
  }
  if (!Number.isInteger(receiveIndex) || receiveIndex < 0 || receiveIndex === 1 || receiveIndex > maxReceiveIndex
    || (receiveIndex > 0 && watchKey === null)) {
    throw new Error('The saved receive address could not be read.');
  }
  if (watchOnly && miningAddress === null && profile.miningScriptHex === null) {
    // A watched single address has no separate mining address.
  } else if (network === 'mainnet') {
    if (typeof miningAddress !== 'string' || validatePearlAddress(miningAddress, network) !== miningAddress
      || miningAddress === profile.address || profile.miningScriptHex !== pearlAddressScriptHex(miningAddress, network)) {
      throw new Error('The saved mining payout address could not be read.');
    }
  } else if (miningAddress !== null || profile.miningScriptHex !== null) {
    throw new Error('The saved Testnet2 wallet profile could not be read.');
  }

  return {
    address: profile.address,
    scriptHex: profile.scriptHex,
    miningAddress: profile.miningAddress as string | null,
    miningScriptHex: profile.miningScriptHex as string | null,
    backupVerified: profile.backupVerified,
    watchKey,
    receiveIndex,
    watchOnly,
  };
}

async function readProfileMetadata(target: WalletTarget): Promise<WalletProfile | null> {
  const network = networkOf(target);
  const credentials = await getGenericPassword(profileService(target));
  if (!credentials) return null;
  if (credentials.username !== walletLabel(network)) throw new Error('The saved wallet profile could not be read.');
  return validateProfile(JSON.parse(credentials.password), network);
}

async function writeProfileMetadata(target: WalletTarget, profile: WalletProfile): Promise<void> {
  const network = networkOf(target);
  const result = await setGenericPassword(walletLabel(network), JSON.stringify(validateProfile(profile, network)), {
    ...profileService(target),
    accessible: ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    securityLevel: SECURITY_LEVEL.SECURE_SOFTWARE,
    storage: android ? STORAGE_TYPE.AES_GCM_NO_AUTH : undefined,
  });
  if (!result) throw new Error('The wallet profile could not be saved.');
}

async function writeProtectedSecret(target: WalletTarget, phrase: string): Promise<void> {
  const network = networkOf(target);
  const result = await setGenericPassword(walletLabel(network), phrase, {
    ...protectedService(target),
    accessible: ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    securityLevel: SECURITY_LEVEL.SECURE_SOFTWARE,
    accessControl: !android ? ACCESS_CONTROL.USER_PRESENCE
      : authBoundAndroidStorage ? androidAccessControl : undefined,
    storage: android ? androidSecretStorage : undefined,
    authenticationPrompt: { title: authenticationReason('restore'), cancel: 'Cancel' },
  });
  if (!result || (android && result.storage !== androidSecretStorage) || !await hasProtectedWallet(target)) {
    throw new Error('The device could not save the protected recovery phrase.');
  }
}

export function readWalletProfile(target: WalletTarget): Promise<WalletProfile | null> {
  const network = networkOf(target);
  return serialize(profileQueue, async () => {
    // Prefer the authenticated migration route until the older keychain
    // duplicate is removed, even if a previous migration wrote its successor.
    if (network === 'testnet2' && isMainWallet(target) && await hasLegacyTestnetWallet()) return null;
    const profile = await readProfileMetadata(target);
    if (!profile) return null;
    if (profile.watchOnly) return await hasProtectedWallet(target) ? null : profile;
    if (!await hasProtectedWallet(target)) return null;
    return profile;
  });
}

/** Save a watch-only wallet. Refuses if this network already has a wallet. */
export function saveWatchOnlyProfile(target: WalletTarget, profile: WalletProfile): Promise<void> {
  const network = networkOf(target);
  return serialize(profileQueue, async () => {
    const candidate = validateProfile({ ...profile, watchOnly: true, backupVerified: true }, network);
    if (await readProfileMetadata(target) || await hasProtectedWallet(target)
      || (network === 'testnet2' && isMainWallet(target) && await hasLegacyTestnetWallet())) {
      throw new Error('A wallet already exists for this network.');
    }
    await writeProfileMetadata(target, candidate);
  });
}

/** Record the receive address now shown, and the watch key once known. */
export function saveReceiveState(
  target: WalletTarget,
  address: string,
  update: { watchKey?: string; receiveIndex?: number },
): Promise<WalletProfile> {
  const network = networkOf(target);
  return serialize(profileQueue, async () => {
    const profile = await readProfileMetadata(target);
    if (!profile || profile.address !== address) throw new Error('The active wallet changed. Try again.');
    const next = validateProfile({
      ...profile,
      watchKey: update.watchKey ?? profile.watchKey,
      receiveIndex: update.receiveIndex ?? profile.receiveIndex,
    }, network);
    await writeProfileMetadata(target, next);
    return next;
  });
}

export async function readRecoveryPhrase(target: WalletTarget, reason: SecretReason): Promise<string> {
  const network = networkOf(target);
  if (secretReadInProgress) throw new Error('Device authentication is already in progress.');
  secretReadInProgress = true;
  try {
    // Android Keystore's protected cipher has a short auth validity window.
    // Always show a fresh OS prompt before retrieval, even within that window.
    if (android) await requireDeviceAuthentication(reason);
    const credentials = await getGenericPassword({
      ...protectedService(target),
      accessControl: !android ? ACCESS_CONTROL.USER_PRESENCE
        : authBoundAndroidStorage ? androidAccessControl : undefined,
      authenticationPrompt: { title: authenticationReason(reason), cancel: 'Cancel' },
    });
    if (!credentials || credentials.username !== walletLabel(network)) {
      throw new Error('No protected recovery phrase is available for this wallet.');
    }
    if (android && credentials.storage !== STORAGE_TYPE.AES_GCM
      && credentials.storage !== STORAGE_TYPE.AES_GCM_NO_AUTH) {
      throw new Error('The saved recovery phrase is not protected by Android Keystore.');
    }
    const phrase = normalizeMnemonic(credentials.password);
    if (!phrase) throw new Error('The protected recovery phrase could not be read.');
    return phrase;
  } finally {
    secretReadInProgress = false;
  }
}

function ensureSameProfile(existing: WalletProfile | null, candidate: WalletProfile) {
  if (existing && (existing.address !== candidate.address || existing.miningAddress !== candidate.miningAddress)) {
    throw new Error('This recovery phrase belongs to a different wallet.');
  }
}

export function saveWalletProfile(target: WalletTarget, phrase: string, profile: WalletProfile): Promise<void> {
  const network = networkOf(target);
  return serialize(profileQueue, async () => {
    const mnemonic = normalizeMnemonic(phrase);
    if (!mnemonic) throw new Error('The recovery phrase is invalid.');
    const candidate = validateProfile(profile, network);
    const wallet = openPearlWallet(mnemonic, network);
    try {
      if (wallet.address() !== candidate.address
        || (candidate.miningAddress !== null && wallet.address(0, 1) !== candidate.miningAddress)) {
        throw new Error('The recovery phrase does not match the wallet profile.');
      }
    } finally {
      wallet.close();
    }
    ensureSameProfile(await readProfileMetadata(target), candidate);
    if (await hasProtectedWallet(target)
      || (network === 'testnet2' && isMainWallet(target) && await hasLegacyTestnetWallet())) {
      throw new Error('A wallet already exists for this network. Unlock it to recover its profile.');
    }
    // Do not publish an address until the protected phrase is in place.
    await writeProtectedSecret(target, mnemonic);
    await writeProfileMetadata(target, candidate);
  });
}

export function recoverWalletProfile(target: WalletTarget, deriveProfile: ProfileFromPhrase): Promise<WalletProfile> {
  const network = networkOf(target);
  return serialize(profileQueue, async () => {
    if (network === 'testnet2' && isMainWallet(target) && await hasLegacyTestnetWallet()) {
      throw new Error('Migrate the previous Testnet2 wallet to recover its profile.');
    }
    const phrase = await readRecoveryPhrase(target, 'verify');
    const candidate = validateProfile(deriveProfile(phrase), network);
    const existing = await readProfileMetadata(target);
    ensureSameProfile(existing, candidate);
    const profile = existing ? { ...existing, watchKey: existing.watchKey ?? candidate.watchKey } : { ...candidate, backupVerified: false };
    await writeProfileMetadata(target, profile);
    return profile;
  });
}

export function migrateLegacyTestnetWallet(deriveProfile: ProfileFromPhrase): Promise<WalletProfile> {
  return serialize(profileQueue, async () => {
    await requireDeviceAuthentication('migrate');
    const legacy = await getGenericPassword(legacyTestnetService);
    if (!legacy || legacy.username !== walletLabel('testnet2')) {
      throw new Error('The previous Testnet2 wallet could not be opened.');
    }
    const phrase = normalizeMnemonic(legacy.password);
    if (!phrase) throw new Error('The previous Testnet2 recovery phrase could not be read.');

    const candidate = validateProfile(deriveProfile(phrase), 'testnet2');
    const existing = await readProfileMetadata('testnet2');
    ensureSameProfile(existing, candidate);
    const profile = existing ? { ...existing, watchKey: existing.watchKey ?? candidate.watchKey } : { ...candidate, backupVerified: false };
    if (!await hasProtectedWallet('testnet2')) {
      await writeProtectedSecret('testnet2', phrase);
    }
    // This authenticated roundtrip also covers a migration interrupted before
    // metadata was written. The old phrase remains until the copy is readable.
    if (await readRecoveryPhrase('testnet2', 'verify') !== phrase) {
      throw new Error('The protected Testnet2 wallet differs from the original wallet.');
    }
    await writeProfileMetadata('testnet2', profile);
    if (!await resetGenericPassword(legacyTestnetService)) {
      throw new Error('The previous Testnet2 recovery record could not be removed. Try again.');
    }
    return profile;
  });
}

export function saveBackupVerified(target: WalletTarget, address: string): Promise<WalletProfile> {
  const network = networkOf(target);
  return serialize(profileQueue, async () => {
    const profile = await readProfileMetadata(target);
    if (!profile || profile.address !== address || !await hasProtectedWallet(target)) {
      throw new Error('The active wallet changed. Verify the backup again.');
    }
    const verified = { ...profile, backupVerified: true };
    await writeProfileMetadata(target, verified);
    return verified;
  });
}

/**
 * Delete this network's wallet from the device: the protected phrase first,
 * then its profile and transfer journal. Only for a verified backup with no
 * pending transfer, and only after device authentication.
 */
export function removeWalletFromDevice(target: WalletTarget, address: string): Promise<void> {
  const network = networkOf(target);
  return serialize(profileQueue, () => serialize(journalQueues[network], async () => {
    const profile = await readProfileMetadata(target);
    if (!profile || profile.address !== address) throw new Error('The active wallet changed. Try again.');
    if (!profile.backupVerified && !profile.watchOnly) throw new Error('Verify your recovery phrase before removing this wallet.');
    if (await journalStorage[network].getItem(journalKeyFor(target)) !== null) {
      throw new Error('Wait for the pending transfer to sync before removing this wallet.');
    }
    await requireDeviceAuthentication('remove');
    if (await hasProtectedWallet(target) && !await resetGenericPassword(protectedService(target))) {
      throw new Error('The recovery phrase could not be removed. Try again.');
    }
    if (!await resetGenericPassword(profileService(target))) {
      throw new Error('The wallet profile could not be removed. Try again.');
    }
    await journalStorage[network].removeItem(journalKeyFor(target));
  }));
}

function isPositiveGrainAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parsePendingPayment(raw: string, network: PearlNetwork): StoredPayment {
  try {
    const payment = JSON.parse(raw) as Partial<StoredPayment> | null;
    if (!payment || typeof payment.txid !== 'string' || !txidPattern.test(payment.txid)
      || typeof payment.address !== 'string' || validatePearlAddress(payment.address, network) !== payment.address
      || typeof payment.recipient !== 'string' || validatePearlAddress(payment.recipient, network) !== payment.recipient
      || !isPositiveGrainAmount(payment.amountGrains) || !isPositiveGrainAmount(payment.feeGrains)
      || typeof payment.hex !== 'string' || payment.hex.length % 2 !== 0
      || payment.hex.length > maxSignedHexLength || !signedHexPattern.test(payment.hex)
      || (payment.changeAddress !== undefined && (typeof payment.changeAddress !== 'string'
        || validatePearlAddress(payment.changeAddress, network) !== payment.changeAddress))
      || !Array.isArray(payment.inputIds) || !payment.inputIds.length
      || new Set(payment.inputIds).size !== payment.inputIds.length) {
      throw new Error();
    }

    if (payment.tipGrains !== undefined && (!isPositiveGrainAmount(payment.tipGrains) || network !== 'mainnet')) {
      throw new Error();
    }
    const tipOutputs = payment.tipGrains ? 1 : 0;
    const transaction = Transaction.fromRaw(hex.decode(payment.hex), { allowUnknownOutputs: true });
    if (transaction.id !== payment.txid || transaction.version !== 1
      || transaction.lockTime !== 0 || transaction.inputsLength !== payment.inputIds.length
      || transaction.outputsLength < 1 + tipOutputs || transaction.outputsLength > 2 + tipOutputs) {
      throw new Error();
    }

    const recipient = transaction.getOutput(0);
    if (recipient.amount !== BigInt(payment.amountGrains) || !recipient.script
      || hex.encode(recipient.script) !== pearlAddressScriptHex(payment.recipient, network)) {
      throw new Error();
    }
    if (payment.tipGrains) {
      const tip = transaction.getOutput(1);
      if (tip.amount !== BigInt(payment.tipGrains) || !tip.script
        || hex.encode(tip.script) !== pearlAddressScriptHex(supportAddress, network)) {
        throw new Error();
      }
    }
    if (transaction.outputsLength === 2 + tipOutputs) {
      const change = transaction.getOutput(1 + tipOutputs);
      if (!change.amount || !change.script
        || hex.encode(change.script) !== pearlAddressScriptHex(payment.changeAddress ?? payment.address, network)) {
        throw new Error();
      }
    }
    for (const [position, id] of payment.inputIds.entries()) {
      const input = transaction.getInput(position);
      if (!input.txid || id !== hex.encode(input.txid) + ':' + input.index
        || input.finalScriptWitness?.length !== 1 || input.finalScriptWitness[0].length !== 64) {
        throw new Error();
      }
    }

    return {
      txid: payment.txid,
      address: payment.address,
      recipient: payment.recipient,
      amountGrains: payment.amountGrains,
      feeGrains: payment.feeGrains,
      ...(payment.tipGrains ? { tipGrains: payment.tipGrains } : {}),
      ...(payment.changeAddress ? { changeAddress: payment.changeAddress } : {}),
      hex: payment.hex,
      inputIds: payment.inputIds,
    };
  } catch {
    throw new Error('The local transaction journal could not be read.');
  }
}

export function readPendingPayment(target: WalletTarget, address: string): Promise<StoredPayment | null> {
  const network = networkOf(target);
  return serialize(journalQueues[network], async () => {
    const storage = journalStorage[network];
    const raw = await storage.getItem(journalKeyFor(target));
    if (raw === null) return null;
    const payment = parsePendingPayment(raw, network);
    if (payment.address !== address) throw new Error('The local transaction journal belongs to another wallet.');
    return payment;
  });
}

export function savePendingPayment(target: WalletTarget, payment: StoredPayment): Promise<void> {
  const network = networkOf(target);
  return serialize(journalQueues[network], async () => {
    const storage = journalStorage[network];
    if (await storage.getItem(journalKeyFor(target)) !== null) {
      throw new Error('Wait for the saved transfer in this wallet to sync.');
    }
    // One committed value contains every piece needed to rebroadcast the exact
    // signed transaction. The submission path awaits this before the first relay.
    const raw = JSON.stringify(payment);
    parsePendingPayment(raw, network);
    await storage.setItem(journalKeyFor(target), raw);
  });
}

export function clearPendingPayment(target: WalletTarget, txid: string): Promise<void> {
  const network = networkOf(target);
  return serialize(journalQueues[network], async () => {
    const storage = journalStorage[network];
    const raw = await storage.getItem(journalKeyFor(target));
    if (raw === null || parsePendingPayment(raw, network).txid !== txid) {
      throw new Error('The local transaction journal changed.');
    }
    await storage.removeItem(journalKeyFor(target));
  });
}

const walletListKey = (network: PearlNetwork) => 'wallets.v1.' + network;
const activeWalletKey = (network: PearlNetwork) => 'activeWallet.v1.' + network;

/** Wallet keychain entries on this device. Lists names only; never prompts or reads a secret. */
async function walletServices(): Promise<string[]> {
  return (await getAllGenericPasswordServices({ skipUIAuth: true })).filter(isWalletService);
}

/**
 * The saved wallet list, plus any wallet found in the keychain that the list
 * does not name (after a reinstall, or when an earlier save failed).
 */
export async function readWalletList(network: PearlNetwork): Promise<WalletEntry[]> {
  const saved = parseWalletList(await settings.getItem(walletListKey(network)));
  const list = reconcileWalletList(saved, storedWalletIds(await walletServices(), network));
  if (list !== saved) await saveWalletList(network, list);
  return [...list];
}

export function saveWalletList(network: PearlNetwork, list: readonly WalletEntry[]): Promise<void> {
  return settings.setItem(walletListKey(network), JSON.stringify(list));
}

const installedKey = 'installed.v1';

/**
 * iOS keeps keychain entries when the app is deleted, while app storage is
 * removed. Wallets in the keychain with no install marker therefore come from
 * an earlier install (or from a build that predates the marker), and the user
 * decides whether to keep or erase them before any wallet opens.
 */
export async function hasWalletsFromEarlierInstall(): Promise<boolean> {
  if (await settings.getItem(installedKey) !== null) return false;
  if ((await walletServices()).length) return true;
  await settings.setItem(installedKey, '1');
  return false;
}

/** Keep the wallets found on the device, after device authentication. */
export async function keepWalletsFromEarlierInstall(): Promise<void> {
  await requireDeviceAuthentication('unlock');
  await settings.setItem(installedKey, '1');
}

/**
 * Erase every wallet on this device: recovery phrases first, then profiles,
 * then the saved lists and transfer journals. Only after device authentication.
 */
export function eraseAllWallets(): Promise<void> {
  return serialize(profileQueue, async () => {
    await requireDeviceAuthentication('erase');
    const services = await walletServices();
    const order = [...services].sort((left, right) => Number(left.includes('.profile.')) - Number(right.includes('.profile.')));
    for (const service of order) {
      await resetGenericPassword({ service, cloudSync: false });
    }
    // Entries that need authentication are not listed on iOS; remove them by name.
    for (const network of ['mainnet', 'testnet2'] as const) {
      for (const id of storedWalletIds(services, network)) {
        await resetGenericPassword(protectedService({ network, id }));
      }
      await resetGenericPassword(protectedService(network));
    }
    await resetGenericPassword(legacyTestnetService);
    if ((await walletServices()).length) throw new Error('Some wallets could not be erased. Try again.');
    await Promise.all([journalStorage.mainnet.clear(), journalStorage.testnet2.clear()]);
    for (const network of ['mainnet', 'testnet2'] as const) {
      await settings.removeItem(walletListKey(network));
      await settings.removeItem(activeWalletKey(network));
    }
    await settings.setItem(installedKey, '1');
  });
}

export async function readActiveWalletId(network: PearlNetwork): Promise<string | null> {
  return settings.getItem(activeWalletKey(network));
}

export function saveActiveWalletId(network: PearlNetwork, id: string): Promise<void> {
  return settings.setItem(activeWalletKey(network), id);
}
