import assert from 'node:assert/strict';
import test from 'node:test';

import { broadcastTestnetTransaction } from '../src/pearl-indexer.ts';
import { estimatePaymentVsize } from '../src/pearl-keys.ts';
import { createMnemonic, openPearlWallet } from '../src/pearl-keys.ts';
import { changeTarget, formatPrl, parseSendAmount, selectPayment, selectSendAll } from '../src/testnet-wallet.ts';
import { supportTipGrains } from '../src/support.ts';

test('converts decimal PRL to exact grains and rejects dust or excess precision', () => {
  assert.equal(parseSendAmount('.01234567'), 1_234_567);
  assert.equal(parseSendAmount('0.00000333'), 333);
  assert.equal(formatPrl(100_000_001, 2), '1.00000001');
  assert.throws(() => parseSendAmount('0.00000332'), /at least/);
  assert.throws(() => parseSendAmount('1.000000001'), /up to 8/);
  assert.throws(() => parseSendAmount('1e-4'), /up to 8/);
  assert.throws(() => parseSendAmount('1000000000'), /too large/);
});

test('coin selection includes the vsize fee and amounts below the change dust threshold', () => {
  const rate = 6;
  const noChangeFee = estimatePaymentVsize(1, false) * rate;
  const withChangeFee = estimatePaymentVsize(1, true) * rate;

  assert.equal(selectPayment([10_000 + noChangeFee - 1], 10_000, rate), null);
  assert.deepEqual(selectPayment([10_000 + noChangeFee], 10_000, rate),
    { count: 1, feeGrains: noChangeFee, changeGrains: 0 });
  assert.deepEqual(selectPayment([10_000 + withChangeFee + 332], 10_000, rate),
    { count: 1, feeGrains: withChangeFee + 332, changeGrains: 0 });
  assert.deepEqual(selectPayment([10_000 + withChangeFee + 333], 10_000, rate),
    { count: 1, feeGrains: withChangeFee, changeGrains: 333 });
  assert.equal(selectPayment([7_500, 7_500], 10_000, rate).count, 2);
  assert.throws(() => selectPayment([20_000], 10_000, Number.MAX_SAFE_INTEGER), /fee rate/);
});

test('send everything takes the fee and tip out of the amount and leaves no change', () => {
  const rate = 6;
  const fee = estimatePaymentVsize(2, false) * rate;
  assert.deepEqual(selectSendAll([60_000_000, 40_000_000], rate, 'mainnet'),
    { count: 2, amountGrains: 100_000_000 - fee, tipGrains: 0, feeGrains: fee });

  const tipped = selectSendAll([100_000_000], rate, 'mainnet', true);
  const tipFee = estimatePaymentVsize(1, false, 1) * rate;
  assert.equal(tipped.tipGrains, supportTipGrains(tipped.amountGrains));
  assert.equal(tipped.amountGrains + tipped.tipGrains + tipped.feeGrains, 100_000_000);
  assert.ok(tipped.feeGrains >= tipFee && tipped.feeGrains < tipFee + 3);
  assert.ok(tipped.amountGrains + 1 + supportTipGrains(tipped.amountGrains + 1) > 100_000_000 - tipFee);

  // Too small to tip: everything goes to the recipient without a tip output.
  const small = selectSendAll([20_000], rate, 'mainnet', true);
  assert.equal(small.tipGrains, 0);
  assert.equal(small.amountGrains, 20_000 - estimatePaymentVsize(1, false) * rate);
  assert.equal(selectSendAll([estimatePaymentVsize(1, false) * rate + 332], rate), null);
  assert.equal(selectSendAll([], rate), null);
});

const origin = 'https://blockbook.testnet2.pearlnetwork.net/api/v2';
const txid = 'ab'.repeat(32);
const status = {
  blockbook: { coin: 'Pearl Testnet2', decimals: 8, bestHeight: 153000, inSync: true, inSyncMempool: true },
  backend: { chain: 'testnet2' },
};

test('the relay requires a verified Testnet2 endpoint before posting bytes', async context => {
  const request = context.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, origin);
    return Response.json({ ...status, backend: { chain: 'mainnet' } });
  });
  await assert.rejects(broadcastTestnetTransaction('baba', txid), /Testnet2/);
  assert.equal(request.mock.callCount(), 1);
});

test('a disconnected relay and an absent tx never trigger a second POST', async context => {
  const calls = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(options.method + ' ' + url);
    if (url === origin) return Response.json(status);
    if (options.method === 'POST') throw new TypeError('Network interrupted');
    return Response.json({ error: "Transaction '" + txid + "' not found" }, { status: 400 });
  });
  assert.equal((await broadcastTestnetTransaction('baba', txid)).status, 'unknown');
  assert.deepEqual(calls, ['GET ' + origin, 'POST ' + origin + '/sendtx/', 'GET ' + origin + '/tx/' + txid]);
});

test('change goes to the address after the newest one issued', () => {
  const wallet = openPearlWallet(createMnemonic(new Uint8Array(16).fill(3)), 'testnet2');
  try {
    const identity = { network: 'testnet2', address: wallet.address(), scriptHex: wallet.scriptHex(), watchKey: wallet.watchKey() };
    assert.deepEqual(changeTarget(identity), { index: 2, address: wallet.address(0, 2) });
    assert.deepEqual(changeTarget({ ...identity, receiveIndex: 7 }), { index: 8, address: wallet.address(0, 8) });
    // An older profile without a watch key cannot derive addresses.
    assert.deepEqual(changeTarget({ ...identity, watchKey: undefined, receiveIndex: 0 }), { index: 0, address: wallet.address() });
  } finally {
    wallet.close();
  }
});
