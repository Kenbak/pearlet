import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addWalletEntry, defaultWalletList, isWalletService, newWalletId, parseWalletList, reconcileWalletList, removeWalletEntry,
  renameWalletEntry, storedWalletIds, suggestWalletName,
} from '../src/wallets-core.ts';

test('wallet list keeps the main wallet by default and cleans stored entries', () => {
  assert.deepEqual(parseWalletList(null), defaultWalletList());
  assert.deepEqual(parseWalletList('nonsense'), defaultWalletList());
  assert.deepEqual(parseWalletList('[]'), []);
  assert.deepEqual(parseWalletList(JSON.stringify([
    { id: 'main', name: '  Daily   spend ' }, { id: 'main', name: 'dup' }, { id: 'BAD!', name: 'x' }, { id: 'abc', name: '', watchOnly: true },
  ])), [{ id: 'main', name: 'Daily spend' }, { id: 'abc', name: 'Wallet', watchOnly: true }]);
});

test('add, rename and remove wallets with readable default names', () => {
  let list = defaultWalletList();
  assert.equal(suggestWalletName(list, false), 'Wallet 2');
  assert.equal(suggestWalletName(list, true), 'Watched wallet');
  list = addWalletEntry(list, 'abc', suggestWalletName(list, true), true);
  assert.equal(suggestWalletName(list, true), 'Watched wallet 2');
  list = renameWalletEntry(list, 'abc', 'Savings');
  assert.deepEqual(list.map(entry => entry.name), ['Main wallet', 'Savings']);
  assert.throws(() => renameWalletEntry(list, 'abc', '   '), /Enter a wallet name/);
  assert.equal(addWalletEntry(list, 'abc', 'Again', true).length, 2);
  assert.deepEqual(removeWalletEntry(list, 'main').map(entry => entry.id), ['abc']);
  assert.match(newWalletId(() => 0.5), /^[a-z0-9]{1,16}$/);
});

test('wallets saved in the keychain are found by network and added to the list', () => {
  const services = [
    'lustre.mainnet.profile.v1', 'lustre.mainnet.protected-mnemonic.v1',
    'lustre.mainnet.zz9.profile.v1', 'lustre.mainnet.abc.protected-mnemonic.v1',
    'lustre.testnet2.mnemonic.v1', 'lustre.testnet2.t1.profile.v1',
    'other.app.service', 'lustre.mainnet.BAD!.profile.v1', 'lustre.mainnet.profile.v2',
  ];
  assert.deepEqual(storedWalletIds(services, 'mainnet'), ['main', 'abc', 'zz9']);
  assert.deepEqual(storedWalletIds(services, 'testnet2'), ['main', 't1']);
  assert.deepEqual(services.filter(isWalletService).length, 6);

  const list = [{ id: 'main', name: 'Daily' }, { id: 'abc', name: 'Savings' }];
  assert.equal(reconcileWalletList(list, ['main', 'abc']), list);
  assert.deepEqual(reconcileWalletList(list, ['main', 'abc', 'zz9']), [...list, { id: 'zz9', name: 'Wallet 2' }]);
  assert.deepEqual(reconcileWalletList([], ['main', 'abc']), [{ id: 'main', name: 'Main wallet' }, { id: 'abc', name: 'Wallet 2' }]);
  assert.deepEqual(reconcileWalletList(list, ['../x']), list);
});
