export type PearlNetwork = 'mainnet' | 'testnet2';

export const defaultPearlNetwork: PearlNetwork = 'mainnet';

// Pearl's chaincfg defines the network prefixes, coin types and coinbase maturity.
// https://github.com/pearl-research-labs/pearl/blob/master/node/chaincfg/params.go
export const pearlNetworks = {
  mainnet: {
    label: 'Mainnet',
    hrp: 'prl',
    coinType: 808276,
    explorer: 'https://blockbook.pearlnetwork.net',
    indexerCoin: 'Pearl',
    coinbaseMaturity: 100,
    maxFeeRate: 10_000,
  },
  testnet2: {
    label: 'Testnet2',
    hrp: 'tprl',
    coinType: 1,
    explorer: 'https://blockbook.testnet2.pearlnetwork.net',
    indexerCoin: 'Pearl Testnet2',
    coinbaseMaturity: 100,
    maxFeeRate: 1_000,
  },
} as const;
