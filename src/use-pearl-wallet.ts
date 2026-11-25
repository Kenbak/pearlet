import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { requireDeviceAuthentication } from './device-auth';
import { getRandomBytesAsync } from './native-entropy';
import { openLiveFeed } from './live-feed';
import { broadcastPearlTransaction, historyPageSize } from './pearl-indexer';
import { createMnemonic, openPearlWallet } from './pearl-keys';
import { pearlNetworks, type PearlNetwork } from './pearl-network';
import {
  clearPendingPayment,
  hasLegacyTestnetWallet,
  hasProtectedWallet,
  migrateLegacyTestnetWallet,
  readPendingPayment,
  readRecoveryPhrase,
  readWalletProfile,
  recoverWalletProfile,
  removeWalletFromDevice,
  saveBackupVerified,
  savePendingPayment,
  saveReceiveState,
  saveWalletProfile,
  saveWatchOnlyProfile,
  mainWalletId,
  type WalletProfile,
} from './testnet-storage';
import { pearlAddressScriptHex, validatePearlAddress, validateWatchKey, watchKeyAddress } from './pearl-keys';
import {
  currentReceiveAddress,
  discoverReceiveIndex,
  firstFreshIndex,
  receiveGapLimit,
  walletAddresses,
  isPaymentIndexed,
  loadWalletSnapshot,
  outpointId,
  preparePayment,
  verifyInputsStillAvailable,
  type PendingSend,
  type PreparedSend,
  type SendOutcome,
  type FeeSpeed,
  type SpendPlan,
  type StoredPayment,
  type WalletIdentity,
  type WalletSnapshot,
} from './testnet-wallet';
import {
  backupQuizEntropyLength,
  deriveWalletIdentity,
  makeBackupQuiz,
  matchesWalletAddresses,
  phraseFingerprint,
  previewWalletRestore,
  requireRecoveryPhrase,
  type RestorePreview,
} from './wallet-backup';

type TransferReview = { display: PreparedSend; plan: SpendPlan };
type SetupRecovery = 'legacy' | 'protected';
type PhraseReview = { fingerprint: string; preview: RestorePreview };

function asIdentity(network: PearlNetwork, profile: WalletProfile): WalletIdentity {
  return {
    network,
    address: profile.address,
    scriptHex: profile.scriptHex,
    miningAddress: profile.miningAddress ?? undefined,
    miningScriptHex: profile.miningScriptHex ?? undefined,
    watchKey: profile.watchKey ?? undefined,
    receiveIndex: profile.receiveIndex,
    watchOnly: profile.watchOnly,
  };
}

function asProfile(identity: WalletIdentity, backupVerified: boolean): WalletProfile {
  return {
    address: identity.address,
    scriptHex: identity.scriptHex,
    miningAddress: identity.miningAddress ?? null,
    miningScriptHex: identity.miningScriptHex ?? null,
    backupVerified,
    watchKey: identity.watchKey ?? null,
    receiveIndex: identity.receiveIndex ?? 0,
    watchOnly: identity.watchOnly ?? false,
  };
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function waitForForeground(): Promise<void> {
  if (AppState.currentState === 'active') return;
  await new Promise<void>((resolve, reject) => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        clearTimeout(timeout);
        subscription.remove();
        resolve();
      }
    });
    const timeout = setTimeout(() => {
      subscription.remove();
      reject(new Error('Return to Pearlet and try again.'));
    }, 2500);

    if (AppState.currentState === 'active') {
      clearTimeout(timeout);
      subscription.remove();
      resolve();
    }
  });
}

export function usePearlWallet(network: PearlNetwork, walletId: string = mainWalletId) {
  const walletTarget = useMemo(() => ({ network, id: walletId }), [network, walletId]);
  const label = pearlNetworks[network].label;
  const [session, setSession] = useState<WalletProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupRecovery, setSetupRecovery] = useState<SetupRecovery | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null);
  const [syncing, setSyncing] = useState(false);
  // How many recent transfers Activity shows; Show more raises it.
  const activityLimit = useRef(historyPageSize);
  const [shownActivity, setShownActivity] = useState(historyPageSize);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [pendingNotice, setPendingNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const identity = useRef<WalletIdentity | null>(null);
  const journal = useRef<StoredPayment | null>(null);
  const review = useRef<TransferReview | null>(null);
  const restoreReview = useRef<PhraseReview | null>(null);
  const inSetup = useRef(false);
  const inSend = useRef(false);
  const inAuthentication = useRef(false);
  const syncRequest = useRef<AbortController | null>(null);
  const prepareRequest = useRef<AbortController | null>(null);

  const updateJournal = useCallback((payment: StoredPayment | null) => {
    journal.current = payment;
    if (!alive.current) return;
    setPending(payment ? {
      txid: payment.txid,
      recipient: payment.recipient,
      amountGrains: payment.amountGrains,
      feeGrains: payment.feeGrains,
    } : null);
    setPendingNotice(null);
  }, []);

  const attachProfile = useCallback(async (profile: WalletProfile) => {
    const payment = await readPendingPayment(walletTarget, profile.address);
    if (!alive.current) return;
    identity.current = asIdentity(network, profile);
    updateJournal(payment);
    setSession(profile);
    setSetupRecovery(null);
  }, [network, walletTarget, updateJournal]);

  const load = useCallback(async () => {
    setLoading(true);
    setSetupError(null);
    setSetupRecovery(null);
    try {
      const profile = await readWalletProfile(walletTarget);
      if (profile) {
        await attachProfile(profile);
        return;
      }
      const legacyWallet = network === 'testnet2' && walletId === mainWalletId && await hasLegacyTestnetWallet();
      const protectedWallet = !legacyWallet && await hasProtectedWallet(walletTarget);
      if (alive.current) setSetupRecovery(legacyWallet ? 'legacy' : protectedWallet ? 'protected' : null);
    } catch {
      if (alive.current) setSetupError('Could not open this wallet on the device. Unlock it and try again.');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [attachProfile, network, walletTarget]);

  const refresh = useCallback(async (restart = false) => {
    const current = identity.current;
    if (!alive.current || !current || (syncRequest.current && !restart)) return;
    syncRequest.current?.abort();
    const controller = new AbortController();
    syncRequest.current = controller;
    setSyncing(true);

    try {
      const payment = journal.current;
      if (payment && !inSend.current && await isPaymentIndexed(payment, current, controller.signal)
          && !controller.signal.aborted && payment === journal.current && !inSend.current) {
        await clearPendingPayment(walletTarget, payment.txid);
        updateJournal(null);
      }
      const next = await loadWalletSnapshot(current, controller.signal, activityLimit.current);
      if (controller.signal.aborted || !alive.current) return;
      setSnapshot(next);
      setSyncError(null);
    } catch (error) {
      if (!controller.signal.aborted && alive.current) {
        setSyncError(errorMessage(error, 'Could not refresh ' + label + '.'));
      }
    } finally {
      if (syncRequest.current === controller) {
        syncRequest.current = null;
        if (alive.current) setSyncing(false);
      }
    }
  }, [label, network, walletTarget, updateJournal]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      prepareRequest.current?.abort();
      syncRequest.current?.abort();
      syncRequest.current = null;
    };
  }, [load]);

  const address = session?.address;
  // Every address this wallet tracks, as one stable key for the live feed.
  const watchedKey = session ? walletAddresses(asIdentity(network, session)).map(owned => owned.address).join(' ') : '';

  // Live updates: Blockbook pushes new blocks and activity on this wallet's
  // addresses; each burst triggers one refresh. Polling below stays as a fallback.
  useEffect(() => {
    if (!watchedKey) return;
    const watched = watchedKey.split(' ');
    let close: (() => void) | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const start = () => {
      if (close) return;
      close = openLiveFeed(network, watched, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = null;
          if (AppState.currentState === 'active') void refresh(true);
        }, 600);
      });
    };
    const stop = () => {
      close?.();
      close = null;
      if (debounce) clearTimeout(debounce);
      debounce = null;
    };
    if (AppState.currentState === 'active') start();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') start();
      else if (next === 'background') stop();
    });
    return () => {
      subscription.remove();
      stop();
    };
  }, [watchedKey, network, refresh]);

  useEffect(() => {
    if (address) void refresh();
    const interval = setInterval(() => {
      if (AppState.currentState === 'active') void refresh();
    }, 30_000);
    const appState = AppState.addEventListener('change', next => {
      if (next === 'active') void refresh();
      if (next === 'background') {
        prepareRequest.current?.abort();
        syncRequest.current?.abort();
        review.current = null;
        // Older Android may use an OS credential activity that backgrounds the wallet.
        if (!inAuthentication.current) {
          restoreReview.current = null;
        }
      }
    });
    return () => {
      clearInterval(interval);
      appState.remove();
    };
  }, [address, refresh]);

  async function authenticate<T>(action: () => Promise<T>): Promise<T> {
    if (inAuthentication.current || !alive.current || AppState.currentState !== 'active') {
      throw new Error('Return to Pearlet and try again.');
    }
    inAuthentication.current = true;
    try {
      const result = await action();
      await waitForForeground();
      if (!alive.current) throw new Error('The wallet changed. Try again.');
      return result;
    } finally {
      inAuthentication.current = false;
    }
  }

  async function runSetup(action: () => Promise<void>) {
    if (inSetup.current || !alive.current) throw new Error('Wallet setup is already in progress.');
    inSetup.current = true;
    setSetupBusy(true);
    try {
      await action();
    } finally {
      inSetup.current = false;
      if (alive.current) setSetupBusy(false);
    }
  }

  async function openSavedWallet() {
    if (!setupRecovery) return;
    setSetupError(null);
    try {
      await runSetup(async () => {
        const derive = (phrase: string) => asProfile(deriveWalletIdentity(phrase, network), false);
        const profile = await authenticate(() => setupRecovery === 'legacy'
          ? migrateLegacyTestnetWallet(derive)
          : recoverWalletProfile(walletTarget, derive));
        await attachProfile(profile);
      });
    } catch (error) {
      if (alive.current) setSetupError(errorMessage(error, 'Could not open the saved wallet.'));
    }
  }

  async function persistProfile(phrase: string, profile: WalletProfile) {
    if (identity.current) throw new Error('A wallet is already saved on this network.');
    try {
      await saveWalletProfile(walletTarget, phrase, profile);
      await attachProfile(profile);
    } catch (error) {
      // If an interrupted write saved the secret alone, expose authenticated recovery.
      if (alive.current) await load();
      throw error;
    }
  }

  /**
   * Create and save a wallet without showing its phrase. The profile starts
   * with backupVerified false; the backup flow reveals and checks the phrase
   * later, when the user is somewhere private.
   */
  async function createWallet() {
    return runSetup(async () => {
      await authenticate(() => requireDeviceAuthentication('create'));
      const entropy = await getRandomBytesAsync(16);
      try {
        if (!alive.current || AppState.currentState !== 'active') throw new Error('Return to Pearlet and try again.');
        const phrase = createMnemonic(entropy);
        await persistProfile(phrase, asProfile(deriveWalletIdentity(phrase, network), false));
      } finally {
        entropy.fill(0);
      }
    });
  }

  /** A four-question backup quiz for a revealed phrase, from native entropy. */
  async function backupQuiz(phrase: string) {
    const quizEntropy = await getRandomBytesAsync(backupQuizEntropyLength);
    try {
      return makeBackupQuiz(requireRecoveryPhrase(phrase), quizEntropy);
    } finally {
      quizEntropy.fill(0);
    }
  }

  async function previewRestore(phraseInput: string, expectedAddress?: string) {
    restoreReview.current = null;
    const phrase = requireRecoveryPhrase(phraseInput);
    const preview = Object.freeze(previewWalletRestore(phrase, network, expectedAddress));
    restoreReview.current = { fingerprint: phraseFingerprint(phrase), preview };
    return preview;
  }

  async function restore(phraseInput: string, preview: RestorePreview) {
    return runSetup(async () => {
      const phrase = requireRecoveryPhrase(phraseInput);
      const checked = restoreReview.current;
      if (!checked || checked.preview !== preview || checked.fingerprint !== phraseFingerprint(phrase)) {
        throw new Error('Check the restore addresses again before continuing.');
      }
      await authenticate(() => requireDeviceAuthentication('restore'));
      const recovered = deriveWalletIdentity(phrase, network);
      if (!matchesWalletAddresses(recovered, preview)) throw new Error('The recovery addresses changed.');
      await persistProfile(phrase, asProfile(recovered, true));
      restoreReview.current = null;
      void discoverAddresses();
    });
  }

  /** Load 50 more transfers into Activity. */
  async function showMoreActivity() {
    activityLimit.current = Math.min(1000, activityLimit.current + 50);
    setShownActivity(activityLimit.current);
    await refresh(true);
  }

  /** After a restore or import, find fresh receive addresses used by this wallet before. */
  async function discoverAddresses() {
    const current = identity.current;
    if (!current?.watchKey) return;
    try {
      const highest = await discoverReceiveIndex(current);
      if (highest >= firstFreshIndex && alive.current && identity.current === current) {
        await updateReceiveState({ receiveIndex: highest });
      }
    } catch {
      // The scan runs again on the next restore; the first address keeps working.
    }
  }

  async function updateReceiveState(update: { watchKey?: string; receiveIndex?: number }) {
    const current = identity.current;
    if (!current) throw new Error('Open the wallet first.');
    const profile = await saveReceiveState(walletTarget, current.address, update);
    if (!alive.current || identity.current?.address !== profile.address) return;
    identity.current = asIdentity(network, profile);
    setSession(profile);
    void refresh(true);
  }

  /** The account watch key, reading the phrase once (with authentication) for older profiles. */
  async function ensureWatchKey(): Promise<string> {
    const current = identity.current;
    if (!current) throw new Error('Open the wallet first.');
    if (current.watchKey) return current.watchKey;
    if (current.watchOnly) throw new Error('This watch-only wallet follows a single address.');
    const phrase = await authenticate(() => readRecoveryPhrase(walletTarget, 'verify'));
    const derived = deriveWalletIdentity(phrase, network);
    if (!matchesWalletAddresses(current, derived) || !derived.watchKey) {
      throw new Error('The saved recovery phrase does not match this wallet.');
    }
    await updateReceiveState({ watchKey: derived.watchKey });
    return derived.watchKey;
  }

  /**
   * Show a fresh receive address. Refuses to run more than the gap limit
   * ahead of the last used address, so a restore always finds the funds.
   */
  async function newReceiveAddress(usedAddresses: readonly string[]) {
    await ensureWatchKey();
    const current = identity.current;
    if (!current) return;
    const issued = current.receiveIndex ?? 0;
    const used = new Set(usedAddresses);
    let lastUsed = firstFreshIndex - 1;
    for (let index = issued; index >= firstFreshIndex; index -= 1) {
      if (used.has(walletAddresses(current).find(owned => owned.index === index)?.address ?? '')) {
        lastUsed = index;
        break;
      }
    }
    const next = Math.max(firstFreshIndex, issued + 1);
    if (next - lastUsed > receiveGapLimit) {
      throw new Error('You have ' + receiveGapLimit + ' unused addresses. Use one of them first.');
    }
    await updateReceiveState({ receiveIndex: next });
  }

  /** Move to a new address when the one shown has been used. Silent when it cannot. */
  async function rotateReceiveAddress(usedAddresses: readonly string[]) {
    const current = identity.current;
    if (!current?.watchKey || !usedAddresses.includes(currentReceiveAddress(current))) return;
    try {
      await newReceiveAddress(usedAddresses);
    } catch {
      // Keep showing the current address.
    }
  }

  /** Follow a wallet without its phrase, from a Pearlet watch key or a single address. */
  async function watchWallet(input: string) {
    return runSetup(async () => {
      const value = input.trim();
      const watchKey = validateWatchKey(value, network);
      let profile: WalletProfile;
      if (watchKey) {
        const first = watchKeyAddress(watchKey, network, 0);
        const mining = network === 'mainnet' ? watchKeyAddress(watchKey, network, 1) : null;
        profile = {
          address: first.address,
          scriptHex: first.scriptHex,
          miningAddress: mining?.address ?? null,
          miningScriptHex: mining?.scriptHex ?? null,
          backupVerified: true,
          watchKey,
          receiveIndex: 0,
          watchOnly: true,
        };
      } else {
        const address = validatePearlAddress(value.toLowerCase(), network);
        if (!address) throw new Error('Paste a Pearl ' + label + ' address or a Pearlet watch key.');
        profile = {
          address,
          scriptHex: pearlAddressScriptHex(address, network),
          miningAddress: null,
          miningScriptHex: null,
          backupVerified: true,
          watchKey: null,
          receiveIndex: 0,
          watchOnly: true,
        };
      }
      if (identity.current) throw new Error('A wallet is already saved on this network.');
      await saveWatchOnlyProfile(walletTarget, profile);
      await attachProfile(profile);
      void discoverAddresses();
    });
  }

  async function showBackup() {
    if (!identity.current) throw new Error('Open the wallet to view its recovery phrase.');
    const phrase = await authenticate(() => readRecoveryPhrase(walletTarget, 'reveal'));
    const restored = deriveWalletIdentity(phrase, network);
    if (!identity.current || !matchesWalletAddresses(identity.current, restored)) {
      throw new Error('The saved recovery phrase does not match this wallet.');
    }
    return phrase;
  }

  async function verifyBackup(phraseInput: string) {
    const current = identity.current;
    if (!current) throw new Error('Open the wallet to verify its backup.');
    const restored = deriveWalletIdentity(requireRecoveryPhrase(phraseInput), network);
    if (!matchesWalletAddresses(current, restored)) {
      throw new Error('This recovery phrase belongs to a different wallet.');
    }
    const profile = await saveBackupVerified(walletTarget, current.address);
    if (alive.current) setSession(profile);
  }

  /** Remove this network's wallet from the device after a verified backup. */
  async function removeWallet() {
    const current = identity.current;
    if (!current) throw new Error('Open the wallet before removing it.');
    if (journal.current || inSend.current) throw new Error('Wait for the pending transfer to sync before removing this wallet.');
    await authenticate(() => removeWalletFromDevice(walletTarget, current.address));
    prepareRequest.current?.abort();
    syncRequest.current?.abort();
    syncRequest.current = null;
    identity.current = null;
    review.current = null;
    updateJournal(null);
    if (!alive.current) return;
    setSnapshot(null);
    setSyncError(null);
    setSyncing(false);
    setSetupRecovery(null);
    setSession(null);
  }

  async function prepare(
    recipient: string,
    amount: string,
    speed: FeeSpeed = 'normal',
    chosenPearls?: readonly string[],
    withTip = false,
  ): Promise<PreparedSend> {
    const current = identity.current;
    if (!current || journal.current || inSend.current) throw new Error('Wait for the pending transfer to sync.');
    review.current = null;
    prepareRequest.current?.abort();
    const controller = new AbortController();
    prepareRequest.current = controller;
    try {
      const plan = await preparePayment(current, recipient, amount, controller.signal, speed, chosenPearls, withTip);
      if (controller.signal.aborted || !alive.current || journal.current || inSend.current
        || AppState.currentState !== 'active') {
        throw new Error('Open a new send review.');
      }
      const display = Object.freeze({
        recipient: plan.recipient,
        amountGrains: plan.amountGrains,
        feeGrains: plan.feeGrains,
        ...(plan.tip ? { tipGrains: plan.tip.amountGrains } : {}),
      });
      review.current = { display, plan };
      return display;
    } finally {
      if (prepareRequest.current === controller) prepareRequest.current = null;
    }
  }

  async function submit(payment: StoredPayment, retry: boolean): Promise<SendOutcome> {
    let status: Awaited<ReturnType<typeof broadcastPearlTransaction>>;
    try {
      status = await broadcastPearlTransaction(network, payment.hex, payment.txid);
    } catch {
      return { status: 'unknown', txid: payment.txid };
    }

    if (status.status === 'accepted') {
      if (alive.current) setPendingNotice('Submitted to ' + label + '. Waiting for the indexer.');
      return { status: 'accepted', txid: payment.txid };
    }
    if (status.status === 'rejected' && !retry) {
      try {
        await clearPendingPayment(walletTarget, payment.txid);
        updateJournal(null);
        return { status: 'rejected', message: status.message };
      } catch {
        // Keep the same signed payment if the journal could not be cleared.
      }
    }
    if (alive.current) setPendingNotice('Waiting for confirmation. You can retry the same signed transfer.');
    return { status: 'unknown', txid: payment.txid };
  }

  async function send(display: PreparedSend): Promise<SendOutcome> {
    const current = review.current;
    if (!current || current.display !== display || journal.current || inSend.current) {
      return { status: 'rejected', message: 'The review is no longer available. Refresh and try again.' };
    }

    inSend.current = true;
    setSending(true);
    review.current = null;
    let saved: StoredPayment | null = null;

    try {
      const { plan } = current;
      await verifyInputsStillAvailable(plan);
      const entropy = await getRandomBytesAsync(32);
      let signed;
      try {
        const keys = openPearlWallet(await authenticate(() => readRecoveryPhrase(walletTarget, 'send')), network);
        try {
          if (keys.address() !== plan.identity.address
            || (plan.identity.miningAddress && keys.address(0, 1) !== plan.identity.miningAddress)
            || keys.address(0, plan.changeIndex) !== plan.changeAddress) {
            throw new Error('The saved wallet changed.');
          }
          signed = keys.signPayment({ ...plan, entropy });
        } finally {
          keys.close();
        }
      } finally {
        entropy.fill(0);
      }
      await verifyInputsStillAvailable(plan);
      if (!alive.current || AppState.currentState !== 'active') {
        throw new Error('Return to Pearlet and open a new send review.');
      }

      // Track the change address before anything is relayed, and move the
      // receive address past it so the two are never the same.
      const freshChange = plan.changeGrains > 0 && plan.changeIndex >= firstFreshIndex;
      if (freshChange) {
        const latest = identity.current;
        if (!latest || latest.address !== plan.identity.address || (latest.receiveIndex ?? 0) >= plan.changeIndex) {
          throw new Error('The wallet addresses changed. Create a new review before sending.');
        }
        const profile = await saveReceiveState(walletTarget, latest.address, { receiveIndex: plan.changeIndex + 1 });
        identity.current = asIdentity(network, profile);
        if (alive.current) setSession(profile);
      }

      const payment: StoredPayment = {
        ...display,
        address: plan.identity.address,
        ...(freshChange ? { changeAddress: plan.changeAddress } : {}),
        txid: signed.txid,
        hex: signed.hex,
        inputIds: plan.inputs.map(outpointId),
      };
      await savePendingPayment(walletTarget, payment);
      saved = payment;
      updateJournal(payment);
      if (!alive.current || AppState.currentState !== 'active') return { status: 'unknown', txid: payment.txid };
      return await submit(payment, false);
    } catch (error) {
      return saved ? { status: 'unknown', txid: saved.txid } : {
        status: 'rejected',
        message: errorMessage(error, 'Could not sign this transfer.'),
      };
    } finally {
      inSend.current = false;
      if (alive.current) {
        setSending(false);
        void refresh(true);
      }
    }
  }

  async function retryPending() {
    const payment = journal.current;
    const current = identity.current;
    if (!payment || !current || inSend.current) return;
    inSend.current = true;
    setSending(true);
    try {
      const indexed = await isPaymentIndexed(payment, current).catch(() => false);
      if (!indexed) {
        await authenticate(() => requireDeviceAuthentication('retry'));
        await submit(payment, true);
      }
    } catch (error) {
      if (alive.current) setPendingNotice(errorMessage(error, 'Could not retry the transfer.'));
    } finally {
      inSend.current = false;
      if (alive.current) {
        setSending(false);
        void refresh(true);
      }
    }
  }

  return {
    session, loading, setupError, setupRecovery, setupBusy, snapshot, syncing, syncError,
    sending, pending, pendingNotice, load, openSavedWallet, refresh,
    createWallet, backupQuiz, removeWallet, previewRestore, restore, showBackup, verifyBackup, prepare, send, retryPending,
    watchWallet, newReceiveAddress, rotateReceiveAddress, ensureWatchKey, showMoreActivity, activityLimit: shownActivity,
    receiveAddress: session ? currentReceiveAddress(asIdentity(network, session)) : null,
  };
}
