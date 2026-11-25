import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, beforeEach, test } from 'node:test';

import { createMnemonic, openPearlWallet } from '../src/pearl-keys.ts';

const sourceDirectory = new URL('../src/', import.meta.url).href;
const fixture = {
  platform: { OS: 'android', Version: 37 },
  credentials: new Map(),
  databases: new Map(),
  secretReads: [],
  authorize: true,
  allowSecretReads: true,
  failMetadataWrite: false,
  hideProtected: false,
};
globalThis.lustreWalletStorageFixture = fixture;

const mocks = {
  'react-native': `
    const fixture = globalThis.lustreWalletStorageFixture;
    export const Platform = fixture.platform;
    export const TurboModuleRegistry = {
      get(name) {
        if (name !== 'LustreDeviceAuth') return null;
        return {
          async authenticate() {
            if (!fixture.authorize) throw new Error('Device authentication canceled.');
          }
        };
      }
    };
  `,
  '@react-native-async-storage/async-storage': `
    const { databases } = globalThis.lustreWalletStorageFixture;
    export function createAsyncStorage(name) {
      if (!databases.has(name)) databases.set(name, new Map());
      const items = databases.get(name);
      return {
        async getItem(key) { return items.get(key) ?? null; },
        async setItem(key, value) { items.set(key, value); },
        async removeItem(key) { items.delete(key); },
        async clear() { items.clear(); }
      };
    }
  `,
  'react-native-keychain': `
    const fixture = globalThis.lustreWalletStorageFixture;
    export const ACCESSIBLE = { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only' };
    export const ACCESS_CONTROL = { USER_PRESENCE: 'presence', BIOMETRY_ANY_OR_DEVICE_PASSCODE: 'both' };
    export const STORAGE_TYPE = { AES_GCM: 'AES-GCM-auth', AES_GCM_NO_AUTH: 'AES-GCM' };
    export const SECURITY_LEVEL = { SECURE_SOFTWARE: 'keystore' };
    // Like iOS with skipUIAuth, entries that need authentication are not listed.
    export async function getAllGenericPasswordServices() {
      return [...fixture.credentials.keys()].filter(service => !fixture.hideProtected || !service.includes('protected-mnemonic'));
    }
    export async function hasGenericPassword({ service }) {
      return fixture.credentials.has(service);
    }
    export async function getGenericPassword({ service }) {
      if (service.includes('protected-mnemonic')) {
        fixture.secretReads.push(service);
        if (!fixture.allowSecretReads) throw new Error('The protected phrase could not be read.');
      }
      return fixture.credentials.get(service) ?? false;
    }
    export async function setGenericPassword(username, password, options) {
      if (fixture.failMetadataWrite && options.service.includes('.profile.')) {
        throw new Error('Could not persist the public profile.');
      }
      const credential = { username, password, storage: options.storage, options };
      fixture.credentials.set(options.service, credential);
      return credential;
    }
    export async function resetGenericPassword({ service }) {
      return fixture.credentials.delete(service);
    }
  `,
};

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in mocks) return { url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]), shortCircuit: true };
    if (context.parentURL?.startsWith(sourceDirectory) && /^\.\/[a-z-]+$/.test(specifier)) {
      return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});

const storage = await import('../src/testnet-storage.ts');

after(() => {
  hooks.deregister();
  delete globalThis.lustreWalletStorageFixture;
});

beforeEach(() => {
  fixture.credentials.clear();
  for (const items of fixture.databases.values()) items.clear();
  fixture.secretReads.length = 0;
  fixture.authorize = true;
  fixture.allowSecretReads = true;
  fixture.failMetadataWrite = false;
  fixture.hideProtected = false;
});

const phrase = createMnemonic(new Uint8Array(16));
const otherPhrase = createMnemonic(new Uint8Array(16).fill(1));

function profileFor(seed, network) {
  const wallet = openPearlWallet(seed, network);
  try {
    return {
      address: wallet.address(),
      scriptHex: wallet.scriptHex(),
      miningAddress: network === 'mainnet' ? wallet.address(0, 1) : null,
      miningScriptHex: network === 'mainnet' ? wallet.scriptHex(0, 1) : null,
      backupVerified: true,
      watchKey: wallet.watchKey(),
      receiveIndex: 0,
      watchOnly: false,
    };
  } finally {
    wallet.close();
  }
}

test('a canceled device prompt prevents the app from reading the protected phrase', async () => {
  const profile = profileFor(phrase, 'mainnet');
  await storage.saveWalletProfile('mainnet', phrase, profile);
  const entry = fixture.credentials.get('lustre.mainnet.protected-mnemonic.v1');
  assert.equal(entry.options.accessControl, 'both');
  assert.equal(entry.options.storage, 'AES-GCM-auth');
  assert.equal(await storage.readSelectedNetwork(), 'mainnet');
  await storage.saveSelectedNetwork('testnet2');
  assert.equal(await storage.readSelectedNetwork(), 'testnet2');
  assert.equal(await storage.readWalletProfile('testnet2'), null);

  fixture.authorize = false;
  assert.deepEqual(await storage.readWalletProfile('mainnet'), profile);
  await assert.rejects(storage.readRecoveryPhrase('mainnet', 'send'), /authentication canceled/);
  await assert.rejects(storage.readRecoveryPhrase('mainnet', 'reveal'), /authentication canceled/);
  assert.equal(fixture.secretReads.length, 0);
  fixture.authorize = true;
  assert.equal(await storage.readRecoveryPhrase('mainnet', 'send'), phrase);
  assert.deepEqual(fixture.secretReads, ['lustre.mainnet.protected-mnemonic.v1']);
});

test('an interrupted profile write preserves the protected wallet and requires device-authenticated recovery', async () => {
  const profile = profileFor(phrase, 'mainnet');
  await assert.rejects(storage.saveWalletProfile('mainnet', otherPhrase, profile), /does not match/);
  assert.equal(await storage.hasProtectedWallet('mainnet'), false);
  fixture.failMetadataWrite = true;
  await assert.rejects(storage.saveWalletProfile('mainnet', phrase, profile), /persist the public profile/);
  assert.equal(await storage.readWalletProfile('mainnet'), null);
  assert.equal(await storage.hasProtectedWallet('mainnet'), true);
  fixture.failMetadataWrite = false;
  await assert.rejects(
    storage.saveWalletProfile('mainnet', otherPhrase, profileFor(otherPhrase, 'mainnet')),
    /already exists/,
  );
  fixture.authorize = false;
  await assert.rejects(storage.recoverWalletProfile('mainnet', seed => profileFor(seed, 'mainnet')), /authentication canceled/);
  fixture.authorize = true;
  const recovered = await storage.recoverWalletProfile('mainnet', seed => profileFor(seed, 'mainnet'));
  assert.deepEqual(recovered, { ...profile, backupVerified: false });
  const verified = await storage.saveBackupVerified('mainnet', profile.address);
  assert.deepEqual(verified, profile);
});

test('migration preserves the previous Testnet2 phrase until the new protected item can be read back', async () => {
  const alias = 'lustre.testnet2.mnemonic.v1';
  const derive = seed => profileFor(seed, 'testnet2');
  fixture.credentials.set(alias, { username: 'Lustre Testnet2', password: phrase });
  fixture.allowSecretReads = false;
  await assert.rejects(storage.migrateLegacyTestnetWallet(derive), /protected phrase could not be read/);
  assert.equal(await storage.hasLegacyTestnetWallet(), true);
  assert.equal(await storage.hasProtectedWallet('testnet2'), true);
  assert.equal(await storage.readWalletProfile('testnet2'), null);

  fixture.allowSecretReads = true;
  const migrated = await storage.migrateLegacyTestnetWallet(derive);
  assert.equal(await storage.hasLegacyTestnetWallet(), false);
  assert.deepEqual(migrated, { ...derive(phrase), backupVerified: false });
  assert.deepEqual(await storage.readWalletProfile('testnet2'), migrated);
  assert.equal(await storage.hasProtectedWallet('mainnet'), false);
});

test('older profiles read with defaults; receive state and watch-only wallets are validated', async () => {
  const profile = profileFor(phrase, 'mainnet');
  const { watchKey, receiveIndex, watchOnly, ...older } = profile;
  await storage.saveWalletProfile('mainnet', phrase, { ...older, watchKey: null, receiveIndex: 0, watchOnly: false });
  const legacy = fixture.credentials.get('lustre.mainnet.profile.v1');
  legacy.password = JSON.stringify(older);
  assert.deepEqual(await storage.readWalletProfile('mainnet'), { ...older, watchKey: null, receiveIndex: 0, watchOnly: false });
  await assert.rejects(storage.saveReceiveState('mainnet', profile.address, { receiveIndex: 3 }), /receive address/);
  await assert.rejects(storage.saveReceiveState('mainnet', profile.address, { watchKey: profileFor(otherPhrase, 'mainnet').watchKey }), /watch key/);
  const updated = await storage.saveReceiveState('mainnet', profile.address, { watchKey, receiveIndex: 4 });
  assert.equal(updated.receiveIndex, 4);
  await assert.rejects(storage.saveReceiveState('mainnet', profile.address, { receiveIndex: 1 }), /receive address/);
  await assert.rejects(storage.saveWatchOnlyProfile('mainnet', profile), /already exists/);

  const watched = { ...profileFor(otherPhrase, 'testnet2'), watchOnly: true, miningAddress: null, miningScriptHex: null, watchKey: null };
  await storage.saveWatchOnlyProfile('testnet2', watched);
  assert.deepEqual(await storage.readWalletProfile('testnet2'), { ...watched, backupVerified: true });
  assert.equal(await storage.hasProtectedWallet('testnet2'), false);
  await storage.removeWalletFromDevice('testnet2', watched.address);
  assert.equal(await storage.readWalletProfile('testnet2'), null);
});

test('wallets other than main use their own keychain entries and journal', async () => {
  const second = { network: 'mainnet', id: 'abc123' };
  const main = profileFor(phrase, 'mainnet');
  const other = profileFor(otherPhrase, 'mainnet');
  await storage.saveWalletProfile('mainnet', phrase, main);
  await storage.saveWalletProfile(second, otherPhrase, other);
  assert.equal((await storage.readWalletProfile('mainnet')).address, main.address);
  assert.equal((await storage.readWalletProfile(second)).address, other.address);
  assert.ok(fixture.credentials.has('lustre.mainnet.abc123.protected-mnemonic.v1'));
  assert.equal(await storage.readRecoveryPhrase(second, 'reveal'), otherPhrase);
  await storage.removeWalletFromDevice(second, other.address);
  assert.equal(await storage.readWalletProfile(second), null);
  assert.equal((await storage.readWalletProfile('mainnet')).address, main.address);
  assert.throws(() => storage.walletRef({ network: 'mainnet', id: '../x' }), /Unknown wallet/);
});

test('a pending transfer with a Pearlet tip is checked output by output', async () => {
  const { Transaction } = await import('@scure/btc-signer/transaction.js');
  const { hex } = await import('@scure/base');
  const { supportAddress } = await import('../src/support.ts');
  const wallet = openPearlWallet(phrase, 'mainnet');
  try {
    const previous = new Transaction({ version: 1 });
    previous.addInput({ txid: 'a'.repeat(64), index: 0 });
    previous.addOutput({ amount: 2_000_000n, script: hex.decode(wallet.scriptHex()) });
    const recipient = openPearlWallet(otherPhrase, 'mainnet').address();
    const signed = wallet.signPayment({
      inputs: [{ txid: previous.id, vout: 0, amountGrains: 2_000_000, scriptHex: wallet.scriptHex(), rawTxHex: previous.hex }],
      recipient,
      amountGrains: 1_000_000,
      tip: { address: supportAddress, amountGrains: 5_000 },
      changeGrains: 995_000 - 154 * 2,
      feeGrains: 154 * 2,
      entropy: new Uint8Array(32).fill(7),
    });
    const transaction = Transaction.fromRaw(hex.decode(signed.hex));
    assert.equal(transaction.outputsLength, 3);
    assert.equal(transaction.getOutput(1).amount, 5_000n);
    const payment = {
      txid: signed.txid, hex: signed.hex, address: wallet.address(), recipient,
      amountGrains: 1_000_000, feeGrains: 308, tipGrains: 5_000, inputIds: [previous.id + ':0'],
    };
    await assert.rejects(storage.savePendingPayment('mainnet', { ...payment, tipGrains: 4_000 }), /journal could not be read/);
    await assert.rejects(storage.savePendingPayment('mainnet', { ...payment, tipGrains: undefined }), /journal could not be read/);
    await storage.savePendingPayment('mainnet', payment);
    assert.deepEqual(await storage.readPendingPayment('mainnet', wallet.address()), payment);
  } finally {
    wallet.close();
  }
});

test('the wallet list is rebuilt from the keychain when app storage is gone', async () => {
  const second = { network: 'mainnet', id: 'abc123' };
  await storage.saveWalletProfile('mainnet', phrase, profileFor(phrase, 'mainnet'));
  await storage.saveWalletProfile(second, otherPhrase, profileFor(otherPhrase, 'mainnet'));
  await storage.saveWalletList('mainnet', [{ id: 'main', name: 'Daily' }]);
  assert.deepEqual(await storage.readWalletList('mainnet'), [{ id: 'main', name: 'Daily' }, { id: 'abc123', name: 'Wallet 2' }]);

  // A reinstall on iOS: app storage is empty, the keychain is not.
  for (const items of fixture.databases.values()) items.clear();
  fixture.hideProtected = true;
  assert.deepEqual(await storage.readWalletList('mainnet'), [{ id: 'main', name: 'Main wallet' }, { id: 'abc123', name: 'Wallet 2' }]);
  assert.deepEqual(await storage.readWalletList('testnet2'), [{ id: 'main', name: 'Main wallet' }]);
});

test('wallets left by an earlier install wait for the user to keep or erase them', async () => {
  assert.equal(await storage.hasWalletsFromEarlierInstall(), false);
  // The first launch with nothing saved marks this install.
  await storage.saveWalletProfile('mainnet', phrase, profileFor(phrase, 'mainnet'));
  assert.equal(await storage.hasWalletsFromEarlierInstall(), false);

  for (const items of fixture.databases.values()) items.clear();
  assert.equal(await storage.hasWalletsFromEarlierInstall(), true);
  fixture.authorize = false;
  await assert.rejects(storage.keepWalletsFromEarlierInstall(), /authentication canceled/);
  assert.equal(await storage.hasWalletsFromEarlierInstall(), true);
  fixture.authorize = true;
  await storage.keepWalletsFromEarlierInstall();
  assert.equal(await storage.hasWalletsFromEarlierInstall(), false);
  assert.equal((await storage.readWalletProfile('mainnet')).address, profileFor(phrase, 'mainnet').address);
});

test('erasing every wallet needs authentication and leaves nothing behind', async () => {
  const second = { network: 'mainnet', id: 'abc123' };
  await storage.saveWalletProfile('mainnet', phrase, profileFor(phrase, 'mainnet'));
  await storage.saveWalletProfile(second, otherPhrase, profileFor(otherPhrase, 'mainnet'));
  await storage.saveWalletProfile('testnet2', phrase, profileFor(phrase, 'testnet2'));
  await storage.saveWalletList('mainnet', await storage.readWalletList('mainnet'));
  fixture.hideProtected = true;

  fixture.authorize = false;
  await assert.rejects(storage.eraseAllWallets(), /authentication canceled/);
  assert.equal(fixture.credentials.size, 6);
  fixture.authorize = true;
  await storage.eraseAllWallets();
  assert.equal(fixture.credentials.size, 0);
  assert.deepEqual(await storage.readWalletList('mainnet'), [{ id: 'main', name: 'Main wallet' }]);
  assert.equal(await storage.readWalletProfile('mainnet'), null);
  assert.equal(await storage.hasWalletsFromEarlierInstall(), false);
});

test('a pending transfer may send change to a fresh address, and only to the one recorded', async () => {
  const { Transaction } = await import('@scure/btc-signer/transaction.js');
  const { hex } = await import('@scure/base');
  const wallet = openPearlWallet(phrase, 'mainnet');
  try {
    const previous = new Transaction({ version: 1 });
    previous.addInput({ txid: 'b'.repeat(64), index: 0 });
    previous.addOutput({ amount: 2_000_000n, script: hex.decode(wallet.scriptHex()) });
    const recipient = openPearlWallet(otherPhrase, 'mainnet').address();
    const fee = 154 * 2;
    const signed = wallet.signPayment({
      inputs: [{ txid: previous.id, vout: 0, amountGrains: 2_000_000, scriptHex: wallet.scriptHex(), rawTxHex: previous.hex }],
      recipient,
      amountGrains: 1_000_000,
      changeGrains: 1_000_000 - fee,
      changeIndex: 2,
      feeGrains: fee,
      entropy: new Uint8Array(32).fill(9),
    });
    const transaction = Transaction.fromRaw(hex.decode(signed.hex));
    assert.equal(hex.encode(transaction.getOutput(1).script), wallet.scriptHex(0, 2));
    const payment = {
      txid: signed.txid, hex: signed.hex, address: wallet.address(), changeAddress: wallet.address(0, 2), recipient,
      amountGrains: 1_000_000, feeGrains: fee, inputIds: [previous.id + ':0'],
    };
    await assert.rejects(storage.savePendingPayment('mainnet', { ...payment, changeAddress: undefined }), /journal could not be read/);
    await assert.rejects(storage.savePendingPayment('mainnet', { ...payment, changeAddress: wallet.address(0, 3) }), /journal could not be read/);
    await storage.savePendingPayment('mainnet', payment);
    assert.deepEqual(await storage.readPendingPayment('mainnet', wallet.address()), payment);
  } finally {
    wallet.close();
  }
});
