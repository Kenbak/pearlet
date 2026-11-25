import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { createMnemonic, normalizeMnemonic, openPearlWallet, validatePearlAddress } from './pearl-keys.ts';
import type { PearlNetwork } from './pearl-network.ts';
import type { WalletIdentity } from './testnet-wallet.ts';

export type BackupDraft = {
  phrase: string;
  positions: readonly number[];
};

export type RestorePreview = {
  address: string;
  miningAddress?: string;
};

/** One word from each third of a 12-word phrase, chosen by three random bytes. */
export function backupChallengePositions(challengeEntropy: Uint8Array): number[] {
  if (challengeEntropy.length !== 3) throw new Error('Could not create a backup challenge.');
  return [0, 4, 8].map((base, index) => base + (challengeEntropy[index] & 3));
}

export type BackupQuizQuestion = {
  position: number;
  choices: readonly string[];
};

export const backupQuizEntropyLength = 16;

/**
 * Four questions, one position from each quarter of the phrase, each with the
 * right word and two other words from the same phrase in random order.
 * Works for 12- and 24-word phrases.
 */
export function makeBackupQuiz(phrase: string, entropy: Uint8Array): BackupQuizQuestion[] {
  const words = phrase.split(' ');
  if (words.length !== 12 && words.length !== 24) throw new Error('The recovery phrase must have 12 or 24 words.');
  const quarter = words.length / 4;
  if (entropy.length !== backupQuizEntropyLength) throw new Error('Could not create a backup quiz.');
  let cursor = 0;
  const next = () => entropy[cursor++];

  return [0, 1, 2, 3].map((part) => {
    const position = part * quarter + (next() % quarter);
    const answer = words[position];
    const pool = [...new Set(words.filter((word) => word !== answer))];
    const decoys: string[] = [];
    for (let pick = 0; pick < 2 && pool.length; pick += 1) {
      decoys.push(pool.splice(next() % pool.length, 1)[0]);
    }
    const choices = [answer, ...decoys];
    const shift = next() % choices.length;
    return { position, choices: [...choices.slice(shift), ...choices.slice(0, shift)] };
  });
}

export function makeBackupDraft(entropy: Uint8Array, challengeEntropy: Uint8Array): BackupDraft {
  return { phrase: createMnemonic(entropy), positions: backupChallengePositions(challengeEntropy) };
}

export function phraseFingerprint(phrase: string): string {
  const bytes = utf8ToBytes(phrase);
  try {
    return hex.encode(sha256(bytes));
  } finally {
    bytes.fill(0);
  }
}

export function requireRecoveryPhrase(value: string): string {
  const phrase = normalizeMnemonic(value);
  if (!phrase) throw new Error('Check the words and their order, then try again.');
  return phrase;
}

export function verifyBackupWords(
  phrase: string,
  positions: readonly number[],
  answers: readonly string[],
): boolean {
  const words = phrase.split(' ');
  return positions.length === 3
    && new Set(positions).size === positions.length
    && answers.length === positions.length
    && positions.every((position, index) => Number.isInteger(position) && position >= 0
      && position < words.length && answers[index]?.trim().toLowerCase() === words[position]);
}

export function deriveWalletIdentity(phrase: string, network: PearlNetwork): WalletIdentity {
  const wallet = openPearlWallet(phrase, network);
  try {
    const identity = { network, address: wallet.address(), scriptHex: wallet.scriptHex(), watchKey: wallet.watchKey() };
    return network === 'mainnet' ? {
      ...identity,
      miningAddress: wallet.address(0, 1),
      miningScriptHex: wallet.scriptHex(0, 1),
    } : identity;
  } finally {
    wallet.close();
  }
}

export function previewWalletRestore(
  phrase: string,
  network: PearlNetwork,
  expectedAddress?: string,
): RestorePreview {
  const { address, miningAddress } = deriveWalletIdentity(phrase, network);
  if (expectedAddress?.trim()) {
    const expected = validatePearlAddress(expectedAddress, network);
    if (!expected) throw new Error('Enter a known address on the selected network.');
    if (expected !== address && expected !== miningAddress) {
      throw new Error('This recovery phrase does not match the known wallet address.');
    }
  }
  return { address, miningAddress };
}

export function matchesWalletAddresses(current: RestorePreview, restored: RestorePreview): boolean {
  return current.address === restored.address && current.miningAddress === restored.miningAddress;
}
