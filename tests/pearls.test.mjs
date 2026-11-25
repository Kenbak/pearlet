import assert from 'node:assert/strict';
import test from 'node:test';

import { describePearls, formatDifficulty, ripeness, summarizeMining } from '../src/pearls.ts';

const utxo = (txid, value, confirmations, index = 0, coinbase = false) => ({
  txid: txid.repeat(64), vout: 0, valueGrains: BigInt(value), confirmations, height: 1001 - confirmations, coinbase, index,
});

test('pearls carry ripening countdowns and mining totals', () => {
  const pearls = describePearls([
    utxo('a', 500, 40, 1, true),
    utxo('b', 900, 150, 1, true),
    utxo('c', 300, 5),
    utxo('d', 100, 0),
    utxo('e', 700, 98, 0),
  ], new Map([['e'.repeat(64), true]]), 100);
  assert.deepEqual(pearls.map(p => p.valueGrains), [900, 700, 500, 300]);
  const byValue = Object.fromEntries(pearls.map(p => [p.valueGrains, p]));
  assert.equal(byValue[500].blocksToRipe, 60);
  assert.equal(byValue[900].blocksToRipe, 0);
  assert.equal(byValue[700].blocksToRipe, 2);
  assert.equal(byValue[300].coinbase, false);
  assert.equal(ripeness(byValue[500], 100), 0.4);
  assert.equal(ripeness(byValue[300], 100), 1);

  const mining = summarizeMining(pearls, 1000, 65093231, 100);
  assert.deepEqual(mining.ripening.map(p => p.valueGrains), [700, 500]);
  assert.equal(mining.ripeningGrains, 1200);
  assert.equal(mining.ripeGrains, 900);
  assert.equal(mining.recentCount, 2);
  assert.equal(mining.recentGrains, 1200);
  assert.equal(formatDifficulty(65093231), '65.1 M');
  assert.equal(formatDifficulty(null), 'Unavailable');
});
