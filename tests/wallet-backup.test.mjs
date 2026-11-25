import assert from 'node:assert/strict';
import test from 'node:test';

import { createMnemonic, isRecoveryWord, splitRecoveryWords } from '../src/pearl-keys.ts';
import { defaultPearlNetwork } from '../src/pearl-network.ts';
import {
  backupChallengePositions,
  backupQuizEntropyLength,
  makeBackupQuiz,
  deriveWalletIdentity,
  makeBackupDraft,
  matchesWalletAddresses,
  phraseFingerprint,
  previewWalletRestore,
  requireRecoveryPhrase,
  verifyBackupWords,
} from '../src/wallet-backup.ts';

const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('verifies only the selected backup words in their requested order', () => {
  const draft = makeBackupDraft(new Uint8Array(16), Uint8Array.of(0, 5, 255));
  assert.equal(draft.phrase, phrase);
  assert.deepEqual(draft.positions, [0, 5, 11]);
  assert.equal(verifyBackupWords(draft.phrase, draft.positions, [' ABANDON ', 'abandon', 'about']), true);
  assert.equal(verifyBackupWords(draft.phrase, draft.positions, ['about', 'abandon', 'abandon']), false);
  assert.equal(verifyBackupWords(draft.phrase, draft.positions, ['abandon', 'abandon']), false);
  assert.equal(verifyBackupWords(draft.phrase, [0, 0, 11], ['abandon', 'abandon', 'about']), false);
  assert.equal(phraseFingerprint(requireRecoveryPhrase(phrase.toUpperCase())), phraseFingerprint(phrase));
});

test('restoring a Lustre mainnet backup recovers normal and mining addresses', () => {
  const wallet = deriveWalletIdentity(phrase, defaultPearlNetwork);
  assert.equal(wallet.network, 'mainnet');
  assert.match(wallet.address, /^prl1p/);
  assert.match(wallet.miningAddress, /^prl1p/);
  assert.notEqual(wallet.address, wallet.miningAddress);
  for (const address of [undefined, wallet.address, wallet.miningAddress]) {
    assert.ok(matchesWalletAddresses(wallet, previewWalletRestore(phrase, 'mainnet', address)));
  }
  const differentPhrase = createMnemonic(new Uint8Array(16).fill(9));
  assert.throws(() => previewWalletRestore(differentPhrase, 'mainnet', wallet.miningAddress), /does not match/);
  assert.equal(matchesWalletAddresses(wallet, previewWalletRestore(differentPhrase, 'mainnet')), false);
});

test('preserves the Testnet2 receive address and detects the wrong network during recovery', () => {
  const testWallet = deriveWalletIdentity(phrase, 'testnet2');
  const mainWallet = deriveWalletIdentity(phrase, 'mainnet');
  assert.match(testWallet.address, /^tprl1p/);
  assert.equal(testWallet.miningAddress, undefined);
  assert.ok(matchesWalletAddresses(testWallet, previewWalletRestore(phrase, 'testnet2', testWallet.address)));
  assert.throws(() => previewWalletRestore(phrase, 'testnet2', mainWallet.address), /selected network/);
  assert.throws(() => requireRecoveryPhrase('abandon '.repeat(12)), /Check the words/);
});

test('picks one deferred-backup challenge word from each third of the phrase', () => {
  assert.deepEqual(backupChallengePositions(Uint8Array.of(0, 5, 255)), [0, 5, 11]);
  for (let byte = 0; byte < 256; byte += 1) {
    const positions = backupChallengePositions(Uint8Array.of(byte, byte, byte));
    assert.ok(positions[0] >= 0 && positions[0] <= 3);
    assert.ok(positions[1] >= 4 && positions[1] <= 7);
    assert.ok(positions[2] >= 8 && positions[2] <= 11);
  }
  assert.throws(() => backupChallengePositions(new Uint8Array(2)), /backup challenge/);
});

const quizPhrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

test('builds a four-question tap quiz with the right word among phrase-only choices', () => {
  const words = quizPhrase.split(' ');
  for (let seed = 0; seed < 64; seed += 1) {
    const entropy = Uint8Array.from({ length: backupQuizEntropyLength }, (_, index) => (seed * 37 + index * 11) & 255);
    const quiz = makeBackupQuiz(quizPhrase, entropy);
    assert.equal(quiz.length, 4);
    quiz.forEach((question, index) => {
      assert.ok(question.position >= index * 3 && question.position < index * 3 + 3);
      assert.equal(question.choices.length, 3);
      assert.equal(new Set(question.choices).size, 3);
      assert.equal(question.choices.filter((choice) => choice === words[question.position]).length, 1);
      assert.ok(question.choices.every((choice) => words.includes(choice)));
    });
  }
  assert.throws(() => makeBackupQuiz(quizPhrase, new Uint8Array(4)), /backup quiz/);
  assert.throws(() => makeBackupQuiz('legal winner', new Uint8Array(backupQuizEntropyLength)), /12 or 24 words/);
});

test('splits pasted phrases with numbering, commas and line breaks', () => {
  assert.deepEqual(splitRecoveryWords('1. Legal 2) winner,\n3: thank  year'), ['legal', 'winner', 'thank', 'year']);
  assert.deepEqual(splitRecoveryWords('  '), []);
  assert.ok(isRecoveryWord(' Legal '));
  assert.ok(!isRecoveryWord('pearl1'));
});

import { openPearlWallet as openForLongPhrase } from '../src/pearl-keys.ts';
import { makeBackupQuiz as quizForLongPhrase } from '../src/wallet-backup.ts';

test('24-word phrases restore and get a quiz from each quarter', () => {
  const long = Array(23).fill('abandon').join(' ') + ' art';
  const wallet = openForLongPhrase(long, 'mainnet');
  try {
    assert.match(wallet.address(), /^prl1p/);
  } finally {
    wallet.close();
  }
  const quiz = quizForLongPhrase(long, new Uint8Array(16).fill(5));
  assert.deepEqual(quiz.map((question) => Math.floor(question.position / 6)), [0, 1, 2, 3]);
  assert.throws(() => quizForLongPhrase(Array(15).fill('abandon').join(' '), new Uint8Array(16)), /12 or 24/);
});
