import assert from 'node:assert/strict';
import test from 'node:test';

import { openPearlWallet } from '../src/pearl-keys.ts';
import { buildPaymentUri, grainsToDecimal, parsePaymentRequest } from '../src/payment-uri.ts';
import { contactFor, parseContacts, removeContact, upsertContact } from '../src/contacts-core.ts';

const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const wallet = openPearlWallet(phrase, 'mainnet');
const mainnet = wallet.address();
const other = wallet.address(0, 1);
wallet.close();
const testWallet = openPearlWallet(phrase, 'testnet2');
const testnet = testWallet.address();
testWallet.close();

test('reads bare addresses and pearl: payment requests', () => {
  assert.deepEqual(parsePaymentRequest('  ' + mainnet.toUpperCase() + ' ', 'mainnet'), { address: mainnet });
  assert.deepEqual(
    parsePaymentRequest('pearl:' + mainnet + '?amount=2.5&label=Coffee%20shop&message=Thanks', 'mainnet'),
    { address: mainnet, amountGrains: 250_000_000, label: 'Coffee shop', message: 'Thanks' },
  );
  assert.deepEqual(parsePaymentRequest('PRL:' + mainnet + '?amount=0.00001&foo=bar', 'mainnet'), { address: mainnet, amountGrains: 1000 });
  assert.throws(() => parsePaymentRequest('pearl:' + mainnet + '?req-signature=x', 'mainnet'), /does not support/);
  assert.throws(() => parsePaymentRequest('pearl:' + mainnet + '?amount=1.123456789', 'mainnet'), /8 decimal/);
  assert.throws(() => parsePaymentRequest('pearl:' + mainnet + '?amount=1&amount=2', 'mainnet'), /repeats/);
  assert.throws(() => parsePaymentRequest(testnet, 'mainnet'), /not a valid Pearl Mainnet/);
  assert.throws(() => parsePaymentRequest('bitcoin:' + mainnet, 'mainnet'), /not a valid/);
});

test('builds requests that read back exactly', () => {
  assert.equal(grainsToDecimal(250_000_000), '2.5');
  assert.equal(grainsToDecimal(1), '0.00000001');
  assert.equal(grainsToDecimal(100_000_000), '1');
  const uri = buildPaymentUri({ address: mainnet, amountGrains: 123_456_789, label: 'Rent & bills' });
  assert.equal(uri, 'pearl:' + mainnet + '?amount=1.23456789&label=Rent%20%26%20bills');
  assert.deepEqual(parsePaymentRequest(uri, 'mainnet'), { address: mainnet, amountGrains: 123_456_789, label: 'Rent & bills' });
  assert.equal(buildPaymentUri({ address: mainnet }), 'pearl:' + mainnet);
});

test('keeps one valid contact per address, sorted by name', () => {
  let contacts = upsertContact([], '  Zoe  ', mainnet, 'mainnet');
  contacts = upsertContact(contacts, 'Alex', other, 'mainnet');
  contacts = upsertContact(contacts, 'Zoe B', mainnet.toUpperCase(), 'mainnet');
  assert.deepEqual(contacts.map((c) => c.name), ['Alex', 'Zoe B']);
  assert.equal(contactFor(contacts, mainnet)?.name, 'Zoe B');
  assert.throws(() => upsertContact(contacts, ' ', mainnet, 'mainnet'), /name/);
  assert.throws(() => upsertContact(contacts, 'Test', testnet, 'mainnet'), /not a valid/);
  assert.deepEqual(removeContact(contacts, other).map((c) => c.name), ['Zoe B']);
  const stored = JSON.stringify([...contacts, { name: 'Bad', address: testnet }, { nope: 1 }]);
  assert.deepEqual(parseContacts(stored, 'mainnet'), contacts);
  assert.deepEqual(parseContacts('garbage', 'mainnet'), []);
});

import { markRecent, quickContacts, searchContacts } from '../src/contacts-core.ts';

test('quick contacts put recent ones first and search covers name and address', () => {
  const contacts = ['Ana', 'Ben', 'Cal', 'Dee'].map((name, index) => ({ name, address: 'prl1p' + index }));
  let recent = markRecent([], 'prl1p2');
  recent = markRecent(recent, 'prl1p3');
  recent = markRecent(recent, 'prl1p2');
  assert.deepEqual(recent, ['prl1p2', 'prl1p3']);
  assert.deepEqual(quickContacts(contacts, [...recent, 'gone'], 3).map(c => c.name), ['Cal', 'Dee', 'Ana']);
  assert.deepEqual(searchContacts(contacts, 'be').map(c => c.name), ['Ben']);
  assert.deepEqual(searchContacts(contacts, 'p3').map(c => c.name), ['Dee']);
  assert.equal(searchContacts(contacts, ' ').length, 4);
});

test('QR modules have finder patterns and a path that covers exactly the dark modules', async () => {
  const { qrModules, qrPath } = await import('../src/qr-core.ts');
  const modules = qrModules('prl1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
  const size = modules.length;
  assert.equal((size - 17) % 4, 0);
  assert.ok(modules.every(row => row.length === size));
  const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.deepEqual(finder, finder.map((_, y) => modules[top + y].slice(left, left + 7).map(Number).join('')));
  }
  let covered = 0;
  for (const [, , , width] of qrPath(modules).matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) covered += Number(width);
  assert.equal(covered, modules.flat().filter(Boolean).length);
});
