import { pearlNetworks, type PearlNetwork } from './pearl-network.ts';

export const pearlTestnetExplorer = pearlNetworks.testnet2.explorer;

const requestTimeoutMs = 15_000;
const addressPrograms = /^[pz][qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/;
export const historyPageSize = 15;
const maxHistoryPageSize = 1000;
const txidPattern = /^[0-9a-f]{64}$/;
const hexPattern = /^[0-9a-f]+$/;

export type PearlTip = {
  height: number;
  inSync: boolean;
  inSyncMempool: boolean;
  /** Network difficulty from the node, when the indexer reports it. */
  difficulty: number | null;
};

export type PearlActivity = {
  txid: string;
  kind: 'send' | 'receive' | 'self';
  amountGrains: bigint;
  feeGrains: bigint;
  confirmations: number;
  blockTime: number | null;
  counterparty: string | null;
};

export type PearlAddressState = {
  balanceGrains: bigint;
  unconfirmedGrains: bigint;
  activity: PearlActivity[];
  /** Addresses with at least one transaction, confirmed or not. */
  usedAddresses: string[];
};

export type PearlUtxo = {
  txid: string;
  vout: number;
  valueGrains: bigint;
  confirmations: number;
  height: number;
  coinbase: boolean;
};

export type PearlTransaction = {
  txid: string;
  hex: string;
  confirmations: number;
  coinbase: boolean;
  outputs: {
    n: number;
    valueGrains: bigint;
    scriptHex: string;
    addresses: string[];
  }[];
};

export type BroadcastResult =
  | { status: 'accepted'; txid: string }
  | { status: 'rejected' | 'unknown'; txid: string; message: string };

export class PearlTransactionNotFoundError extends Error {
  readonly txid: string;

  constructor(txid: string) {
    super('Pearl has not indexed this transaction.');
    this.name = 'PearlTransactionNotFoundError';
    this.txid = txid;
  }
}

class PearlHttpError extends Error {
  readonly status: number;
  readonly detail: string | null;

  constructor(status: number, detail: string | null) {
    super(`The Pearl indexer returned HTTP ${status}.`);
    this.status = status;
    this.detail = detail;
  }
}

function invalidData(): never {
  throw new Error('The Pearl indexer returned unexpected data.');
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidData();
  return value as Record<string, unknown>;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : invalidData();
}

function asInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalidData();
  return value;
}

function asBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalidData();
}

function asGrains(value: unknown, signed = false): bigint {
  const pattern = signed ? /^-?\d{1,19}$/ : /^\d{1,19}$/;
  if (typeof value !== 'string' || !pattern.test(value)) return invalidData();
  return BigInt(value);
}

function asTxid(value: unknown): string {
  if (typeof value !== 'string' || !txidPattern.test(value)) return invalidData();
  return value;
}

function asHex(value: unknown, empty = false): string {
  if (empty && value === '') return value;
  if (typeof value !== 'string' || value.length % 2 !== 0 || !hexPattern.test(value)) return invalidData();
  return value;
}

function isNetworkAddress(address: string, hrp: string): boolean {
  const prefix = hrp + '1';
  return address.startsWith(prefix) && addressPrograms.test(address.slice(prefix.length));
}

function requireNetworkAddress(address: string, network: PearlNetwork): void {
  const { hrp, label } = pearlNetworks[network];
  if (!isNetworkAddress(address, hrp)) {
    throw new Error(`Enter a Pearl ${label} address beginning with ${hrp}1.`);
  }
}

function asAddresses(value: unknown): string[] {
  if (value === undefined) return [];
  return asList(value).map((address) => {
    if (typeof address !== 'string') return invalidData();
    return address;
  });
}

function readErrorDetail(body: unknown): string | null {
  if (!body || typeof body !== 'object' || !('error' in body)) return null;
  return typeof body.error === 'string' ? body.error.slice(0, 512) : null;
}

async function request(
  network: PearlNetwork,
  path: string,
  signal?: AbortSignal,
  rawTransaction?: string,
): Promise<unknown> {
  if (signal?.aborted) throw new Error('Pearl request canceled.');

  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, requestTimeoutMs);
  try {
    const url = pearlNetworks[network].explorer + '/api/v2' + path;
    const options: RequestInit & { redirect: 'error' } = {
      method: rawTransaction === undefined ? 'GET' : 'POST',
      headers: rawTransaction === undefined
        ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'text/plain' },
      body: rawTransaction,
      redirect: 'error',
      signal: controller.signal,
    };
    const response = await fetch(url, options);

    if (response.url && response.url !== url) {
      throw new Error('Unexpected Pearl indexer redirect.');
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new PearlHttpError(response.status, readErrorDetail(body));
    if (body === null) return invalidData();
    return body;
  } catch (error) {
    if (signal?.aborted) throw new Error('Pearl request canceled.');
    if (controller.signal.aborted) throw new Error('The Pearl indexer timed out.');
    if (error instanceof TypeError) throw new Error('Could not reach the Pearl indexer.');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function getPearlTip(network: PearlNetwork, signal?: AbortSignal): Promise<PearlTip> {
  const { label, indexerCoin } = pearlNetworks[network];
  const status = asObject(await request(network, '', signal));
  const blockbook = asObject(status.blockbook);
  const backend = asObject(status.backend);
  if (blockbook.coin !== indexerCoin || blockbook.decimals !== 8 || backend.chain !== network) {
    throw new Error(`The indexer did not identify itself as Pearl ${label}.`);
  }
  return {
    height: asInteger(blockbook.bestHeight),
    inSync: asBoolean(blockbook.inSync),
    inSyncMempool: asBoolean(blockbook.inSyncMempool),
    difficulty: readDifficulty(backend.difficulty),
  };
}

function readDifficulty(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : null;
}

function parseHistoryTransfer(
  transaction: Record<string, unknown>,
  ownedAddresses: ReadonlySet<string>,
  hrp: string,
): PearlActivity {
  let inputGrains = 0n;
  let outputGrains = 0n;
  let externalOutputGrains = 0n;
  const externalInputs = new Set<string>();
  const externalOutputs = new Set<string>();

  for (const value of asList(transaction.vin)) {
    const entry = asObject(value);
    const addresses = asAddresses(entry.addresses);
    if (addresses.some(address => ownedAddresses.has(address))) {
      inputGrains += asGrains(entry.value);
    } else {
      for (const candidate of addresses) {
        if (isNetworkAddress(candidate, hrp)) externalInputs.add(candidate);
      }
    }
  }

  for (const value of asList(transaction.vout)) {
    const entry = asObject(value);
    const amount = asGrains(entry.value);
    const addresses = asAddresses(entry.addresses);
    if (addresses.some(address => ownedAddresses.has(address))) {
      outputGrains += amount;
    } else if (amount > 0n) {
      externalOutputGrains += amount;
      for (const candidate of addresses) {
        if (isNetworkAddress(candidate, hrp)) externalOutputs.add(candidate);
      }
    }
  }

  const feeGrains = asGrains(transaction.fees);
  const netGrains = outputGrains - inputGrains;
  let kind: PearlActivity['kind'] = 'receive';
  let amountGrains = netGrains;
  let counterparties: ReadonlySet<string> = externalInputs;

  if (inputGrains > 0n && externalOutputGrains === 0n) {
    kind = 'self';
    amountGrains = outputGrains;
    counterparties = ownedAddresses;
  } else if (netGrains < 0n) {
    kind = 'send';
    const spendGrains = -netGrains;
    // Only subtract the full fee when this wallet supplied the transaction inputs.
    const fullInputGrains = asGrains(transaction.valueIn);
    amountGrains = fullInputGrains === inputGrains
      ? (spendGrains > feeGrains ? spendGrains - feeGrains : 0n)
      : spendGrains;
    counterparties = externalOutputs;
  }

  const blockTime = transaction.blockTime === undefined ? 0 : asInteger(transaction.blockTime);
  if (blockTime > 8_640_000_000_000) return invalidData();
  return {
    txid: asTxid(transaction.txid),
    kind,
    amountGrains,
    feeGrains,
    confirmations: asInteger(transaction.confirmations),
    blockTime: blockTime || null,
    counterparty: counterparties.size === 1 ? [...counterparties][0] : null,
  };
}

export function getTestnetTip(signal?: AbortSignal): Promise<PearlTip> {
  return getPearlTip('testnet2', signal);
}

export async function getWalletAddressState(
  network: PearlNetwork,
  addresses: readonly string[],
  signal?: AbortSignal,
  limit: number = historyPageSize,
): Promise<PearlAddressState> {
  const pageSize = Math.min(maxHistoryPageSize, Math.max(1, Math.floor(limit)));
  const ownedAddresses = new Set(addresses);
  if (!ownedAddresses.size) throw new Error('This wallet has no addresses.');
  const results = await Promise.all([...ownedAddresses].map(async address => {
    requireNetworkAddress(address, network);
    const value = asObject(await request(
      network,
      `/address/${address}?details=txslight&page=1&pageSize=${pageSize}`,
      signal,
    ));
    if (value.address !== address) return invalidData();
    return value;
  }));

  let balanceGrains = 0n;
  let unconfirmedGrains = 0n;
  const activityByTxid = new Map<string, PearlActivity>();
  const usedAddresses: string[] = [];

  for (const result of results) {
    if (addressWasUsed(result)) usedAddresses.push(result.address as string);
    balanceGrains += asGrains(result.balance);
    unconfirmedGrains += asGrains(result.unconfirmedBalance, true);
    const history = result.transactions === undefined ? [] : asList(result.transactions);
    for (const item of history) {
      const transaction = asObject(item);
      const activity = parseHistoryTransfer(transaction, ownedAddresses, pearlNetworks[network].hrp);
      const existing = activityByTxid.get(activity.txid);
      if (!existing || existing.confirmations > activity.confirmations) {
        activityByTxid.set(activity.txid, activity);
      }
    }
  }

  const activity = [...activityByTxid.values()]
    .sort((left, right) => left.confirmations - right.confirmations
      || (right.blockTime ?? 0) - (left.blockTime ?? 0))
    .slice(0, pageSize);
  return { balanceGrains, unconfirmedGrains, activity, usedAddresses };
}

function addressWasUsed(result: Record<string, unknown>): boolean {
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  return count(result.txs) || count(result.unconfirmedTxs)
    || (Array.isArray(result.transactions) && result.transactions.length > 0);
}

/** Whether an address has any history. Used for the gap-limit scan at restore. */
export async function hasAddressHistory(network: PearlNetwork, address: string, signal?: AbortSignal): Promise<boolean> {
  requireNetworkAddress(address, network);
  const value = asObject(await request(network, `/address/${address}?details=basic`, signal));
  if (value.address !== address) return invalidData();
  return addressWasUsed(value);
}

export function getAddressState(address: string, signal?: AbortSignal): Promise<PearlAddressState> {
  return getWalletAddressState('testnet2', [address], signal);
}

export async function getAddressUtxos(
  address: string,
  signal?: AbortSignal,
  network: PearlNetwork = 'testnet2',
): Promise<PearlUtxo[]> {
  requireNetworkAddress(address, network);
  // Blockbook only excludes mempool spends when querying with confirmed=false.
  const result = asList(await request(network, `/utxo/${address}?confirmed=false`, signal));
  const outpoints = new Set<string>();
  const confirmed: PearlUtxo[] = [];
  for (const value of result) {
    const output = asObject(value);
    const confirmations = asInteger(output.confirmations);
    if (confirmations === 0) continue;
    const txid = asTxid(output.txid);
    const vout = asInteger(output.vout);
    const height = asInteger(output.height);
    const outpoint = `${txid}:${vout}`;
    if (vout > 0xffffffff || outpoints.has(outpoint)) return invalidData();
    outpoints.add(outpoint);
    confirmed.push({
      txid,
      vout,
      height,
      confirmations,
      valueGrains: asGrains(output.value),
      // Some versions omit this flag even for mining rewards. Verify raw parents.
      coinbase: output.coinbase === undefined ? false : asBoolean(output.coinbase),
    });
  }
  return confirmed;
}

export async function getTransaction(
  txid: string,
  signal?: AbortSignal,
  network: PearlNetwork = 'testnet2',
): Promise<PearlTransaction> {
  asTxid(txid);
  let value: Record<string, unknown>;
  try {
    value = asObject(await request(network, `/tx/${txid}`, signal));
  } catch (error) {
    if (error instanceof PearlHttpError && (error.status === 400 || error.status === 404)
      && error.detail === `Transaction '${txid}' not found`) {
      throw new PearlTransactionNotFoundError(txid);
    }
    throw error;
  }
  if (value.txid !== txid) return invalidData();

  const inputs = asList(value.vin);
  const indexes = new Set<number>();
  const outputs = asList(value.vout).map((item) => {
    const output = asObject(item);
    const n = asInteger(output.n);
    if (n > 0xffffffff || indexes.has(n)) return invalidData();
    indexes.add(n);
    return {
      n,
      valueGrains: asGrains(output.value),
      scriptHex: output.hex === undefined ? '' : asHex(output.hex, true),
      addresses: asAddresses(output.addresses),
    };
  });
  return {
    txid,
    hex: asHex(value.hex),
    confirmations: asInteger(value.confirmations),
    coinbase: inputs.length === 1 && typeof asObject(inputs[0]).coinbase === 'string',
    outputs,
  };
}

export async function getFeeRate(
  signal?: AbortSignal,
  network: PearlNetwork = 'testnet2',
  targetBlocks: 1 | 2 | 6 = 2,
): Promise<number> {
  const result = asObject(await request(network, '/estimatefee/' + targetBlocks, signal)).result;
  // Blockbook v2 quotes PRL per 1,000 virtual bytes. Keep the conversion exact.
  if (typeof result !== 'string' || !/^\d{1,11}(?:\.\d{1,8})?$/.test(result)) {
    return invalidData();
  }
  const [whole, fraction = ''] = result.split('.');
  const grainsPerKvB = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  const grainsPerVByte = Number((grainsPerKvB + 999n) / 1_000n);
  if (!Number.isSafeInteger(grainsPerVByte) || grainsPerVByte < 1) return invalidData();
  return grainsPerVByte;
}

export async function broadcastPearlTransaction(
  network: PearlNetwork,
  hex: string,
  expectedTxid: string,
  signal?: AbortSignal,
): Promise<BroadcastResult> {
  asHex(hex);
  asTxid(expectedTxid);

  const tip = await getPearlTip(network, signal);
  if (!tip.inSync || !tip.inSyncMempool) {
    throw new Error(`Pearl ${pearlNetworks[network].label} is syncing. Your transaction was not submitted.`);
  }

  try {
    const result = asObject(await request(network, '/sendtx/', signal, hex));
    if (result.result === expectedTxid) return { status: 'accepted', txid: expectedTxid };
  } catch (error) {
    if (error instanceof PearlHttpError && error.status === 400 && error.detail
      && /^-(?:22|26): /i.test(error.detail)
      && !/(already|duplicate|spent|missing|orphan)/i.test(error.detail)) {
      return { status: 'rejected', txid: expectedTxid, message: error.detail.replace(/^-\d+: /, '') };
    }
  }

  // The node could have accepted the signed bytes before the response was lost.
  // A not-found result alone doesn't rule out pending indexing or propagation.
  if (!signal?.aborted) {
    try {
      await getTransaction(expectedTxid, signal, network);
      return { status: 'accepted', txid: expectedTxid };
    } catch {
      // Keep the locally signed transaction available for status checks or rebroadcast.
    }
  }
  return {
    status: 'unknown',
    txid: expectedTxid,
    message: 'The indexer has not confirmed receipt. Check this transaction before sending again.',
  };
}

export function broadcastTestnetTransaction(
  hex: string,
  expectedTxid: string,
  signal?: AbortSignal,
): Promise<BroadcastResult> {
  return broadcastPearlTransaction('testnet2', hex, expectedTxid, signal);
}
