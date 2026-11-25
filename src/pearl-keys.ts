import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { asciiToBytes, bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bech32m, hex } from '@scure/base';
import { entropyToMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { p2tr } from '@scure/btc-signer/payment.js';
import { SigHash, Transaction } from '@scure/btc-signer/transaction.js';
import { equalBytes, TEST_NETWORK } from '@scure/btc-signer/utils.js';

import { pearlNetworks, type PearlNetwork } from './pearl-network.ts';

export type PearlBranch = 0 | 1;

export type PearlPrevout = {
  txid: string;
  vout: number;
  amountGrains: number;
  scriptHex: string;
  rawTxHex: string;
};

export type PearlSpendInput = PearlPrevout & {
  branch?: PearlBranch;
  index?: number;
};

export type PearlPayment = {
  inputs: readonly PearlSpendInput[];
  recipient: string;
  amountGrains: number;
  changeGrains: number;
  feeGrains: number;
  entropy: Uint8Array;
  /** An optional second output, such as a tip, paid after the recipient. */
  tip?: { address: string; amountGrains: number };
  changeBranch?: PearlBranch;
  changeIndex?: number;
};

export type SignedPearlPayment = { txid: string; hex: string; vsize: number };

export type PearlWallet = {
  /** The account's public key and chain code, encoded for watch-only use. */
  watchKey(): string;
  address(branch?: PearlBranch, index?: number): string;
  scriptHex(branch?: PearlBranch, index?: number): string;
  signPayment(payment: PearlPayment): SignedPearlPayment;
  close(): void;
};

const hardened = 0x80000000;
const curveOrder = secp256k1.Point.Fn.ORDER;
const txidPattern = /^[0-9a-f]{64}$/i;
const coinbaseParent = '0'.repeat(64);
const maxRawTxHexLength = 8_000_000;

export function createMnemonic(entropy: Uint8Array): string {
  if (entropy.length !== 16) throw new Error('Wallet creation requires 16 bytes of secure entropy.');
  return entropyToMnemonic(entropy, wordlist);
}

const recoveryWords = new Set(wordlist);

/** Whether a single word is in the BIP-39 English list Pearlet uses. */
export function isRecoveryWord(word: string): boolean {
  return recoveryWords.has(word.normalize('NFKD').trim().toLowerCase());
}

/** Split pasted text into lowercase words, ignoring numbering like "1." or "2)". */
export function splitRecoveryWords(value: string): string[] {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .split(/[\s,]+/)
    .map((word) => word.replace(/^\d+[.):]?/, '').replace(/[^a-z]/g, ''))
    .filter(Boolean);
}

export function normalizeMnemonic(value: string): string | null {
  const mnemonic = value.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
  return validateMnemonic(mnemonic, wordlist) ? mnemonic : null;
}

function decodePearlAddress(value: string, network: PearlNetwork) {
  const { prefix, words } = bech32m.decode(value.trim());
  const [version, ...programWords] = words;
  const program = bech32m.fromWords(programWords);
  const { hrp, label } = pearlNetworks[network];
  if (prefix !== hrp || (version !== 1 && version !== 2) || program.length !== 32) {
    throw new Error(`Use a Pearl ${label} Taproot or Merkle-root address.`);
  }
  if (version === 1) schnorr.utils.lift_x(bytesToNumberBE(program));
  const script = new Uint8Array(34);
  script.set([0x50 + version, 32]);
  script.set(program, 2);
  return { address: bech32m.encode(prefix, words), script };
}

export function validatePearlAddress(value: string, network: PearlNetwork): string | null {
  try {
    return decodePearlAddress(value, network).address;
  } catch {
    return null;
  }
}

export function pearlAddressScriptHex(value: string, network: PearlNetwork): string {
  return hex.encode(decodePearlAddress(value, network).script);
}

export function validateTestnetAddress(value: string): string | null {
  return validatePearlAddress(value, 'testnet2');
}

export function testnetAddressScriptHex(value: string): string {
  return pearlAddressScriptHex(value, 'testnet2');
}

function deriveChild(parent: Uint8Array, index: number, master: boolean): Uint8Array {
  const privateKey = parent.subarray(0, 32);
  const message = new Uint8Array(37);
  if (index >= hardened) {
    // Oyster uses DeriveNonStandard: hardened parents below the master depth
    // lose leading zeroes. The HMAC message keeps zero padding at the end.
    const offset = master ? 0 : privateKey.findIndex((byte) => byte !== 0);
    message.set(privateKey.subarray(offset), 1);
  } else {
    message.set(secp256k1.getPublicKey(privateKey));
  }
  new DataView(message.buffer).setUint32(33, index);
  const child = hmac(sha512, parent.subarray(32), message);
  message.fill(0);

  const tweak = bytesToNumberBE(child.subarray(0, 32));
  const scalar = (bytesToNumberBE(privateKey) + tweak) % curveOrder;
  if (tweak === 0n || tweak >= curveOrder || scalar === 0n) {
    child.fill(0);
    throw new Error('Unable to derive this wallet address.');
  }
  const scalarBytes = numberToBytesBE(scalar, 32);
  child.set(scalarBytes);
  scalarBytes.fill(0);
  return child;
}

function derivePath(secret: Uint8Array, path: readonly number[], master = false): Uint8Array {
  let node = secret;
  try {
    for (const index of path) {
      const child = deriveChild(node, index, master && node === secret);
      if (node !== secret) node.fill(0);
      node = child;
    }
    return node;
  } catch (error) {
    if (node !== secret) node.fill(0);
    throw error;
  }
}

function isGrainAmount(value: number, allowZero = false): boolean {
  return Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1);
}

function parsePrevout(prevout: PearlPrevout) {
  if (!txidPattern.test(prevout.txid) || !Number.isInteger(prevout.vout)
      || prevout.vout < 0 || prevout.vout > 0xffffffff || !isGrainAmount(prevout.amountGrains)
      || prevout.rawTxHex.length > maxRawTxHexLength) {
    throw new Error('The indexer returned an invalid previous output.');
  }

  const raw = hex.decode(prevout.rawTxHex);
  const transaction = Transaction.fromRaw(raw, { allowUnknownOutputs: true, allowUnknownVersion: true });
  if (transaction.id !== prevout.txid.toLowerCase() || prevout.vout >= transaction.outputsLength) {
    throw new Error('The previous transaction does not match the selected output.');
  }

  const output = transaction.getOutput(prevout.vout);
  if (output.amount !== BigInt(prevout.amountGrains) || !output.script
      || hex.encode(output.script) !== prevout.scriptHex.toLowerCase()) {
    throw new Error('The previous output amount or script could not be verified.');
  }

  const firstInput = transaction.getInput(0);
  const coinbase = transaction.inputsLength === 1 && firstInput.index === 0xffffffff
    && firstInput.txid !== undefined && hex.encode(firstInput.txid) === coinbaseParent;
  return { raw, script: output.script, amount: output.amount, coinbase };
}

export function verifyPearlPrevout(prevout: PearlPrevout): { coinbase: boolean } {
  return { coinbase: parsePrevout(prevout).coinbase };
}

export function estimatePaymentVsize(inputCount: number, hasChange: boolean, extraOutputs = 0): number {
  if (!Number.isInteger(inputCount) || inputCount < 1 || inputCount > 0xffffffff) {
    throw new Error('Select at least one valid input.');
  }
  const inputCountBytes = inputCount < 253 ? 1 : inputCount <= 0xffff ? 3 : 5;
  if (!Number.isInteger(extraOutputs) || extraOutputs < 0 || extraOutputs > 1) throw new Error('Unsupported payment outputs.');
  const outputCount = (hasChange ? 2 : 1) + extraOutputs;
  // Version, locktime, CompactSize counts, P2TR inputs and 32-byte witness program outputs.
  const baseBytes = 8 + inputCountBytes + 1 + 41 * inputCount + 43 * outputCount;
  // Marker + flag, then a one-item witness containing a 64-byte Schnorr signature per input.
  return Math.ceil((4 * baseBytes + 2 + 66 * inputCount) / 4);
}

export function openPearlWallet(value: string, network: PearlNetwork = 'testnet2'): PearlWallet {
  const { coinType, hrp } = pearlNetworks[network];
  const encoding = { ...TEST_NETWORK, bech32: hrp };
  const mnemonic = normalizeMnemonic(value);
  if (!mnemonic) throw new Error('Enter a valid English recovery phrase.');

  const seed = mnemonicToSeedSync(mnemonic);
  const master = hmac(sha512, asciiToBytes('Bitcoin seed'), seed);
  seed.fill(0);
  let account: Uint8Array;
  try {
    const scalar = bytesToNumberBE(master.subarray(0, 32));
    if (scalar === 0n || scalar >= curveOrder) throw new Error('Unable to open this wallet.');
    account = derivePath(master, [hardened + 86, hardened + coinType, hardened], true);
  } finally {
    master.fill(0);
  }

  let closed = false;

  function addressKey(branch: PearlBranch, index: number) {
    if (closed) throw new Error('This wallet session has closed.');
    if ((branch !== 0 && branch !== 1) || !Number.isInteger(index) || index < 0 || index >= hardened) {
      throw new Error('Invalid wallet address path.');
    }
    return derivePath(account, [branch, index]);
  }

  function addressPayment(branch: PearlBranch, index: number) {
    const key = addressKey(branch, index);
    try {
      return p2tr(schnorr.getPublicKey(key.subarray(0, 32)), undefined, encoding);
    } finally {
      key.fill(0);
    }
  }

  function signPayment(payment: PearlPayment): SignedPearlPayment {
    const { inputs, amountGrains, changeGrains, feeGrains, entropy } = payment;
    if (!isGrainAmount(amountGrains) || !isGrainAmount(changeGrains, true)
        || !isGrainAmount(feeGrains) || entropy.length !== 32) {
      throw new Error('The payment amounts or signing entropy are invalid.');
    }
    const tip = payment.tip;
    if (tip && !isGrainAmount(tip.amountGrains)) throw new Error('The payment amounts or signing entropy are invalid.');
    const expectedVsize = estimatePaymentVsize(inputs.length, changeGrains > 0, tip ? 1 : 0);
    const recipient = decodePearlAddress(payment.recipient, network);
    const tipOutput = tip ? decodePearlAddress(tip.address, network) : null;
    const change = changeGrains > 0
      ? addressPayment(payment.changeBranch ?? 0, payment.changeIndex ?? 0)
      : null;
    const transaction = new Transaction({
      version: 1,
      allowUnknownOutputs: true,
      strictPrevoutValidation: true,
    });
    const outpoints = new Set<string>();
    const prevouts = inputs.map((input) => {
      const outpoint = `${input.txid.toLowerCase()}:${input.vout}`;
      if (outpoints.has(outpoint)) throw new Error('A previous output was selected twice.');
      outpoints.add(outpoint);

      const verified = parsePrevout(input);
      const owned = addressPayment(input.branch ?? 0, input.index ?? 0);
      if (!equalBytes(owned.script, verified.script)) {
        throw new Error('The selected output does not belong to this wallet.');
      }
      transaction.addInput({
        txid: input.txid.toLowerCase(),
        index: input.vout,
        nonWitnessUtxo: verified.raw,
        tapInternalKey: owned.tapInternalKey,
        witnessUtxo: { amount: verified.amount, script: verified.script },
      });
      return verified;
    });

    transaction.addOutput({ script: recipient.script, amount: BigInt(amountGrains) });
    if (tip && tipOutput) transaction.addOutput({ script: tipOutput.script, amount: BigInt(tip.amountGrains) });
    if (change) transaction.addOutput({ script: change.script, amount: BigInt(changeGrains) });
    if (transaction.fee !== BigInt(feeGrains)) throw new Error('The payment fee has changed.');

    const scripts = prevouts.map((prevout) => prevout.script);
    const amounts = prevouts.map((prevout) => prevout.amount);
    for (const [position, input] of inputs.entries()) {
      const key = addressKey(input.branch ?? 0, input.index ?? 0);
      const aux = hmac(sha256, entropy, numberToBytesBE(position, 4));
      try {
        transaction.signIdx(key.subarray(0, 32), position, [SigHash.DEFAULT], aux);
        const signature = transaction.getInput(position).tapKeySig;
        const digest = transaction.preimageWitnessV1(position, scripts, SigHash.DEFAULT, amounts);
        if (!signature || !schnorr.verify(signature, digest, scripts[position].subarray(2))) {
          throw new Error('Unable to verify the transaction signature.');
        }
      } finally {
        key.fill(0);
        aux.fill(0);
      }
    }

    transaction.finalize();
    if (transaction.vsize !== expectedVsize) throw new Error('The payment size has changed.');
    return { txid: transaction.id, hex: transaction.hex, vsize: transaction.vsize };
  }

  return {
    watchKey: () => {
      if (closed) throw new Error('This wallet session has closed.');
      return encodeWatchKey(secp256k1.getPublicKey(account.subarray(0, 32)), account.subarray(32), network);
    },
    address: (branch = 0, index = 0) => addressPayment(branch, index).address,
    scriptHex: (branch = 0, index = 0) => hex.encode(addressPayment(branch, index).script),
    signPayment,
    close: () => {
      account.fill(0);
      closed = true;
    },
  };
}

/**
 * Watch keys: the account-level public key and chain code (m/86'/coin'/0'),
 * bech32m-encoded with a network prefix. They reveal every address of the
 * wallet but cannot spend.
 */
const watchKeyLimit = 200;

function watchKeyPrefix(network: PearlNetwork) {
  return pearlNetworks[network].hrp + 'watch';
}

function encodeWatchKey(publicKey: Uint8Array, chainCode: Uint8Array, network: PearlNetwork): string {
  const payload = new Uint8Array(65);
  payload.set(publicKey);
  payload.set(chainCode, 33);
  return bech32m.encode(watchKeyPrefix(network), bech32m.toWords(payload), watchKeyLimit);
}

/** The normalized watch key, or null if it is not a valid key for this network. */
export function validateWatchKey(value: string, network: PearlNetwork): string | null {
  try {
    const { prefix, words } = bech32m.decode(value.trim().toLowerCase() as `${string}1${string}`, watchKeyLimit);
    const payload = bech32m.fromWords(words);
    if (prefix !== watchKeyPrefix(network) || payload.length !== 65) return null;
    secp256k1.Point.fromBytes(payload.subarray(0, 33));
    return bech32m.encode(prefix, words, watchKeyLimit);
  } catch {
    return null;
  }
}

/** Derive a receive-branch Taproot address from a watch key (public derivation). */
export function watchKeyAddress(
  watchKey: string,
  network: PearlNetwork,
  index: number,
  branch: PearlBranch = 0,
): { address: string; scriptHex: string } {
  const normalized = validateWatchKey(watchKey, network);
  if (!normalized) throw new Error('This watch key is not valid for Pearl ' + pearlNetworks[network].label + '.');
  if (!Number.isInteger(index) || index < 0 || index >= hardened) throw new Error('Invalid wallet address path.');
  const payload = bech32m.fromWords(bech32m.decode(normalized as `${string}1${string}`, watchKeyLimit).words);
  let publicKey: Uint8Array = payload.subarray(0, 33);
  let chainCode: Uint8Array = payload.subarray(33);
  for (const step of [branch, index]) {
    const message = new Uint8Array(37);
    message.set(publicKey);
    new DataView(message.buffer).setUint32(33, step);
    const child = hmac(sha512, chainCode, message);
    const tweak = bytesToNumberBE(child.subarray(0, 32));
    if (tweak === 0n || tweak >= curveOrder) throw new Error('Unable to derive this wallet address.');
    const point = secp256k1.Point.fromBytes(publicKey).add(secp256k1.Point.BASE.multiply(tweak));
    publicKey = point.toBytes(true);
    chainCode = child.subarray(32);
  }
  const payment = p2tr(publicKey.subarray(1), undefined, { ...TEST_NETWORK, bech32: pearlNetworks[network].hrp });
  return { address: payment.address!, scriptHex: hex.encode(payment.script) };
}
