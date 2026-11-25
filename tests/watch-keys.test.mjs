import assert from 'node:assert/strict';
import test from 'node:test';

import { openPearlWallet, validateWatchKey, watchKeyAddress } from '../src/pearl-keys.ts';

const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('watch keys derive the same addresses as the phrase, per network', () => {
  for (const network of ['mainnet', 'testnet2']) {
    const wallet = openPearlWallet(phrase, network);
    try {
      const key = wallet.watchKey();
      assert.match(key, network === 'mainnet' ? /^prlwatch1/ : /^tprlwatch1/);
      assert.equal(validateWatchKey(key.toUpperCase(), network), key);
      for (const index of [0, 1, 2, 7, 40]) {
        const derived = watchKeyAddress(key, network, index);
        assert.equal(derived.address, wallet.address(0, index));
        assert.equal(derived.scriptHex, wallet.scriptHex(0, index));
      }
    } finally {
      wallet.close();
    }
  }
  const mainKey = openPearlWallet(phrase, 'mainnet');
  try {
    assert.equal(validateWatchKey(mainKey.watchKey(), 'testnet2'), null);
  } finally {
    mainKey.close();
  }
  assert.equal(validateWatchKey('prlwatch1qqqq', 'mainnet'), null);
});
