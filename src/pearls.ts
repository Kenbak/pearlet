/**
 * A "pearl" is one unspent output of the wallet. Coinbase pearls ripen:
 * they become spendable after the network's coinbase maturity.
 */
export type WalletPearl = {
  id: string;
  txid: string;
  vout: number;
  valueGrains: number;
  confirmations: number;
  height: number;
  /** 0 is the receive address, 1 the mining payout address. */
  chain: number;
  /** null when the parent transaction was not checked (it is older than maturity). */
  coinbase: boolean | null;
  /** Blocks left before a coinbase pearl can be spent; 0 when ripe. */
  blocksToRipe: number;
};

export type MiningSummary = {
  ripening: WalletPearl[];
  ripeningGrains: number;
  /** Spendable PRL on the mining payout address. */
  ripeGrains: number;
  /** Payouts still unspent that arrived within `windowBlocks`. */
  recentGrains: number;
  recentCount: number;
  windowBlocks: number;
  tipHeight: number;
  difficulty: number | null;
};

type PearlInput = {
  txid: string;
  vout: number;
  valueGrains: bigint;
  confirmations: number;
  height: number;
  coinbase?: boolean;
  index?: number;
};

export function describePearls(
  utxos: readonly PearlInput[],
  coinbaseByTxid: ReadonlyMap<string, boolean>,
  maturity: number,
): WalletPearl[] {
  return utxos
    .filter(utxo => utxo.confirmations > 0 && utxo.valueGrains > 0n)
    .map(utxo => {
      const coinbase = coinbaseByTxid.get(utxo.txid) ?? utxo.coinbase ?? null;
      return {
        id: utxo.txid + ':' + utxo.vout,
        txid: utxo.txid,
        vout: utxo.vout,
        valueGrains: Number(utxo.valueGrains),
        confirmations: utxo.confirmations,
        height: utxo.height,
        chain: utxo.index ?? 0,
        coinbase,
        blocksToRipe: coinbase ? Math.max(0, maturity - utxo.confirmations) : 0,
      };
    })
    .sort((left, right) => right.valueGrains - left.valueGrains || left.id.localeCompare(right.id));
}

/** Share of the maturity a pearl has reached, from 0 to 1. */
export function ripeness(pearl: WalletPearl, maturity: number): number {
  if (!pearl.coinbase) return 1;
  return Math.min(1, Math.max(0, pearl.confirmations / maturity));
}

export function summarizeMining(
  pearls: readonly WalletPearl[],
  tipHeight: number,
  difficulty: number | null,
  windowBlocks = 720,
): MiningSummary {
  const ripening = pearls.filter(pearl => pearl.blocksToRipe > 0)
    .sort((left, right) => left.blocksToRipe - right.blocksToRipe || left.id.localeCompare(right.id));
  const payouts = pearls.filter(pearl => pearl.chain === 1 || pearl.coinbase === true);
  const recent = payouts.filter(pearl => pearl.height > tipHeight - windowBlocks);
  return {
    ripening,
    ripeningGrains: ripening.reduce((total, pearl) => total + pearl.valueGrains, 0),
    ripeGrains: pearls.filter(pearl => pearl.chain === 1 && pearl.blocksToRipe === 0)
      .reduce((total, pearl) => total + pearl.valueGrains, 0),
    recentGrains: recent.reduce((total, pearl) => total + pearl.valueGrains, 0),
    recentCount: recent.length,
    windowBlocks,
    tipHeight,
    difficulty,
  };
}

/** Compact difficulty, e.g. 65.1 M. */
export function formatDifficulty(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return 'Unavailable';
  const units = [[1e12, ' T'], [1e9, ' G'], [1e6, ' M'], [1e3, ' k']] as const;
  for (const [size, suffix] of units) {
    if (value >= size) return (value / size).toFixed(value / size >= 100 ? 0 : 1) + suffix;
  }
  return value.toFixed(0);
}
