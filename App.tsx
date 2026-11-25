import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Animated,
  Linking,
  Easing,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import Feather from './src/Feather';
import Onboarding from './src/Onboarding';
import { Glass, PearletMark, PearlBackdrop, PearlButtonFill, PearlMotionProvider, PrlGlyph, palette } from './src/PearlDesign';
import Glyph, { type GlyphName } from './src/Glyphs';
import AppLock from './src/AppLock';
import { PearlLoader, PressScale, Rise, Shimmer, haptic, useCountUp, useReduceMotion } from './src/motion';
import { PreferencesProvider, usePreferences } from './src/preferences';
import { parsePaymentRequest } from './src/payment-uri';
import { supportAddress } from './src/support';
import { formatPrl, type WalletActivity } from './src/testnet-wallet';
import { pearlNetworks, type PearlNetwork } from './src/pearl-network';
import {
  eraseAllWallets,
  hasWalletsFromEarlierInstall,
  keepWalletsFromEarlierInstall,
  mainWalletId,
  readActiveWalletId,
  readSelectedNetwork,
  readWalletList,
  saveActiveWalletId,
  saveSelectedNetwork,
  saveWalletList,
} from './src/testnet-storage';
import {
  addWalletEntry,
  newWalletId,
  removeWalletEntry,
  renameWalletEntry,
  suggestWalletName,
  type WalletEntry,
} from './src/wallets-core';
import { usePearlWallet } from './src/use-pearl-wallet';
import WalletSheet, { type WalletSheetContent } from './src/WalletSheet';

const { ink, muted, accent } = palette;

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <PearlMotionProvider>
        <PreferencesProvider>
          <View style={styles.background}>
            <PearlBackdrop />
            <AppLock>
              <WalletApp />
            </AppLock>
          </View>
        </PreferencesProvider>
      </PearlMotionProvider>
    </SafeAreaProvider>
  );
}

function WalletApp() {
  const [network, setNetwork] = useState<PearlNetwork | null>(null);
  const [failed, setFailed] = useState(false);
  const switching = useRef(false);
  // Wallets on the selected network; the active id may be a draft not yet in the list.
  const [wallets, setWallets] = useState<WalletEntry[] | null>(null);
  const [activeId, setActiveId] = useState(mainWalletId);
  const previousId = useRef<string | null>(null);
  // Wallets left in the keychain by an earlier install wait for the user's choice.
  const [found, setFound] = useState<boolean | null>(null);

  useEffect(() => {
    if (!network || found !== false) return;
    let alive = true;
    setWallets(null);
    void (async () => {
      const list = await readWalletList(network);
      const saved = await readActiveWalletId(network);
      if (!alive) return;
      setWallets(list);
      setActiveId(saved && list.some(entry => entry.id === saved) ? saved : list[0]?.id ?? newWalletId());
    })().catch(() => {
      if (alive) setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [network, found]);

  function updateWallets(next: WalletEntry[]) {
    setWallets(next);
    // A failed save is repaired on the next launch from the keychain.
    if (network) void saveWalletList(network, next).catch(() => {});
  }

  function selectWallet(id: string) {
    if (!network || id === activeId) return;
    previousId.current = null;
    setActiveId(id);
    void saveActiveWalletId(network, id).catch(() => {});
  }

  function addWallet() {
    previousId.current = activeId;
    setActiveId(newWalletId());
  }

  function cancelAddWallet() {
    if (previousId.current) setActiveId(previousId.current);
    previousId.current = null;
  }

  function walletReady(watchOnly: boolean) {
    if (!network || !wallets) return;
    const known = wallets.find(entry => entry.id === activeId);
    if (known && Boolean(known.watchOnly) === watchOnly) return;
    previousId.current = null;
    updateWallets(addWalletEntry(wallets, activeId, known?.name ?? suggestWalletName(wallets, watchOnly), watchOnly));
    void saveActiveWalletId(network, activeId).catch(() => {});
  }

  function renameWallet(id: string, name: string) {
    if (!wallets) return;
    updateWallets(renameWalletEntry(wallets, id, name));
  }

  function walletRemoved() {
    if (!network || !wallets) return;
    const next = removeWalletEntry(wallets, activeId);
    updateWallets(next);
    const id = next[0]?.id ?? newWalletId();
    previousId.current = null;
    setActiveId(id);
    void saveActiveWalletId(network, id).catch(() => {});
  }

  async function loadNetwork() {
    setFailed(false);
    try {
      setFound(await hasWalletsFromEarlierInstall());
      setNetwork(await readSelectedNetwork());
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    void loadNetwork();
  }, []);

  async function switchNetwork(next: PearlNetwork) {
    if (next === network) return;
    if (switching.current) throw new Error('Another network switch is in progress.');
    switching.current = true;
    try {
      await saveSelectedNetwork(next);
      setNetwork(next);
    } finally {
      switching.current = false;
    }
  }

  if (found && !failed) return <FoundWallets onDone={() => setFound(false)} />;

  if (!network || !wallets) {
    if (!failed) return <LaunchLoader />;
    return (
      <SafeAreaView style={styles.centeredScreen}>
        <Brand />
        <Text accessibilityRole="alert" style={styles.centerMessage}>Could not open network settings.</Text>
        <TextAction label="Try again" onPress={() => void loadNetwork()} />
      </SafeAreaView>
    );
  }

  const activeEntry = wallets.find(entry => entry.id === activeId);
  return (
    <WalletHome
      key={network + ':' + activeId}
      network={network}
      walletId={activeId}
      walletName={activeEntry?.name ?? 'New wallet'}
      wallets={wallets}
      onSwitchNetwork={switchNetwork}
      onSelectWallet={selectWallet}
      onAddWallet={addWallet}
      onCancelAdd={!activeEntry && previousId.current ? cancelAddWallet : undefined}
      onRenameWallet={renameWallet}
      onWalletReady={walletReady}
      onWalletRemoved={walletRemoved}
    />
  );
}

type WalletHomeProps = {
  network: PearlNetwork;
  walletId: string;
  walletName: string;
  wallets: readonly WalletEntry[];
  onSwitchNetwork: (network: PearlNetwork) => Promise<void>;
  onSelectWallet: (id: string) => void;
  onAddWallet: () => void;
  onCancelAdd?: () => void;
  onRenameWallet: (id: string, name: string) => void;
  onWalletReady: (watchOnly: boolean) => void;
  onWalletRemoved: () => void;
};

function WalletHome({
  network, walletId, walletName, wallets, onSwitchNetwork, onSelectWallet, onAddWallet, onCancelAdd,
  onRenameWallet, onWalletReady, onWalletRemoved,
}: WalletHomeProps) {
  const wallet = usePearlWallet(network, walletId);
  const [sheet, setSheet] = useState<WalletSheetContent | null>(null);
  // Only a user's pull shows the top spinner; automatic syncs stay quiet.
  const [pulling, setPulling] = useState(false);

  async function pullToRefresh() {
    haptic('soft');
    setPulling(true);
    try {
      await wallet.refresh(true);
    } finally {
      setPulling(false);
    }
  }
  const { snapshot, session } = wallet;
  // A wallet set up under a new id joins the list once it opens.
  const sessionWatchOnly = session ? session.watchOnly : null;
  useEffect(() => {
    if (sessionWatchOnly !== null) onWalletReady(sessionWatchOnly);
  }, [sessionWatchOnly, onWalletReady]);
  const networkLabel = pearlNetworks[network].label;
  const networkReady = Boolean(!wallet.syncError && snapshot?.networkReady);

  function openSettings() {
    setSheet({ kind: 'settings' });
  }

  // pearl: payment links open Send, prefilled, once a wallet is open.
  const hasWallet = Boolean(session && !session.watchOnly);
  useEffect(() => {
    if (!hasWallet) return;
    const open = (url: string | null | undefined) => {
      if (!url) return;
      try {
        setSheet({ kind: 'send', request: parsePaymentRequest(url, network) });
      } catch {
        // Ignore links that are not valid for this network.
      }
    };
    void Linking.getInitialURL().then(open).catch(() => {});
    const subscription = Linking.addEventListener('url', ({ url }) => open(url));
    return () => subscription.remove();
  }, [hasWallet, network]);

  if (wallet.loading) return <LaunchLoader />;

  function renderContent() {

    if (wallet.setupRecovery) {
      return (
        <View style={styles.centeredScreen}>
          <Brand />
          <Text accessibilityRole="header" style={styles.centerHeading}>Open saved wallet</Text>
          <Text style={styles.centerMessage}>Authenticate to open your saved {networkLabel} wallet.</Text>
          {wallet.setupError ? <Text accessibilityRole="alert" style={styles.centerMessage}>{wallet.setupError}</Text> : null}
          <TextAction
            label={wallet.setupBusy ? 'Opening wallet…' : 'Open wallet'}
            disabled={wallet.setupBusy}
            onPress={() => void wallet.openSavedWallet()}
          />
          <TextAction label="Settings" disabled={wallet.setupBusy} onPress={openSettings} />
        </View>
      );
    }

    if (wallet.setupError) {
      return (
        <View style={styles.centeredScreen}>
          <Brand />
          <Text accessibilityRole="alert" style={styles.centerMessage}>{wallet.setupError}</Text>
          <TextAction label="Try again" onPress={() => void wallet.load()} />
          <TextAction label="Settings" onPress={openSettings} />
        </View>
      );
    }

    if (!session) {
      return (
        <Onboarding
          network={network}
          busy={wallet.setupBusy}
          error={null}
          onOpenSettings={openSettings}
          onCreate={wallet.createWallet}
          onPreviewRestore={wallet.previewRestore}
          onRestore={wallet.restore}
          onWatch={wallet.watchWallet}
          onCancel={onCancelAdd}
        />
      );
    }

    return (
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={() => void pullToRefresh()} tintColor={muted} />}
      >
        <View style={styles.page}>
          <View style={styles.topBar}>
            <PressScale
              accessibilityRole="button"
              accessibilityLabel={walletName + '. Switch wallet'}
              onPress={() => setSheet({ kind: 'wallets' })}
              feedback="selection"
              scaleTo={0.96}
              style={styles.walletSwitch}
            >
              <PearletMark size={36} />
              <Text style={styles.walletName} numberOfLines={1}>{walletName}</Text>
              <Feather name="chevron-down" size={15} color={palette.muted} strokeWidth={2.2} />
            </PressScale>
            <View style={styles.headerControls}>
              {network !== 'mainnet' ? (
                <View style={styles.preview}>
                  <View style={styles.previewDot} />
                  <Text style={styles.previewText}>Testnet2</Text>
                </View>
              ) : null}
              <PressScale
                accessibilityRole="button"
                accessibilityLabel="Wallet settings"
                onPress={openSettings}
                disabled={wallet.sending}
                feedback="selection"
                style={[styles.iconButton, styles.settingsButton]}
              >
                <PearlButtonFill variant="glass" />
                <Feather name="settings" size={19} color={ink} strokeWidth={1.7} />
              </PressScale>
            </View>
          </View>

          <Rise>
            <BalanceHero
              balanceGrains={snapshot?.balanceGrains ?? null}
              stale={Boolean(snapshot && !networkReady)}
              unconfirmedGrains={snapshot?.unconfirmedGrains ?? 0}
            />
          </Rise>

          <Rise delay={80} style={styles.actions}>
            {session.watchOnly ? (
              <WalletAction icon="receive" label="Receive" onPress={() => setSheet({ kind: 'receive' })} />
            ) : (
              <>
                <WalletAction icon="send" label="Send" onPress={() => setSheet({ kind: 'send' })} />
                <WalletAction icon="receive" label="Receive" onPress={() => setSheet({ kind: 'receive' })} />
                {/* Swap returns once PRL routing through NEAR Intents works. */}
              </>
            )}
          </Rise>

          {session.watchOnly ? (
            <Text style={styles.watchOnlyNote}>Watch-only · this device cannot send</Text>
          ) : null}

          {!session.backupVerified && !session.watchOnly ? (
            <Rise delay={120}>
              <PressScale
                accessibilityRole="button"
                accessibilityLabel="Back up your wallet. Save your recovery phrase somewhere private."
                onPress={() => setSheet({ kind: 'backup' })}
                feedback="selection"
                scaleTo={0.98}
              >
                <Glass style={styles.backupNudge} radius={20}>
                  <View style={styles.backupNudgeRow}>
                    <View style={styles.backupNudgeIcon}>
                      <Feather name="shield" size={17} color={palette.warning} strokeWidth={1.9} />
                    </View>
                    <View style={styles.backupNudgeText}>
                      <Text style={styles.backupNudgeTitle}>Back up your wallet</Text>
                      <Text style={styles.backupNudgeSubtitle}>Save your recovery phrase when you're somewhere private.</Text>
                    </View>
                    <Feather name="chevron-right" size={15} color={palette.faint} />
                  </View>
                </Glass>
              </PressScale>
            </Rise>
          ) : null}

          {snapshot?.mining?.ripening.length ? (
            <Rise delay={140}>
              <RipeningNudge
                count={snapshot.mining.ripening.length}
                nextBlocks={snapshot.mining.ripening[0].blocksToRipe}
                onPress={() => setSheet({ kind: 'mining' })}
              />
            </Rise>
          ) : null}

          {wallet.pending ? (
            <Glass style={styles.notice} radius={22}>
              <Text style={styles.noticeTitle}>Transfer pending</Text>
              <Text style={styles.noticeText}>
                {wallet.pendingNotice ?? 'Waiting for the indexer to report your signed transaction.'}
              </Text>
              <TextAction
                label={wallet.sending ? 'Checking transfer…' : 'Retry broadcast'}
                disabled={wallet.sending}
                onPress={() => void wallet.retryPending()}
              />
            </Glass>
          ) : null}

          <Rise delay={160}>
          <View style={styles.activityHeader}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>Activity</Text>
            <PressScale
              accessibilityRole="button"
              accessibilityLabel="Refresh wallet"
              onPress={() => void wallet.refresh(true)}
              disabled={wallet.syncing}
              accessibilityState={{ disabled: wallet.syncing }}
              feedback="soft"
              style={styles.iconButton}
            >
              <SpinWhile active={wallet.syncing && !pulling}>
                <Feather name="refresh-cw" size={16} color={muted} strokeWidth={1.8} />
              </SpinWhile>
            </PressScale>
          </View>

          {wallet.syncError ? (
            <Text accessibilityRole="alert" style={styles.syncError}>{wallet.syncError}</Text>
          ) : null}

          <Glass style={styles.activityCard} radius={24}>
            {snapshot?.activity.length ? snapshot.activity.map((activity, index) => (
              <ActivityRow
                key={activity.id}
                activity={activity}
                separator={index > 0}
                onPress={() => setSheet({ kind: 'activity', activity })}
              />
            )).concat(snapshot.activity.length >= wallet.activityLimit && wallet.activityLimit < 1000 ? [
              <PressScale
                key="more"
                accessibilityRole="button"
                disabled={wallet.syncing}
                onPress={() => void wallet.showMoreActivity()}
                feedback="selection"
                style={[styles.activityRow, styles.rowSeparator, styles.showMore]}
              >
                <Text style={styles.showMoreText}>{wallet.syncing ? 'Loading…' : 'Show more'}</Text>
              </PressScale>,
            ] : []) : !snapshot && !wallet.syncError ? (
              <View accessible accessibilityLabel="Loading activity">
                {[0, 1, 2].map((row) => (
                  <View key={row} style={[styles.activityRow, row > 0 && styles.rowSeparator]}>
                    <View style={styles.activityDescription}>
                      <Shimmer width="46%" height={14} />
                      <Shimmer width="28%" height={11} />
                    </View>
                    <Shimmer width={52} height={14} />
                  </View>
                ))}
              </View>
            ) : (
              <Text style={styles.emptyActivity}>
                {snapshot ? 'Your transactions will appear here.' : 'Activity is unavailable.'}
              </Text>
            )}
          </Glass>
          </Rise>
          <Text style={styles.footer}>{network === 'mainnet' ? 'Pearl ' + networkLabel : networkLabel + ' · Test coins only'}</Text>
        </View>
      </ScrollView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      {renderContent()}
      {sheet ? (
        <WalletSheet
          content={sheet}
          network={network}
          address={session?.address ?? ''}
          receiveAddress={wallet.receiveAddress ?? session?.address ?? ''}
          miningAddress={session?.miningAddress ?? undefined}
          backupVerified={session?.backupVerified ?? false}
          watchOnly={session?.watchOnly ?? false}
          freshAddresses={Boolean(session && !(session.watchOnly && !session.watchKey))}
          usedAddresses={snapshot?.usedAddresses ?? []}
          onNewAddress={wallet.newReceiveAddress}
          onRotateReceive={wallet.rotateReceiveAddress}
          onWatchKey={wallet.ensureWatchKey}
          balanceGrains={snapshot?.balanceGrains ?? null}
          spendableGrains={networkReady ? snapshot?.spendableGrains ?? null : null}
          networkReady={networkReady}
          pending={wallet.pending}
          pearls={snapshot?.pearls ?? []}
          mining={snapshot?.mining ?? null}
          onClose={() => setSheet(null)}
          onSwitchNetwork={onSwitchNetwork}
          onPrepareSend={wallet.prepare}
          onSend={wallet.send}
          onShowBackup={wallet.showBackup}
          onVerifyBackup={wallet.verifyBackup}
          onBackupQuiz={wallet.backupQuiz}
          onRemoveWallet={async () => {
            await wallet.removeWallet();
            onWalletRemoved();
          }}
          walletId={walletId}
          wallets={wallets}
          onSelectWallet={onSelectWallet}
          onAddWallet={onAddWallet}
          onRenameWallet={onRenameWallet}
          onSupport={() => setSheet({ kind: 'send', request: { address: supportAddress, label: 'Support Pearlet' } })}
        />
      ) : null}
    </SafeAreaView>
  );
}

/**
 * Shown before any wallet opens when the keychain holds wallets this install
 * has not seen: iOS keeps them when the app is deleted.
 */
function FoundWallets({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>, fallback: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : fallback);
      setBusy(false);
    }
  }

  function confirmErase() {
    Alert.alert(
      'Erase all wallets?',
      'This removes every wallet saved on this device, on Mainnet and Testnet2. Without a recovery phrase, their funds cannot be recovered.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Erase', style: 'destructive', onPress: () => void run(eraseAllWallets, 'Could not erase the wallets.') },
      ],
    );
  }

  return (
    <SafeAreaView style={styles.centeredScreen}>
      <Brand />
      <Text accessibilityRole="header" style={styles.centerHeading}>Wallet found on this device</Text>
      <Text style={styles.centerMessage}>
        A wallet is already saved on this device. Keep it to carry on, or erase it and start fresh.
      </Text>
      {error ? <Text accessibilityRole="alert" style={styles.centerMessage}>{error}</Text> : null}
      <TextAction
        label={busy ? 'Working…' : 'Keep wallet'}
        centered
        disabled={busy}
        onPress={() => void run(keepWalletsFromEarlierInstall, 'Could not open the wallet.')}
      />
      <TextAction label="Erase and start fresh" centered disabled={busy} onPress={confirmErase} />
    </SafeAreaView>
  );
}

/** Mined PRL still maturing; hidden when the user turned mining payouts off. */
function RipeningNudge({ count, nextBlocks, onPress }: { count: number; nextBlocks: number; onPress: () => void }) {
  const { preferences } = usePreferences();
  if (!preferences.showMiningPayouts) return null;
  const title = count === 1 ? '1 pearl ripening' : count + ' pearls ripening';
  const subtitle = 'Next one is spendable in ' + (nextBlocks === 1 ? '1 block' : nextBlocks + ' blocks') + '.';
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={title + '. ' + subtitle} onPress={onPress} feedback="selection" scaleTo={0.98}>
      <Glass style={styles.backupNudge} radius={20}>
        <View style={styles.backupNudgeRow}>
          <View style={styles.backupNudgeIcon}>
            <Feather name="cpu" size={17} color={palette.accent} strokeWidth={1.9} />
          </View>
          <View style={styles.backupNudgeText}>
            <Text style={styles.backupNudgeTitle}>{title}</Text>
            <Text style={styles.backupNudgeSubtitle}>{subtitle}</Text>
          </View>
          <Feather name="chevron-right" size={15} color={palette.faint} />
        </View>
      </Glass>
    </PressScale>
  );
}

/** Rotates its child while `active`, settling back to rest without a layout change. */
function SpinWhile({ active, children }: { active: boolean; children: ReactNode }) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) return;
    turn.setValue(0);
    const loop = Animated.loop(Animated.timing(turn, {
      toValue: 1,
      duration: 900,
      easing: Easing.linear,
      useNativeDriver: true,
    }));
    loop.start();
    return () => {
      loop.stop();
      Animated.timing(turn, { toValue: 1, duration: 250, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    };
  }, [active, turn]);
  return (
    <Animated.View style={{ transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }}>
      {children}
    </Animated.View>
  );
}

/**
 * Full-screen loader centred on the whole screen (not the safe area), so it
 * sits exactly where the native launch screen's logo was.
 */
function LaunchLoader() {
  return (
    <View style={styles.launchLoader}>
      <PearlLoader />
    </View>
  );
}

function Brand() {
  return (
    <View style={styles.brand} accessible accessibilityRole="header" accessibilityLabel="Pearlet">
      <PearletMark size={36} />
    </View>
  );
}

function TextAction({ label, onPress, disabled = false, centered = false }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  centered?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.textAction, centered && styles.textActionCentered, (pressed || disabled) && styles.pressed]}
    >
      <Text style={styles.textActionLabel}>{label}</Text>
    </Pressable>
  );
}

function BalanceHero({ balanceGrains, stale, unconfirmedGrains }: {
  balanceGrains: number | null;
  stale: boolean;
  unconfirmedGrains: number;
}) {
  const { preferences, setPreference } = usePreferences();
  const hidden = preferences.hideBalance;
  const shown = useCountUp(balanceGrains, 750);
  const amount = balanceGrains === null ? null : formatPrl(balanceGrains, 2);
  // While counting, show whole cents so the digits don't flicker at full precision.
  const counting = shown !== null && shown !== balanceGrains;
  const shownAmount = shown === null ? null : formatPrl(counting ? Math.round(shown / 1_000_000) * 1_000_000 : shown, 2);
  const [whole, fraction = ''] = (shownAmount ?? '—').split('.');
  const { width } = useWindowDimensions();
  const reduce = useReduceMotion();
  const glow = useRef(new Animated.Value(0)).current;
  const previous = useRef<number | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = balanceGrains;
    // Celebrate newly arrived PRL, but not the first load or a decrease.
    if (before === null || balanceGrains === null || balanceGrains <= before) return;
    haptic('success');
    if (reduce) return;
    glow.setValue(0);
    Animated.sequence([
      Animated.timing(glow, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(glow, { toValue: 0, duration: 1100, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]).start();
  }, [balanceGrains, glow, reduce]);
  const denseBalance = fraction.length > 2;
  const compact = width < 370 || denseBalance;

  return (
    <View style={styles.hero}>
      <Animated.View
        pointerEvents="none"
        style={[styles.heroGlow, {
          opacity: glow,
          transform: [{ scale: glow.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.1] }) }],
        }]}
      />
      <Text style={styles.balanceLabel}>{stale ? 'Last known balance' : 'Balance'}</Text>
      <PressScale
        accessibilityRole="button"
        accessibilityLabel={hidden ? 'Balance hidden' : amount ? amount + ' PRL' : 'Balance unavailable'}
        accessibilityHint={hidden ? 'Double tap to show your balance' : 'Double tap to hide your balance'}
        onPress={() => setPreference('hideBalance', !hidden)}
        feedback="selection"
        scaleTo={0.97}
        style={styles.balanceRow}
      >
        <PrlGlyph size={compact ? 24 : 29} color={ink} />
        {hidden ? (
          <Text style={[styles.balanceNumber, styles.balanceHidden]} numberOfLines={1}>••••••</Text>
        ) : (
          <Text
            style={[styles.balanceNumber, compact && styles.compactNumber]}
            adjustsFontSizeToFit
            numberOfLines={1}
          >
            {whole}{fraction ? <Text style={[styles.balanceFraction, denseBalance && styles.preciseFraction]}>.{fraction}</Text> : null}
          </Text>
        )}
      </PressScale>
      {!hidden && !stale && unconfirmedGrains !== 0 ? (
        <View style={styles.pendingChip}>
          <Feather name="clock" size={12} color={muted} />
          <Text style={styles.pendingBalance}>{unconfirmedGrains > 0 ? '+' : ''}{formatPrl(unconfirmedGrains)} PRL pending</Text>
        </View>
      ) : <View style={styles.pendingSpacer} />}
    </View>
  );
}

function WalletAction({ icon, label, onPress, quiet = false }: {
  icon: GlyphName;
  label: string;
  onPress: () => void;
  /** A lighter glass finish for secondary actions such as the Swap preview. */
  quiet?: boolean;
}) {
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      scaleTo={0.95}
      pressableStyle={styles.actionTarget}
      style={[styles.action, quiet && styles.actionQuiet]}
    >
      <PearlButtonFill variant={quiet ? 'glass' : 'nacre'} />
      <Glyph name={icon} size={19} weight={1.9} />
      <Text style={styles.actionText}>{label}</Text>
    </PressScale>
  );
}

function ActivityRow({
  activity,
  separator,
  onPress,
}: {
  activity: WalletActivity;
  separator: boolean;
  onPress: () => void;
}) {
  const { preferences } = usePreferences();
  const received = activity.kind === 'receive';
  const realAmount = activity.kind === 'self'
    ? '−' + formatPrl(activity.feeGrains ?? 0)
    : (received ? '+' : '−') + formatPrl(Math.abs(activity.amountGrains));
  const amount = preferences.hideBalance ? '•••' : realAmount;

  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={activity.title + ', ' + activity.subtitle + ', ' + amount + ' PRL'}
      onPress={onPress}
      scaleTo={0.98}
      feedback="selection"
      style={[styles.activityRow, separator && styles.rowSeparator]}
    >
      <View style={styles.activityDescription}>
        <Text style={styles.activityTitle}>{activity.title}</Text>
        <Text style={styles.activitySubtitle}>{activity.subtitle}</Text>
      </View>
      <View style={styles.activityValue}>
        <Text style={[styles.activityAmount, received && styles.incomingAmount]}>{amount}</Text>
        <Text style={styles.activityUnit}>PRL</Text>
      </View>
      <Feather name="chevron-right" size={15} color={palette.faint} />
    </PressScale>
  );
}

const styles = StyleSheet.create({
  showMore: { justifyContent: 'center' },
  showMoreText: { color: palette.accent, fontSize: 15, fontWeight: '600' },
  walletSwitch: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 230, paddingRight: 8 },
  walletName: { flexShrink: 1, color: palette.ink, fontSize: 16, fontWeight: '600' },
  watchOnlyNote: { color: palette.muted, fontSize: 13, textAlign: 'center', marginTop: -8 },
  background: { flex: 1, backgroundColor: '#FBFAFD' },
  launchLoader: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  centeredScreen: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 18, paddingHorizontal: 28 },
  centerHeading: { color: ink, fontSize: 26, fontWeight: '700', letterSpacing: -0.8, textAlign: 'center' },
  centerMessage: { fontSize: 15, color: muted, lineHeight: 22, maxWidth: 340, textAlign: 'center' },
  safeArea: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  page: {
    width: '100%',
    maxWidth: 504,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 28,
  },
  topBar: {
    alignItems: 'center',
    justifyContent: 'space-between',
    flexDirection: 'row',
    gap: 12,
    marginBottom: 8,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  brandName: { color: ink, fontSize: 19, fontWeight: '600', letterSpacing: -0.5, flexShrink: 1 },
  headerControls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  settingsButton: {
    borderWidth: 1,
    borderColor: palette.glassBorder,
    overflow: 'hidden',
    boxShadow: '0 4px 14px rgba(40, 28, 66, 0.08)',
  },
  preview: {
    height: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: palette.glassBorder,
    backgroundColor: palette.glass,
    paddingHorizontal: 11,
  },
  previewDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#D59A3B' },
  previewText: { fontSize: 13, fontWeight: '600', color: ink, letterSpacing: -0.1 },
  hero: { alignItems: 'center', paddingTop: 18, paddingBottom: 6, gap: 10 },
  heroGlow: {
    position: 'absolute',
    top: 10,
    alignSelf: 'center',
    width: 260,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(207, 237, 230, 0.75)',
    boxShadow: '0 0 60px rgba(160, 220, 205, 0.9)',
  },
  balanceLabel: { fontSize: 14, fontWeight: '500', color: muted, letterSpacing: 0.1 },
  balanceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, maxWidth: '100%' },
  balanceNumber: {
    flexShrink: 1,
    color: ink,
    fontSize: 58,
    lineHeight: 64,
    fontWeight: '600',
    letterSpacing: -2.4,
    fontVariant: ['tabular-nums'],
  },
  balanceHidden: { letterSpacing: 4, color: palette.faint },
  compactNumber: { fontSize: 46, lineHeight: 52, letterSpacing: -1.8 },
  balanceFraction: { fontSize: 36, color: palette.faint, letterSpacing: -1 },
  preciseFraction: { fontSize: 24, letterSpacing: -0.5 },
  pendingChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 26,
    paddingHorizontal: 10,
    borderRadius: 13,
    backgroundColor: palette.glass,
    borderWidth: 1,
    borderColor: palette.glassBorder,
  },
  pendingSpacer: { height: 26 },
  pendingBalance: { color: muted, fontSize: 12, fontWeight: '600' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 22, marginBottom: 32 },
  actionTarget: { flex: 1 },
  action: {
    height: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 6,
    borderRadius: 27,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.95)',
    boxShadow: '0 10px 24px rgba(92, 72, 140, 0.14), 0 1px 2px rgba(40, 28, 66, 0.06)',
  },
  actionQuiet: { boxShadow: '0 8px 20px rgba(40, 28, 66, 0.08)' },

  actionText: { fontSize: 15, fontWeight: '600', color: ink, letterSpacing: -0.2, flexShrink: 1 },
  pressed: { opacity: 0.6 },
  activityHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, paddingLeft: 2 },
  sectionTitle: { fontSize: 17, fontWeight: '600', letterSpacing: -0.3, color: ink },
  notice: { marginBottom: 14 },
  backupNudge: { marginTop: -14, marginBottom: 26 },
  backupNudgeRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingLeft: 14, paddingRight: 12 },
  backupNudgeIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 244, 226, 0.9)',
  },
  backupNudgeText: { flex: 1, gap: 2 },
  backupNudgeTitle: { color: ink, fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
  backupNudgeSubtitle: { color: muted, fontSize: 12, lineHeight: 16 },
  noticeTitle: { fontSize: 15, fontWeight: '700', color: ink, paddingHorizontal: 16, paddingTop: 14 },
  noticeText: { fontSize: 13, color: muted, lineHeight: 19, paddingHorizontal: 16, paddingTop: 4 },
  textActionCentered: { alignSelf: 'center' },
  textAction: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 },
  textActionLabel: { fontSize: 14, fontWeight: '700', color: accent },
  syncError: { fontSize: 13, color: palette.danger, marginBottom: 10, lineHeight: 18 },
  emptyActivity: { color: muted, fontSize: 14, lineHeight: 20, padding: 20, textAlign: 'center' },
  activityCard: {},
  activityRow: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 11,
    paddingLeft: 18,
    paddingRight: 12,
  },
  rowSeparator: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(22, 19, 31, 0.1)' },
  activityDescription: { flex: 1, gap: 2 },
  activityTitle: { color: ink, fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
  activitySubtitle: { color: muted, fontSize: 12 },
  activityValue: { alignItems: 'flex-end', gap: 1, flexShrink: 1 },
  activityAmount: { color: ink, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  incomingAmount: { color: palette.positive },
  activityUnit: { color: palette.faint, fontSize: 11, fontWeight: '600', letterSpacing: 0.6 },
  footer: { textAlign: 'center', marginTop: 20, color: palette.faint, fontSize: 12 },
});
