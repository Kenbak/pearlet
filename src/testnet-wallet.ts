import {
  getAddressUtxos,
  getFeeRate,
  getPearlTip,
  getTransaction,
  getWalletAddressState,
  hasAddressHistory,
  PearlTransactionNotFoundError,
  type PearlActivity,
  type PearlTransaction,
  type PearlUtxo,
} from './pearl-indexer.ts';
import {
  estimatePaymentVsize,
  pearlAddressScriptHex,
  validatePearlAddress,
  verifyPearlPrevout,
  watchKeyAddress,
  type PearlSpendInput,
} from './pearl-keys.ts';
import { pearlNetworks, type PearlNetwork } from './pearl-network.ts';
import { supportAddress, supportTipGrains } from './support.ts';
import { describePearls, summarizeMining, type MiningSummary, type WalletPearl } from './pearls.ts';

const grainsPerPrl = 100_000_000;
const dustGrains = 333;
const maxStandardVsize = 100_000;

export type WalletActivity = {
  id: string;
  kind: 'send' | 'receive' | 'self';
  title: string;
  subtitle: string;
  amountGrains: number;
  feeGrains?: number;
  recipient?: string;
};

export type PreparedSend = {
  recipient: string;
  amountGrains: number;
  feeGrains: number;
  /** Optional tip to Pearlet, paid as a second output. */
  tipGrains?: number;
};

export type PendingSend = PreparedSend & { txid: string };

export type SendOutcome =
  | { status: 'accepted' | 'unknown'; txid: string }
  | { status: 'rejected'; message: string };

export type WalletSnapshot = {
  balanceGrains: number;
  unconfirmedGrains: number;
  spendableGrains: number | null;
  activity: WalletActivity[];
  networkReady: boolean;
  /** Wallet addresses that have any history. */
  usedAddresses: string[];
  /** Confirmed unspent outputs, largest first. */
  pearls: WalletPearl[];
  /** Mainnet only: payouts, ripening coinbase and network difficulty. */
  mining: MiningSummary | null;
};

export type WalletIdentity = {
  network: PearlNetwork;
  address: string;
  scriptHex: string;
  miningAddress?: string;
  miningScriptHex?: string;
  /** Account public key; derives fresh receive addresses at index 2 and up. */
  watchKey?: string;
  /** Highest receive index issued (0 when only the first address is in use). */
  receiveIndex?: number;
  watchOnly?: boolean;
};

/** BIP 44's usual gap limit: restore stops after this many unused addresses in a row. */
export const receiveGapLimit = 20;
/** The first fresh receive index; index 1 is the mining payout address. */
export const firstFreshIndex = 2;

export type SpendPlan = PreparedSend & {
  identity: WalletIdentity;
  address: string;
  changeGrains: number;
  /** Where change returns: a fresh address when the wallet can derive one, else index 0. */
  changeIndex: number;
  changeAddress: string;
  inputs: readonly PearlSpendInput[];
  tip?: { address: string; amountGrains: number };
};

export type StoredPayment = PendingSend & {
  hex: string;
  address: string;
  /** Set when change returns to a fresh address instead of `address`. */
  changeAddress?: string;
  inputIds: string[];
};

export { pearlTestnetExplorer } from './pearl-indexer.ts';

export function formatPrl(grains: number, minimumFractionDigits = 0): string {
  const magnitude = Math.abs(grains);
  const remainder = magnitude % grainsPerPrl;
  const whole = (magnitude - remainder) / grainsPerPrl;
  const decimals = String(remainder).padStart(8, '0').replace(/0+$/, '').padEnd(minimumFractionDigits, '0');
  return (grains < 0 ? '−' : '') + whole.toLocaleString('en-US') + (decimals ? '.' + decimals : '');
}

function toSafeGrains(value: bigint): number {
  const grains = Number(value);
  if (!Number.isSafeInteger(grains)) throw new Error('The indexer returned an amount outside the supported range.');
  return grains;
}

function toActivity(activity: PearlActivity): WalletActivity {
  const direction = { send: 'Sent PRL', receive: 'Received PRL', self: 'Self transfer' };
  const date = activity.blockTime ? new Date(activity.blockTime * 1000).toLocaleDateString() : 'Unconfirmed';
  return {
    id: activity.txid,
    kind: activity.kind,
    title: direction[activity.kind],
    subtitle: activity.confirmations > 0 ? date : 'Unconfirmed',
    amountGrains: toSafeGrains(activity.amountGrains),
    feeGrains: activity.kind === 'receive' ? undefined : toSafeGrains(activity.feeGrains),
    recipient: activity.counterparty ?? undefined,
  };
}

export function outpointId(input: { txid: string; vout: number }): string {
  return input.txid + ':' + input.vout;
}

const derivedAddresses = new Map<string, { address: string; scriptHex: string }>();

/** A fresh receive address derived from the wallet's watch key (cached). */
export function freshAddress(identity: WalletIdentity, index: number): { address: string; scriptHex: string } {
  if (!identity.watchKey) throw new Error('This wallet cannot derive new addresses yet.');
  const id = identity.network + ':' + identity.watchKey + ':' + index;
  let derived = derivedAddresses.get(id);
  if (!derived) {
    derived = watchKeyAddress(identity.watchKey, identity.network, index);
    derivedAddresses.set(id, derived);
  }
  return derived;
}

/** The receive address to show now. */
export function currentReceiveAddress(identity: WalletIdentity): string {
  const index = identity.receiveIndex ?? 0;
  return index >= firstFreshIndex ? freshAddress(identity, index).address : identity.address;
}

/**
 * Change goes to the address after the newest one issued, so a send does not
 * tie the first address to the rest of the wallet. Older profiles without a
 * watch key keep using the first address.
 */
export function changeTarget(identity: WalletIdentity): { index: number; address: string } {
  if (!identity.watchKey) return { index: 0, address: identity.address };
  const index = Math.max(firstFreshIndex, (identity.receiveIndex ?? 0) + 1);
  return { index, address: freshAddress(identity, index).address };
}

export function walletAddresses(identity: WalletIdentity) {
  const { network, address, scriptHex, miningAddress, miningScriptHex } = identity;
  const addresses = [{ address, scriptHex, index: 0 }];
  if (network === 'mainnet' && !(identity.watchOnly && !miningAddress)) {
    if (!miningAddress || !miningScriptHex || address === miningAddress) {
      throw new Error('This wallet has no mining payout address.');
    }
    addresses.push({ address: miningAddress, scriptHex: miningScriptHex, index: 1 });
  }
  for (let index = firstFreshIndex; index <= (identity.receiveIndex ?? 0); index += 1) {
    addresses.push({ ...freshAddress(identity, index), index });
  }

  for (const owned of addresses) {
    if (pearlAddressScriptHex(owned.address, network) !== owned.scriptHex) {
      throw new Error('The wallet address does not match its output script.');
    }
  }

  return addresses;
}

async function getWalletUtxos(identity: WalletIdentity, signal?: AbortSignal) {
  const groups = await Promise.all(walletAddresses(identity).map(async owned => {
    const utxos = await getAddressUtxos(owned.address, signal, identity.network);
    return utxos.map(utxo => ({ ...utxo, index: owned.index, scriptHex: owned.scriptHex }));
  }));
  const utxos = groups.flat();
  if (new Set(utxos.map(outpointId)).size !== utxos.length) {
    throw new Error('The indexer returned duplicate spendable outputs.');
  }
  return utxos;
}

function confirmedUtxos<T extends PearlUtxo>(utxos: readonly T[]): T[] {
  return utxos.filter(utxo => utxo.confirmations > 0 && utxo.valueGrains > 0n);
}

function isMature(utxo: PearlUtxo, coinbase: boolean, network: PearlNetwork) {
  return !coinbase || utxo.confirmations >= pearlNetworks[network].coinbaseMaturity;
}

export async function loadWalletSnapshot(
  identity: WalletIdentity,
  signal?: AbortSignal,
  activityLimit?: number,
): Promise<WalletSnapshot> {
  const { network } = identity;
  const addresses = walletAddresses(identity).map(owned => owned.address);
  const [state, tip, utxos] = await Promise.all([
    getWalletAddressState(network, addresses, signal, activityLimit),
    getPearlTip(network, signal),
    getWalletUtxos(identity, signal),
  ]);
  const networkReady = tip.inSync && tip.inSyncMempool;
  const confirmed = confirmedUtxos(utxos);
  let spendableGrains: number | null = null;
  const coinbaseByTxid = new Map<string, boolean>();

  if (networkReady) {
    const recentIds = [...new Set(confirmed
      .filter(utxo => utxo.confirmations < pearlNetworks[network].coinbaseMaturity)
      .map(utxo => utxo.txid))];
    const recentParents = new Map<string, PearlTransaction>();

    try {
      for (let offset = 0; offset < recentIds.length; offset += 5) {
        const parents = await Promise.all(recentIds.slice(offset, offset + 5)
          .map(txid => getTransaction(txid, signal, network)));
        for (const parent of parents) recentParents.set(parent.txid, parent);
      }
      for (const parent of recentParents.values()) coinbaseByTxid.set(parent.txid, parent.coinbase);
      spendableGrains = toSafeGrains(confirmed.reduce((total, utxo) => {
        const parent = recentParents.get(utxo.txid);
        if (parent && (parent.confirmations < 1 || !isMature(utxo, parent.coinbase, network))) return total;
        return total + utxo.valueGrains;
      }, 0n));
    } catch {
      if (signal?.aborted) throw new Error('Wallet refresh cancelled.');
    }
  }

  const pearls = describePearls(confirmed, coinbaseByTxid, pearlNetworks[network].coinbaseMaturity);
  return {
    balanceGrains: toSafeGrains(state.balanceGrains),
    unconfirmedGrains: toSafeGrains(state.unconfirmedGrains),
    spendableGrains,
    activity: state.activity.map(toActivity),
    networkReady,
    usedAddresses: state.usedAddresses,
    pearls,
    mining: network === 'mainnet' ? summarizeMining(pearls, tip.height, tip.difficulty) : null,
  };
}

export function parseSendAmount(value: string): number {
  const decimal = value.trim();
  if (!/^(?:[0-9]{1,16}(?:\.[0-9]{0,8})?|\.[0-9]{1,8})$/.test(decimal)) {
    throw new Error('Enter a PRL amount with up to 8 decimal places.');
  }
  const [whole, fraction = ''] = decimal.split('.');
  const grains = BigInt(whole || '0') * BigInt(grainsPerPrl) + BigInt(fraction.padEnd(8, '0'));
  if (grains > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('This PRL amount is too large.');
  if (grains < BigInt(dustGrains)) throw new Error('Enter at least ' + formatPrl(dustGrains) + ' PRL.');
  return Number(grains);
}

export function selectPayment(
  amounts: readonly number[],
  amountGrains: number,
  feeRate: number,
  network: PearlNetwork = 'testnet2',
  extraOutputs = 0,
): { count: number; feeGrains: number; changeGrains: number } | null {
  if (!Number.isSafeInteger(feeRate) || feeRate < 1 || feeRate > pearlNetworks[network].maxFeeRate) {
    throw new Error('The indexer returned an unexpected fee rate. Refresh and try again.');
  }

  let total = 0;
  for (const [index, value] of amounts.entries()) {
    total += value;
    if (!Number.isSafeInteger(total)) throw new Error('The total inputs exceed the supported amount range.');
    const count = index + 1;
    const withChange = estimatePaymentVsize(count, true, extraOutputs);
    if (withChange > maxStandardVsize) break;

    const changeGrains = total - amountGrains - withChange * feeRate;
    if (changeGrains >= dustGrains) {
      return { count, feeGrains: withChange * feeRate, changeGrains };
    }
    const remaining = total - amountGrains;
    if (remaining >= estimatePaymentVsize(count, false, extraOutputs) * feeRate) {
      return { count, feeGrains: remaining, changeGrains: 0 };
    }
  }
  return null;
}

/** How soon the transfer should confirm; picks Blockbook's fee estimate target. */
export type FeeSpeed = 'slow' | 'normal' | 'fast';
export const feeSpeedBlocks: Record<FeeSpeed, 1 | 2 | 6> = { fast: 1, normal: 2, slow: 6 };

export async function preparePayment(
  identity: WalletIdentity,
  recipientInput: string,
  amountInput: string,
  signal?: AbortSignal,
  speed: FeeSpeed = 'normal',
  chosenPearls?: readonly string[],
  withTip = false,
): Promise<SpendPlan> {
  const { address, network, miningAddress } = identity;
  const { label, hrp, coinbaseMaturity } = pearlNetworks[network];
  const recipient = validatePearlAddress(recipientInput, network);
  if (!recipient) throw new Error(`Enter a valid Pearl ${label} address beginning with ${hrp}1.`);
  if (identity.watchOnly) throw new Error('This is a watch-only wallet. Send from the wallet that holds its recovery phrase.');
  if (walletAddresses(identity).some(owned => owned.address === recipient)) {
    throw new Error(`Choose another ${label} wallet as the recipient.`);
  }
  const amountGrains = parseSendAmount(amountInput);
  const tipGrains = withTip && network === 'mainnet' && recipient !== supportAddress ? supportTipGrains(amountGrains) : 0;
  const tipOutput = tipGrains ? { address: supportAddress, amountGrains: tipGrains } : undefined;
  const outputTotal = amountGrains + tipGrains;
  const extraOutputs = tipOutput ? 1 : 0;
  const [tip, utxos, feeRate] = await Promise.all([
    getPearlTip(network, signal),
    getWalletUtxos(identity, signal),
    getFeeRate(signal, network, feeSpeedBlocks[speed]),
  ]);
  if (!tip.inSync || !tip.inSyncMempool) throw new Error(`The ${label} indexer is still syncing. Try again shortly.`);

  const chosen = chosenPearls?.length ? new Set(chosenPearls) : null;
  const candidates = confirmedUtxos(utxos)
    .filter(utxo => isMature(utxo, utxo.coinbase, network))
    .filter(utxo => !chosen || chosen.has(outpointId(utxo)))
    .sort((left, right) => left.valueGrains === right.valueGrains
      ? outpointId(left).localeCompare(outpointId(right))
      : left.valueGrains > right.valueGrains ? -1 : 1);
  const parents = new Map<string, PearlTransaction>();
  const change = changeTarget(identity);
  if (change.address === recipient) throw new Error(`Choose another ${label} wallet as the recipient.`);
  const inputs: PearlSpendInput[] = [];
  const amounts: number[] = [];

  if (chosen && candidates.length !== chosen.size) {
    throw new Error('Some chosen pearls are no longer spendable. Choose again.');
  }
  if (!selectPayment(candidates.map(utxo => toSafeGrains(utxo.valueGrains)), outputTotal, feeRate, network, extraOutputs)) {
    throw new Error(chosen
      ? 'The chosen pearls cannot cover the amount and fee.'
      : `Your confirmed ${label} balance cannot cover the amount and fee.`);
  }

  for (const candidate of candidates) {
    let parent = parents.get(candidate.txid);
    if (!parent) {
      parent = await getTransaction(candidate.txid, signal, network);
      parents.set(parent.txid, parent);
    }

    const input = {
      txid: candidate.txid,
      vout: candidate.vout,
      amountGrains: toSafeGrains(candidate.valueGrains),
      scriptHex: candidate.scriptHex,
      rawTxHex: parent.hex,
      index: candidate.index,
    };
    const { coinbase } = verifyPearlPrevout(input);
    const confirmations = Math.min(candidate.confirmations, parent.confirmations);
    if (confirmations < 1 || (coinbase && confirmations < coinbaseMaturity)) continue;

    inputs.push(input);
    amounts.push(input.amountGrains);
    const selection = selectPayment(amounts, outputTotal, feeRate, network, extraOutputs);
    if (selection) return {
      identity,
      address,
      recipient,
      amountGrains,
      ...(tipOutput ? { tip: tipOutput, tipGrains } : {}),
      feeGrains: selection.feeGrains,
      changeGrains: selection.changeGrains,
      changeIndex: change.index,
      changeAddress: change.address,
      inputs,
    };
  }
  throw new Error(`Your spendable ${label} balance cannot cover the amount and fee.`);
}

export async function verifyInputsStillAvailable(plan: SpendPlan, signal?: AbortSignal): Promise<void> {
  const { identity } = plan;
  const { network } = identity;
  const [tip, utxos] = await Promise.all([
    getPearlTip(network, signal),
    getWalletUtxos(identity, signal),
  ]);
  if (!tip.inSync || !tip.inSyncMempool) {
    throw new Error(`The ${pearlNetworks[network].label} indexer is still syncing. Try again shortly.`);
  }
  const available = new Map(confirmedUtxos(utxos).map(input => [outpointId(input), input]));
  for (const input of plan.inputs) {
    const current = available.get(outpointId(input));
    const { coinbase } = verifyPearlPrevout(input);
    if (!current || current.valueGrains !== BigInt(input.amountGrains)
        || current.scriptHex !== input.scriptHex || current.index !== (input.index ?? 0)
        || !isMature(current, coinbase, network)) {
      throw new Error('The spendable coins changed. Create a new review before sending.');
    }
  }
}

export async function isPaymentIndexed(
  payment: StoredPayment,
  identity: WalletIdentity,
  signal?: AbortSignal,
): Promise<boolean> {
  if (payment.address !== identity.address) throw new Error('This transfer belongs to another wallet.');
  try {
    const tx = await getTransaction(payment.txid, signal, identity.network);
    if (tx.hex.toLowerCase() !== payment.hex) return false;
    if (tx.confirmations > 0) return true;
    const utxos = await getWalletUtxos(identity, signal);
    const available = new Set(utxos.map(outpointId));
    return payment.inputIds.every(id => !available.has(id));
  } catch (error) {
    if (error instanceof PearlTransactionNotFoundError) return false;
    throw error;
  }
}

/**
 * Restore scan: check fresh receive addresses from index 2 until
 * `receiveGapLimit` unused ones in a row, and return the highest used index
 * (0 when none are used).
 */
export async function discoverReceiveIndex(identity: WalletIdentity, signal?: AbortSignal): Promise<number> {
  if (!identity.watchKey) return 0;
  let highest = 0;
  let index = firstFreshIndex;
  const batch = 5;
  // Keep going until the last `receiveGapLimit` checked addresses are all unused.
  while (index <= Math.max(highest, firstFreshIndex - 1) + receiveGapLimit) {
    const indices = Array.from({ length: batch }, (_, offset) => index + offset);
    const used = await Promise.all(indices.map(i =>
      hasAddressHistory(identity.network, freshAddress(identity, i).address, signal)));
    used.forEach((wasUsed, offset) => {
      if (wasUsed) highest = indices[offset];
    });
    index += batch;
    if (index > 100_000) break;
  }
  return highest;
}
