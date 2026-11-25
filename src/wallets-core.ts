/** The wallets saved for one network, in the order the user sees them. */
export type WalletEntry = { id: string; name: string; watchOnly?: boolean };

export const mainWalletId = 'main';
export const maxWallets = 20;
export const maxWalletName = 32;
const idPattern = /^[a-z0-9]{1,24}$/;

export function defaultWalletList(): WalletEntry[] {
  return [{ id: mainWalletId, name: 'Main wallet' }];
}

export function parseWalletList(raw: string | null): WalletEntry[] {
  if (!raw) return defaultWalletList();
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return defaultWalletList();
    const seen = new Set<string>();
    const list: WalletEntry[] = [];
    for (const entry of value) {
      if (!entry || typeof entry.id !== 'string' || !idPattern.test(entry.id) || seen.has(entry.id)) continue;
      const name = typeof entry.name === 'string' ? cleanName(entry.name) : '';
      seen.add(entry.id);
      list.push({ id: entry.id, name: name || 'Wallet', ...(entry.watchOnly === true ? { watchOnly: true } : {}) });
    }
    return list.slice(0, maxWallets);
  } catch {
    return defaultWalletList();
  }
}

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, maxWalletName);
}

/** A name not yet used in the list, such as "Wallet 2" or "Watched wallet". */
export function suggestWalletName(list: readonly WalletEntry[], watchOnly: boolean): string {
  const base = watchOnly ? 'Watched wallet' : 'Wallet';
  const names = new Set(list.map(entry => entry.name));
  if (!names.has(base) && watchOnly) return base;
  for (let number = 2; ; number += 1) {
    if (!names.has(base + ' ' + number)) return base + ' ' + number;
  }
}

export function addWalletEntry(list: readonly WalletEntry[], id: string, name: string, watchOnly = false): WalletEntry[] {
  if (!idPattern.test(id)) throw new Error('Unknown wallet.');
  if (list.some(entry => entry.id === id)) {
    return list.map(entry => entry.id === id ? { ...entry, ...(watchOnly ? { watchOnly } : {}) } : entry);
  }
  if (list.length >= maxWallets) throw new Error('You can keep up to ' + maxWallets + ' wallets per network.');
  return [...list, { id, name: cleanName(name) || 'Wallet', ...(watchOnly ? { watchOnly } : {}) }];
}

export function renameWalletEntry(list: readonly WalletEntry[], id: string, name: string): WalletEntry[] {
  const clean = cleanName(name);
  if (!clean) throw new Error('Enter a wallet name.');
  return list.map(entry => entry.id === id ? { ...entry, name: clean } : entry);
}

export function removeWalletEntry(list: readonly WalletEntry[], id: string): WalletEntry[] {
  return list.filter(entry => entry.id !== id);
}

/** A short random id for a new wallet's keychain entries. Not secret. */
export function newWalletId(random: () => number = Math.random): string {
  return (Date.now().toString(36) + Math.floor(random() * 36 ** 6).toString(36)).slice(-16);
}

/**
 * Wallet ids found in the device keychain for one network. The service names
 * are `lustre.<network>[.<id>].profile.v1` and `...protected-mnemonic.v1`;
 * the first wallet has no id segment.
 */
export function storedWalletIds(services: readonly string[], network: string): string[] {
  const ids = new Set<string>();
  for (const service of services) {
    const match = /^lustre\.([a-z0-9]+)(?:\.([a-z0-9]{1,24}))?\.(?:profile|protected-mnemonic)\.v1$/.exec(service);
    if (match && match[1] === network) ids.add(match[2] ?? mainWalletId);
  }
  // The first Testnet2 wallet may still be under its original name.
  if (network === 'testnet2' && services.includes('lustre.testnet2.mnemonic.v1')) ids.add(mainWalletId);
  return [...ids].sort((left, right) => left === mainWalletId ? -1 : right === mainWalletId ? 1 : left.localeCompare(right));
}

/** Whether a keychain service belongs to this app's wallets. */
export function isWalletService(service: string): boolean {
  return /^lustre\.[a-z0-9]+(?:\.[a-z0-9]{1,24})?\.(?:profile|protected-mnemonic|mnemonic)\.v1$/.test(service);
}

/**
 * Add every wallet saved on the device that the list does not name, so a
 * wallet can never be on the device without a way to open it. Returns the
 * same array when nothing is missing.
 */
export function reconcileWalletList(list: readonly WalletEntry[], storedIds: readonly string[]): readonly WalletEntry[] {
  let next: WalletEntry[] | null = null;
  for (const id of storedIds) {
    const current: readonly WalletEntry[] = next ?? list;
    if (!idPattern.test(id) || current.some(entry => entry.id === id)) continue;
    const name = id === mainWalletId && !current.some(entry => entry.name === 'Main wallet')
      ? 'Main wallet'
      : suggestWalletName(current, false);
    // Found wallets are kept even past the usual limit: hiding one could strand funds.
    next = [...current, { id, name }];
  }
  return next ?? list;
}
