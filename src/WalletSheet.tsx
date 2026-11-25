import { Children, useCallback, useEffect, useRef, useState, type ComponentProps, type ComponentRef, type ReactNode } from 'react';
import {
  ActivityIndicator,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Animated,
  Easing,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { getClipboardString, setClipboardString } from './clipboard';
import QrCode from './QrCode';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Feather from './Feather';
import Glyph, { type GlyphName } from './Glyphs';
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Stop } from 'react-native-svg';
import { PearlBackdrop, PearlButtonFill, palette } from './PearlDesign';
import { PressScale, Rise, haptic, useReduceMotion } from './motion';
import { RecoveryWords, useSensitiveForeground } from './Onboarding';
import { pearlNetworks, type PearlNetwork } from './pearl-network';
import {
  formatPrl,
  type PendingSend,
  type PreparedSend,
  type SendOutcome,
  type WalletActivity,
} from './testnet-wallet';
import PhraseInput, { emptyPhrase, phraseFromWords } from './PhraseInput';
import { canCopyRecoveryPhrase, copySensitive, sensitiveClipboardSeconds } from './secure-clipboard';
import { captureNotice, useScreenGuard } from './screen-guard';
import { appVersion, privacyPolicyUrl, sourceCodeUrl } from './app-info';
import { requireDeviceAuthentication } from './device-auth';
import { usePreferences } from './preferences';
import type { BackupQuizQuestion } from './wallet-backup';
import { buildPaymentUri, grainsToDecimal, parsePaymentRequest, type PaymentRequest } from './payment-uri';
import { useContacts } from './contacts';
import { maxWalletName, type WalletEntry } from './wallets-core';
import { supportAddress, supportTipBasisPoints, supportTipGrains } from './support';
import { quickContacts, searchContacts } from './contacts-core';
import { parseSendAmount, type FeeSpeed } from './testnet-wallet';
import { formatDifficulty, ripeness, type MiningSummary, type WalletPearl } from './pearls';

export type WalletSheetContent =
  | { kind: 'send'; request?: PaymentRequest }
  | { kind: 'receive' }
  | { kind: 'swap' }
  | { kind: 'settings' }
  | { kind: 'backup' }
  | { kind: 'mining' }
  | { kind: 'wallets' }
  | { kind: 'activity'; activity: WalletActivity };

type WalletSheetProps = {
  content: WalletSheetContent;
  network: PearlNetwork;
  address: string;
  /** The receive address to show now (a fresh one when available). */
  receiveAddress: string;
  miningAddress?: string;
  backupVerified: boolean;
  watchOnly: boolean;
  /** Whether this wallet can derive fresh receive addresses. */
  freshAddresses: boolean;
  usedAddresses: readonly string[];
  balanceGrains: number | null;
  spendableGrains: number | null;
  networkReady: boolean;
  pending: PendingSend | null;
  pearls: readonly WalletPearl[];
  mining: MiningSummary | null;
  onClose: () => void;
  onPrepareSend: (recipient: string, amount: string, speed?: FeeSpeed, chosenPearls?: readonly string[], withTip?: boolean) => Promise<PreparedSend>;
  /** Open Send to tip Pearlet (Mainnet). */
  onSupport?: () => void;
  onSend: (payment: PreparedSend) => Promise<SendOutcome>;
  onShowBackup: () => Promise<string>;
  onVerifyBackup: (phrase: string) => Promise<void>;
  onBackupQuiz: (phrase: string) => Promise<BackupQuizQuestion[]>;
  onRemoveWallet: () => Promise<void>;
  onSwitchNetwork: (network: PearlNetwork) => Promise<void>;
  onNewAddress: (usedAddresses: readonly string[]) => Promise<void>;
  onRotateReceive: (usedAddresses: readonly string[]) => Promise<void>;
  onWatchKey: () => Promise<string>;
  walletId: string;
  wallets: readonly WalletEntry[];
  onSelectWallet: (id: string) => void;
  onAddWallet: () => void;
  onRenameWallet: (id: string, name: string) => void;
};

type IconName = ComponentProps<typeof Feather>['name'];

const headingGlyphs: Partial<Record<IconName, GlyphName>> = {
  'arrow-up': 'send',
  'arrow-down': 'receive',
  'arrow-left-right': 'swap',
};

const { ink, muted, accent } = palette;

export default function WalletSheet({
  content,
  network,
  address,
  receiveAddress,
  miningAddress,
  backupVerified,
  watchOnly,
  freshAddresses,
  usedAddresses,
  balanceGrains,
  spendableGrains,
  networkReady,
  pending,
  pearls,
  mining,
  onClose,
  onPrepareSend,
  onSend,
  onShowBackup,
  onVerifyBackup,
  onBackupQuiz,
  onRemoveWallet,
  onSwitchNetwork,
  onNewAddress,
  onRotateReceive,
  onWatchKey,
  walletId,
  wallets,
  onSelectWallet,
  onAddWallet,
  onRenameWallet,
  onSupport,
}: WalletSheetProps) {
  const { preferences } = usePreferences();
  const insets = useSafeAreaInsets();
  const broadcastLock = useRef(false);
  const [broadcasting, setBroadcasting] = useState(false);
  const [detail, setDetail] = useState<'backup' | 'mining' | 'payout' | 'remove' | 'wallets' | 'contacts' | null>(null);
  const onBack = () => setDetail(null);
  const reduceMotion = useReduceMotion();
  const { height: screenHeight } = useWindowDimensions();
  const presence = useRef(new Animated.Value(0)).current;
  const closing = useRef(false);

  // Opening Receive moves on from an address that has already been paid.
  const rotateOnce = useRef(false);
  useEffect(() => {
    if (content.kind !== 'receive' || rotateOnce.current) return;
    rotateOnce.current = true;
    void onRotateReceive(usedAddresses);
  }, [content.kind, onRotateReceive, usedAddresses]);

  useEffect(() => {
    Animated.spring(presence, {
      toValue: 1,
      damping: 24,
      stiffness: 260,
      mass: 0.9,
      useNativeDriver: true,
    }).start();
  }, [presence]);

  function dismiss() {
    if (closing.current) return;
    closing.current = true;
    if (reduceMotion) {
      onClose();
      return;
    }
    Animated.timing(presence, {
      toValue: 0,
      duration: 220,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => onClose());
  }

  function setBroadcastInProgress(value: boolean) {
    broadcastLock.current = value;
    setBroadcasting(value);
  }

  function requestClose() {
    if (!broadcastLock.current) dismiss();
  }

  function requestBack() {
    if (detail) onBack();
    else requestClose();
  }

  function pressBackdrop() {
    if (content.kind === 'send') {
      Keyboard.dismiss();
      return;
    }
    requestBack();
  }

  return (
    <Modal transparent animationType="none" onRequestClose={requestBack} statusBarTranslucent>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.overlay}
      >
        <Animated.View style={[styles.backdrop, { opacity: presence }]}>
          <Pressable
            accessible={false}
            importantForAccessibility="no"
            onPress={pressBackdrop}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            { paddingBottom: Math.max(insets.bottom, 24) },
            reduceMotion
              ? { opacity: presence }
              : { transform: [{ translateY: presence.interpolate({ inputRange: [0, 1], outputRange: [screenHeight * 0.6, 0] }) }] },
          ]}
        >
          <PearlBackdrop variant="sheet" />
          <View style={styles.handle} />
          <PressScale
            accessibilityLabel="Close sheet"
            accessibilityRole="button"
            accessibilityState={{ disabled: broadcasting }}
            disabled={broadcasting}
            onPress={requestClose}
            feedback="soft"
            scaleTo={0.9}
            pressableStyle={styles.closePosition}
            style={styles.closeButton}
          >
            <PearlButtonFill variant="glass" />
            <Feather name="x" size={17} color={ink} strokeWidth={2} />
          </PressScale>
          <ScrollView
            contentContainerStyle={styles.body}
            keyboardDismissMode="none"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Rise key={content.kind + ':' + (detail ?? '')} distance={10} style={styles.bodyInner}>
            {content.kind === 'send' && (
              <SendContent
                key={network}
                network={network}
                initialRequest={content.request}
                balanceGrains={balanceGrains}
                spendableGrains={spendableGrains}
                networkReady={networkReady}
                pending={pending}
                pearls={pearls}
                onClose={requestClose}
                onPrepareSend={onPrepareSend}
                onSend={onSend}
                onBroadcastChange={setBroadcastInProgress}
              />
            )}
            {(content.kind === 'mining' || content.kind === 'receive') && detail === 'payout' && miningAddress && network === 'mainnet' ? (
              <ReceiveContent key={miningAddress} network={network} address={miningAddress} mining onBack={() => setDetail(content.kind === 'mining' ? null : 'mining')} />
            ) : null}
            {(content.kind === 'mining' && detail === null) || (content.kind === 'receive' && detail === 'mining') ? (
              <MiningContent
                mining={mining}
                onShowAddress={miningAddress ? () => setDetail('payout') : undefined}
                onBack={content.kind === 'receive' ? onBack : undefined}
              />
            ) : null}
            {content.kind === 'receive' && detail === null ? (
              <ReceiveContent
                key={receiveAddress}
                network={network}
                address={receiveAddress}
                fresh={receiveAddress !== address}
                used={usedAddresses.includes(receiveAddress)}
                onNewAddress={freshAddresses ? () => onNewAddress(usedAddresses) : undefined}
                backupVerified={backupVerified}
                onOpenBackup={() => setDetail('backup')}
                onOpenMining={network === 'mainnet' && miningAddress && preferences.showMiningPayouts ? () => setDetail('mining') : undefined}
              />
            ) : null}
            {content.kind === 'swap' && <SwapContent onClose={requestClose} />}
            {content.kind === 'wallets' || (content.kind === 'settings' && detail === 'wallets') ? (
              <WalletsContent
                network={network}
                activeId={walletId}
                wallets={wallets}
                onSelect={(id) => {
                  onSelectWallet(id);
                  requestClose();
                }}
                onAdd={() => {
                  onAddWallet();
                  requestClose();
                }}
                onRename={onRenameWallet}
                onBack={content.kind === 'settings' ? onBack : undefined}
              />
            ) : null}
            {content.kind === 'settings' && detail === null ? (
              <SettingsContent
                network={network}
                address={address}
                watchOnly={watchOnly}
                onWatchKey={onWatchKey}
                backupVerified={backupVerified}
                pending={pending}
                onSwitchNetwork={onSwitchNetwork}
                onOpenBackup={() => setDetail('backup')}
                onOpenRemove={() => setDetail('remove')}
                walletName={wallets.find((entry) => entry.id === walletId)?.name ?? 'This wallet'}
                walletCount={wallets.length}
                onOpenWallets={() => setDetail('wallets')}
                onOpenContacts={() => setDetail('contacts')}
                onSupport={onSupport}
              />
            ) : null}
            {content.kind === 'settings' && detail === 'contacts' ? (
              <ContactsContent network={network} onBack={onBack} />
            ) : null}
            {content.kind === 'settings' && detail === 'remove' && address ? (
              <RemoveWalletContent
                network={network}
                watchOnly={watchOnly}
                onBack={onBack}
                onRemove={async () => {
                  await onRemoveWallet();
                  requestClose();
                }}
              />
            ) : null}
            {address && (content.kind === 'backup' || detail === 'backup') ? (
              <BackupContent
                key={network}
                network={network}
                backupVerified={backupVerified}
                onShowBackup={onShowBackup}
                onVerifyBackup={onVerifyBackup}
                onBackupQuiz={onBackupQuiz}
                onBack={content.kind === 'settings' ? onBack : undefined}
                onDone={content.kind === 'receive' ? onBack : requestClose}
              />
            ) : null}
            {content.kind === 'activity' && <ActivityContent network={network} activity={content.activity} />}
            </Rise>
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const pearlArt = require('../assets/pearl.png');

/** The glass setting from the Pearlet mark: a shallow recess lit from below. */
function PearlSetting({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id="well" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#CFC8E2" />
          <Stop offset="0.55" stopColor="#E9E4F3" />
          <Stop offset="1" stopColor="#FBF9FE" />
        </LinearGradient>
        <LinearGradient id="lip" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0} />
          <Stop offset="1" stopColor="#FFFFFF" stopOpacity={1} />
        </LinearGradient>
        <RadialGradient id="shade" cx="50" cy="56" r="40" gradientUnits="userSpaceOnUse">
          <Stop offset="0.6" stopColor="#3A3058" stopOpacity={0.18} />
          <Stop offset="1" stopColor="#3A3058" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx="50" cy="50" r="49" fill="url(#well)" />
      <Circle cx="50" cy="50" r="48" fill="none" stroke="url(#lip)" strokeWidth={1.6} />
      <Circle cx="50" cy="54" r="40" fill="url(#shade)" />
    </Svg>
  );
}

const launchMs = 1900;

/**
 * Sending: the pearl lifts out of its setting and drifts up and away with a
 * faint trail, while a new pearl forms in the setting. Loops seamlessly.
 */
function SendingMark() {
  const reduceMotion = useReduceMotion();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) return;
    const loop = Animated.loop(Animated.timing(progress, {
      toValue: 1,
      duration: launchMs,
      easing: Easing.linear,
      useNativeDriver: true,
    }));
    loop.start();
    haptic('soft');
    const beat = setInterval(() => haptic('soft'), launchMs);
    return () => {
      loop.stop();
      clearInterval(beat);
    };
  }, [progress, reduceMotion]);

  const flight = (lag: number, peak: number) => {
    const start = 0.12 + lag;
    const end = 0.78 + lag;
    const range = [0, start, end, 1];
    const ease = Easing.bezier(0.45, 0, 0.2, 1);
    return {
      opacity: progress.interpolate({ inputRange: [0, start, start + 0.3, end, 1], outputRange: [lag ? 0 : peak, peak, peak * 0.7, 0, 0], extrapolate: 'clamp' }),
      transform: [
        { translateY: progress.interpolate({ inputRange: range, outputRange: [0, 0, -118, -118], easing: ease, extrapolate: 'clamp' }) },
        { translateX: progress.interpolate({ inputRange: range, outputRange: [0, 0, 22, 22], easing: ease, extrapolate: 'clamp' }) },
        { scale: progress.interpolate({ inputRange: range, outputRange: [1, 1, 0.32, 0.32], easing: ease, extrapolate: 'clamp' }) },
      ],
    };
  };
  const reform = {
    opacity: progress.interpolate({ inputRange: [0, 0.62, 1], outputRange: [0, 0, 1] }),
    transform: [{ scale: progress.interpolate({ inputRange: [0, 0.62, 1], outputRange: [0.55, 0.55, 1], easing: Easing.out(Easing.back(1.6)) }) }],
  };
  const glint = {
    opacity: progress.interpolate({ inputRange: [0, 0.1, 0.18, 0.32, 1], outputRange: [0, 0, 0.9, 0, 0] }),
    transform: [{ scale: progress.interpolate({ inputRange: [0, 0.1, 0.32, 1], outputRange: [0.6, 0.6, 1.35, 1.35] }) }],
  };

  return (
    <View style={styles.sendingStage} accessible accessibilityRole="progressbar" accessibilityLabel="Sending transfer">
      <View style={styles.settingWrap}>
        <PearlSetting size={88} />
        <Animated.View pointerEvents="none" style={[styles.settingGlint, reduceMotion ? { opacity: 0 } : glint]} />
        {reduceMotion ? (
          <Image source={pearlArt} style={styles.flyingPearl} accessible={false} />
        ) : (
          <>
            <Animated.Image source={pearlArt} style={[styles.flyingPearl, reform]} accessible={false} />
            <Animated.Image source={pearlArt} style={[styles.flyingPearl, flight(0.1, 0.18)]} accessible={false} />
            <Animated.Image source={pearlArt} style={[styles.flyingPearl, flight(0.05, 0.35)]} accessible={false} />
            <Animated.Image source={pearlArt} style={[styles.flyingPearl, flight(0, 1)]} accessible={false} />
          </>
        )}
      </View>
    </View>
  );
}

/** A check that pops in with a soft expanding ring after a successful send. */
function SuccessMark() {
  const reduceMotion = useReduceMotion();
  const pop = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  const ring = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) {
      pop.setValue(1);
      return;
    }
    Animated.parallel([
      Animated.spring(pop, { toValue: 1, damping: 11, stiffness: 220, mass: 0.8, useNativeDriver: true }),
      Animated.timing(ring, { toValue: 1, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, [pop, ring, reduceMotion]);

  return (
    <View style={styles.successWrap} accessible={false}>
      <Animated.View
        style={[styles.successRing, {
          opacity: ring.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 0.55, 0] }),
          transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.7] }) }],
        }]}
      />
      <Animated.View style={[styles.successStamp, { opacity: pop, transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }] }]}>
        <PearlSetting size={72} />
        <Feather name="check" color={palette.positive} size={30} strokeWidth={2.4} />
      </Animated.View>
    </View>
  );
}

function SheetHeading({ icon, title, description }: {
  icon: IconName | null;
  title: string;
  description?: string;
}) {
  return (
    <View style={styles.heading}>
      {icon ? (
        <View style={styles.stamp}>
          <PearlButtonFill variant="primary" />
          {headingGlyphs[icon] ? (
            <Glyph name={headingGlyphs[icon]!} size={24} />
          ) : (
            <Feather name={icon} color={ink} size={22} strokeWidth={1.7} />
          )}
        </View>
      ) : null}
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      {description && <Text style={styles.description}>{description}</Text>}
    </View>
  );
}

function SheetButton({ label, onPress, icon, glyph, disabled = false, busy = false }: {
  label: string;
  onPress: () => void;
  icon?: IconName;
  glyph?: GlyphName;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <PressScale
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      feedback="medium"
      scaleTo={0.97}
      style={styles.button}
    >
      <PearlButtonFill variant="primary" />
      {busy ? <ActivityIndicator color={ink} /> : glyph ? (
        <Glyph name={glyph} size={19} weight={1.9} />
      ) : icon ? (
        <Feather name={icon} size={16} color={ink} strokeWidth={2} />
      ) : null}
      <Text style={styles.buttonText}>{label}</Text>
    </PressScale>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.reviewRow}>
      <Text style={styles.reviewLabel}>{label}</Text>
      <Text selectable style={styles.reviewValue}>{value}</Text>
    </View>
  );
}

const speedLabels: Record<FeeSpeed, { title: string; hint: string }> = {
  slow: { title: 'Slow', hint: 'about 6 blocks' },
  normal: { title: 'Normal', hint: 'about 2 blocks' },
  fast: { title: 'Fast', hint: 'next block' },
};

function SendContent({
  network,
  initialRequest,
  balanceGrains,
  spendableGrains,
  networkReady,
  pending,
  pearls,
  onClose,
  onPrepareSend,
  onSend,
  onBroadcastChange,
}: Pick<WalletSheetProps, 'network' | 'balanceGrains' | 'spendableGrains' | 'networkReady' | 'pending' | 'pearls' | 'onClose' | 'onPrepareSend' | 'onSend'> & {
  onBroadcastChange: (inProgress: boolean) => void;
  initialRequest?: PaymentRequest;
}) {
  const amountInput = useRef<ComponentRef<typeof TextInput>>(null);
  const inFlight = useRef(false);
  const [recipient, setRecipient] = useState(initialRequest?.address ?? '');
  const [amount, setAmount] = useState(initialRequest?.amountGrains ? grainsToDecimal(initialRequest.amountGrains) : '');
  const [speed, setSpeed] = useState<FeeSpeed>('normal');
  const { preferences: sendPreferences, setPreference: setSendPreference } = usePreferences();
  const tipAvailable = network === 'mainnet';
  const withTip = tipAvailable && sendPreferences.supportTip;
  // null spends automatically; otherwise only these outpoints.
  const [chosenPearls, setChosenPearls] = useState<string[] | null>(null);
  const spendablePearls = pearls.filter((pearl) => pearl.blocksToRipe === 0);
  const chosenGrains = chosenPearls
    ? spendablePearls.filter((pearl) => chosenPearls.includes(pearl.id)).reduce((total, pearl) => total + pearl.valueGrains, 0)
    : 0;
  const [requestNote, setRequestNote] = useState(initialRequest?.label ?? initialRequest?.message ?? '');
  const { contacts, recent, save: saveContact, markUsed } = useContacts(network);
  const [browsing, setBrowsing] = useState(false);
  const [contactQuery, setContactQuery] = useState('');
  const quickLimit = contacts.length > 6 ? 5 : 6;
  const chips = quickContacts(contacts, recent, quickLimit);
  const [naming, setNaming] = useState(false);
  const [contactName, setContactName] = useState('');
  const knownContact = contacts.find((contact) => contact.address === recipient);

  function applyRequest(request: PaymentRequest) {
    setRecipient(request.address);
    if (request.amountGrains) setAmount(grainsToDecimal(request.amountGrains));
    setRequestNote(request.label ?? request.message ?? '');
    setError('');
    haptic('selection');
  }

  async function pasteRecipient() {
    try {
      const text = await getClipboardString();
      applyRequest(parsePaymentRequest(text, network));
    } catch (failure) {
      haptic('error');
      setError(failure instanceof Error ? failure.message : 'Nothing to paste.');
    }
  }

  function saveRecipient() {
    try {
      saveContact(contactName, recipient);
      haptic('success');
      setNaming(false);
      setContactName('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save this contact.');
    }
  }
  const [error, setError] = useState('');
  const [review, setReview] = useState<PreparedSend | null>(null);
  const [receipt, setReceipt] = useState<{ status: 'accepted' | 'unknown'; txid: string } | null>(null);
  const [working, setWorking] = useState<'prepare' | 'broadcast' | null>(null);

  const { label, hrp } = pearlNetworks[network];
  const networkName = 'Pearl ' + label;
  const addressPrefix = hrp + '1';
  const currency = network === 'testnet2' ? 'testnet PRL' : 'PRL';
  const canPrepare = networkReady && spendableGrains !== null && spendableGrains > 0;
  const balanceHint = spendableGrains === null
    ? 'Spendable balance unavailable'
    : `${formatPrl(spendableGrains)} PRL available`;
  let unavailableMessage = '';
  if (!networkReady) {
    unavailableMessage = 'Connect to ' + networkName + ' to review a transfer.';
  } else if (spendableGrains === 0) {
    unavailableMessage = balanceGrains !== null && balanceGrains > 0
      ? 'Wait for your incoming ' + currency + ' to become spendable.'
      : 'Receive ' + currency + ' to make your first transfer.';
  }

  function tipHint() {
    let grains = 0;
    try {
      grains = amount.trim() ? supportTipGrains(parseSendAmount(amount)) : 0;
    } catch {
      grains = 0;
    }
    if (!withTip) return 'Optional. Supports an independent wallet.';
    if (!amount.trim()) return 'Added on top of the amount. Thank you!';
    return grains ? '+' + formatPrl(grains) + ' PRL on top. Thank you!' : 'Too small to tip on this amount.';
  }

  async function reviewSend() {
    if (inFlight.current || pending || !canPrepare) return;
    inFlight.current = true;
    setWorking('prepare');
    setError('');
    Keyboard.dismiss();
    try {
      setReview(await onPrepareSend(recipient, amount, speed, chosenPearls?.length ? chosenPearls : undefined, withTip));
      if (knownContact) markUsed(knownContact.address);
    } catch (failure) {
      haptic('error');
      setError(failure instanceof Error ? failure.message : 'Could not prepare this transfer. Try again.');
    } finally {
      setWorking(null);
      inFlight.current = false;
    }
  }

  async function confirmSend(payment: PreparedSend) {
    if (inFlight.current || pending || !networkReady) return;
    inFlight.current = true;
    setWorking('broadcast');
    onBroadcastChange(true);
    setError('');
    try {
      const result = await onSend(payment);
      if (result.status === 'rejected') {
        haptic('error');
        setError(result.message);
        setReview(null);
      } else {
        haptic(result.status === 'accepted' ? 'success' : 'warning');
        setReceipt(result);
      }
    } catch {
      haptic('warning');
      setError('Transfer status is unavailable. Check Activity before trying again.');
      setReview(null);
    } finally {
      setWorking(null);
      onBroadcastChange(false);
      inFlight.current = false;
    }
  }

  if (receipt) {
    return <TransferReceipt network={network} status={receipt.status} txid={receipt.txid} onClose={onClose} />;
  }
  if (pending && working !== 'broadcast') {
    return <TransferReceipt network={network} status="unknown" txid={pending.txid} onClose={onClose} />;
  }

  if (review) {
    return (
      <>
        {working === 'broadcast' ? (
          <>
            <SendingMark />
            <SheetHeading icon={null} title="Sending…" description={'Submitting to ' + networkName + '.'} />
          </>
        ) : (
          <SheetHeading icon="arrow-up" title="Review transfer" description={networkName} />
        )}
        <View style={styles.reviewList}>
          <Text style={styles.reviewLabel}>Recipient</Text>
          <Text selectable style={styles.reviewAddress}>{review.recipient}</Text>
          <View style={styles.reviewDivider} />
          <ReviewRow label="Amount" value={`${formatPrl(review.amountGrains)} PRL`} />
          <ReviewRow label="Network fee" value={`${formatPrl(review.feeGrains)} PRL`} />
          {review.tipGrains ? <ReviewRow label="Pearlet tip" value={`${formatPrl(review.tipGrains)} PRL`} /> : null}
          <ReviewRow label="Speed" value={speedLabels[speed].title} />
          {chosenPearls?.length ? (
            <ReviewRow label="Pearls" value={chosenPearls.length === 1 ? '1 chosen' : chosenPearls.length + ' chosen'} />
          ) : null}
          <ReviewRow label="Total" value={`${formatPrl(review.amountGrains + review.feeGrains + (review.tipGrains ?? 0))} PRL`} />
        </View>
        {!networkReady && !working ? (
          <Text accessibilityRole="alert" style={styles.error}>Connect to {networkName} to submit this transfer.</Text>
        ) : null}
        {working !== 'broadcast' ? <Text style={styles.centerHint}>Confirm with your device authentication.</Text> : null}
        <SheetButton
          label={working ? 'Submitting transfer' : 'Authenticate and send'}
          glyph={working ? undefined : 'send'}
          disabled={Boolean(working) || !networkReady}
          onPress={() => confirmSend(review)}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: Boolean(working) }}
          disabled={Boolean(working)}
          onPress={() => setReview(null)}
          style={({ pressed }) => [styles.textButton, (pressed || working) && styles.pressed]}
        >
          <Text style={styles.textButtonLabel}>Edit transfer</Text>
        </Pressable>
      </>
    );
  }

  return (
    <>
      <SheetHeading icon="arrow-up" title="Send PRL" description={networkName} />
      <View style={styles.fields}>
        {contacts.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.contactRow}>
            {chips.map((contact) => (
              <PressScale
                key={contact.address}
                accessibilityRole="button"
                accessibilityLabel={'Send to ' + contact.name}
                disabled={Boolean(working)}
                feedback="selection"
                scaleTo={0.94}
                onPress={() => {
                  setBrowsing(false);
                  applyRequest({ address: contact.address });
                }}
                style={[styles.contactChip, recipient === contact.address && styles.contactChipSelected]}
              >
                <Text style={styles.contactChipText} numberOfLines={1}>{contact.name}</Text>
              </PressScale>
            ))}
            {contacts.length > chips.length ? (
              <PressScale
                accessibilityRole="button"
                accessibilityLabel={browsing ? 'Hide contacts' : 'Show all ' + contacts.length + ' contacts'}
                disabled={Boolean(working)}
                feedback="selection"
                scaleTo={0.94}
                onPress={() => {
                  setBrowsing(!browsing);
                  setContactQuery('');
                }}
                style={[styles.contactChip, styles.contactChipQuiet, browsing && styles.contactChipSelected]}
              >
                <Text style={[styles.contactChipText, styles.contactChipQuietText]}>{browsing ? 'Close' : 'All ' + contacts.length}</Text>
              </PressScale>
            ) : null}
          </ScrollView>
        ) : null}
        {browsing ? (
          <View style={styles.contactBrowser}>
            <TextInput
              accessibilityLabel="Search contacts"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              clearButtonMode="while-editing"
              onChangeText={setContactQuery}
              placeholder="Search by name or address"
              placeholderTextColor={muted}
              returnKeyType="search"
              style={styles.input}
              value={contactQuery}
            />
            <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={styles.contactResults}>
              {searchContacts(contacts, contactQuery).slice(0, 50).map((contact) => (
                <PressScale
                  key={contact.address}
                  accessibilityRole="button"
                  accessibilityLabel={'Send to ' + contact.name}
                  feedback="selection"
                  scaleTo={0.98}
                  onPress={() => {
                    setBrowsing(false);
                    applyRequest({ address: contact.address });
                  }}
                  style={styles.contactResult}
                >
                  <Text style={styles.contactChipText} numberOfLines={1}>{contact.name}</Text>
                  <Text style={styles.pearlMeta} numberOfLines={1}>{contact.address.slice(0, 12) + '…' + contact.address.slice(-6)}</Text>
                </PressScale>
              ))}
              {!searchContacts(contacts, contactQuery).length ? <Text style={styles.hint}>No contact matches.</Text> : null}
            </ScrollView>
          </View>
        ) : null}
        <View style={styles.field}>
          <View style={styles.fieldHeader}>
            <Text style={styles.fieldLabel}>{knownContact ? 'To ' + knownContact.name : 'Recipient'}</Text>
            <PressScale
              accessibilityRole="button"
              accessibilityLabel="Paste an address or payment link"
              disabled={Boolean(working)}
              feedback="selection"
              onPress={() => void pasteRecipient()}
              style={styles.fieldAction}
            >
              <Text style={styles.textButtonLabel}>Paste</Text>
            </PressScale>
          </View>
          <TextInput
            accessibilityLabel="Recipient"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            editable={!working}
            maxLength={128}
            onChangeText={(text) => {
              if (/[:?]/.test(text)) {
                try {
                  applyRequest(parsePaymentRequest(text, network));
                } catch (failure) {
                  setError(failure instanceof Error ? failure.message : 'This payment link is not valid.');
                }
                return;
              }
              setRequestNote('');
              const address = text.trim().toLowerCase();
              const validDraft = addressPrefix.startsWith(address) || (
                address.startsWith(addressPrefix) && /^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.test(address.slice(addressPrefix.length))
              );
              if (!validDraft) {
                setError('Enter a ' + networkName + ' address starting with ' + addressPrefix + '.');
                return;
              }
              setRecipient(address);
              setError('');
            }}
            onSubmitEditing={() => amountInput.current?.focus()}
            placeholder={addressPrefix + 'p…'}
            placeholderTextColor={muted}
            returnKeyType="next"
            spellCheck={false}
            style={styles.input}
            value={recipient}
          />
          {requestNote ? <Text style={styles.hint}>For: {requestNote}</Text> : null}
          {recipient && !knownContact && recipient.length > addressPrefix.length + 20 && !naming ? (
            <PressScale accessibilityRole="button" onPress={() => setNaming(true)} feedback="selection" style={styles.fieldAction}>
              <Text style={styles.textButtonLabel}>Save as contact</Text>
            </PressScale>
          ) : null}
          {naming ? (
            <View style={styles.contactSaveRow}>
              <TextInput
                accessibilityLabel="Contact name"
                autoFocus
                maxLength={40}
                onChangeText={setContactName}
                onSubmitEditing={saveRecipient}
                placeholder="Name"
                placeholderTextColor={muted}
                returnKeyType="done"
                style={[styles.input, styles.contactNameInput]}
                value={contactName}
              />
              <PressScale accessibilityRole="button" onPress={saveRecipient} feedback={null} style={styles.fieldAction}>
                <Text style={styles.textButtonLabel}>Save</Text>
              </PressScale>
            </View>
          ) : null}
        </View>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Amount</Text>
          <View style={styles.amountField}>
            <TextInput
              accessibilityLabel="Amount in PRL"
              editable={!working}
              inputMode="decimal"
              maxLength={26}
              onChangeText={(text) => {
                const decimal = text.replace(',', '.');
                if (!/^[0-9.]*$/.test(decimal)) {
                  setError('Enter a PRL amount.');
                  return;
                }
                setAmount(decimal);
                setError('');
              }}
              onSubmitEditing={reviewSend}
              placeholder="0.00"
              placeholderTextColor={muted}
              ref={amountInput}
              returnKeyType="done"
              style={[styles.input, styles.amountInput]}
              value={amount}
            />
            <Text style={styles.amountUnit}>PRL</Text>
          </View>
          <Text style={styles.hint}>{balanceHint}</Text>
        </View>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : (
          unavailableMessage ? <Text style={styles.hint}>{unavailableMessage}</Text> : null
        )}
      </View>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Speed</Text>
        <View style={styles.speedRow} accessibilityRole="radiogroup">
          {(['slow', 'normal', 'fast'] as const).map((option) => {
            const selected = speed === option;
            return (
              <PressScale
                key={option}
                accessibilityRole="radio"
                accessibilityState={{ selected, disabled: Boolean(working) }}
                accessibilityLabel={speedLabels[option].title + ', ' + speedLabels[option].hint}
                disabled={Boolean(working)}
                feedback="selection"
                scaleTo={0.95}
                onPress={() => setSpeed(option)}
                pressableStyle={styles.speedTarget}
                style={[styles.speedOption, selected && styles.speedOptionSelected]}
              >
                <Text style={[styles.speedTitle, selected && styles.speedTitleSelected]}>{speedLabels[option].title}</Text>
                <Text style={styles.speedHint}>{speedLabels[option].hint}</Text>
              </PressScale>
            );
          })}
        </View>
      </View>
      {spendablePearls.length > 1 ? (
        <View style={styles.field}>
          <View style={styles.fieldHeader}>
            <Text style={styles.fieldLabel}>Pearls</Text>
            <PressScale
              accessibilityRole="button"
              accessibilityLabel={chosenPearls ? 'Choose pearls automatically' : 'Choose which pearls to spend'}
              disabled={Boolean(working)}
              feedback="selection"
              onPress={() => setChosenPearls(chosenPearls ? null : [])}
              style={styles.fieldAction}
            >
              <Text style={styles.textButtonLabel}>{chosenPearls ? 'Automatic' : 'Choose'}</Text>
            </PressScale>
          </View>
          {chosenPearls ? (
            <View style={styles.pearlList}>
              {spendablePearls.map((pearl) => {
                const selected = chosenPearls.includes(pearl.id);
                return (
                  <PressScale
                    key={pearl.id}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected, disabled: Boolean(working) }}
                    accessibilityLabel={formatPrl(pearl.valueGrains) + ' PRL' + (pearl.chain === 1 ? ', mining payout' : '')}
                    disabled={Boolean(working)}
                    feedback="selection"
                    scaleTo={0.98}
                    onPress={() => setChosenPearls(selected
                      ? chosenPearls.filter((id) => id !== pearl.id)
                      : [...chosenPearls, pearl.id])}
                    style={[styles.pearlChoice, selected && styles.speedOptionSelected]}
                  >
                    <Image source={pearlArt} style={[styles.pearlDot, !selected && styles.pearlDotIdle]} />
                    <Text style={styles.pearlAmount}>{formatPrl(pearl.valueGrains)} PRL</Text>
                    <Text style={styles.pearlMeta}>{pearl.chain === 1 ? 'Mining' : pearl.confirmations.toLocaleString('en-US') + ' conf.'}</Text>
                    <Feather name={selected ? 'check-circle' : 'circle'} size={18} color={selected ? accent : palette.faint} strokeWidth={1.8} />
                  </PressScale>
                );
              })}
              <Text style={styles.hint}>
                {chosenPearls.length
                  ? (chosenPearls.length === 1 ? '1 pearl' : chosenPearls.length + ' pearls') + ' · ' + formatPrl(chosenGrains) + ' PRL. Only these are spent.'
                  : 'Tap the pearls to spend. The fee comes from them too.'}
              </Text>
            </View>
          ) : (
            <Text style={styles.hint}>Automatic uses the fewest pearls.</Text>
          )}
        </View>
      ) : null}
      {tipAvailable && recipient !== supportAddress ? (
        <View style={styles.supportTipRow}>
          <Image source={pearlArt} style={styles.walletPearl} />
          <View style={styles.settingsText}>
            <Text style={styles.fieldLabel}>Tip Pearlet {supportTipBasisPoints / 100}%</Text>
            <Text style={styles.hint}>{tipHint()}</Text>
          </View>
          <Switch
            accessibilityLabel={'Tip Pearlet ' + supportTipBasisPoints / 100 + ' percent'}
            disabled={Boolean(working)}
            onValueChange={(next) => {
              haptic('selection');
              setSendPreference('supportTip', next);
            }}
            trackColor={{ true: accent }}
            value={withTip}
          />
        </View>
      ) : null}
      <SheetButton
        label={working ? 'Preparing transfer' : 'Review transfer'}
        onPress={reviewSend}
        busy={working === 'prepare'}
        disabled={Boolean(working) || !canPrepare || !recipient.trim() || !amount.trim() || (chosenPearls !== null && !chosenPearls.length)}
      />
    </>
  );
}

function shortAddress(address: string) {
  return address.slice(0, 10) + '…' + address.slice(-6);
}

/** Saved contacts for this network: search, add, rename and delete. */
function ContactsContent({ network, onBack }: { network: PearlNetwork; onBack: () => void }) {
  const { contacts, save, remove } = useContacts(network);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const { hrp, label } = pearlNetworks[network];
  const shown = searchContacts(contacts, query);

  function startEdit(contact: { name: string; address: string }) {
    setAdding(false);
    setEditing(contact.address);
    setName(contact.name);
    setError('');
  }

  function startAdd() {
    setEditing(null);
    setAdding(true);
    setName('');
    setAddress('');
    setError('');
  }

  function saveContact(target: string) {
    try {
      save(name, target);
      haptic('success');
      setEditing(null);
      setAdding(false);
    } catch (failure) {
      haptic('error');
      setError(failure instanceof Error ? failure.message : 'Could not save this contact.');
    }
  }

  async function pasteAddress() {
    try {
      const request = parsePaymentRequest(await getClipboardString(), network);
      setAddress(request.address);
      if (!name.trim() && request.label) setName(request.label);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Nothing to paste.');
    }
  }

  return (
    <>
      <SheetHeading icon={null} title="Contacts" description={'Saved on this device for Pearl ' + label + '.'} />
      {contacts.length > 6 ? (
        <TextInput
          accessibilityLabel="Search contacts"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          onChangeText={setQuery}
          placeholder="Search by name or address"
          placeholderTextColor={muted}
          style={styles.input}
          value={query}
        />
      ) : null}
      <View style={styles.walletGroup}>
        {shown.map((contact, index) => (
          <View key={contact.address}>
            {index > 0 ? <View style={styles.settingsDivider} /> : null}
            {editing === contact.address ? (
              <View style={styles.contactEditor}>
                <TextInput
                  accessibilityLabel="Contact name"
                  autoFocus
                  maxLength={40}
                  onChangeText={setName}
                  onSubmitEditing={() => saveContact(contact.address)}
                  returnKeyType="done"
                  style={styles.walletNameInput}
                  value={name}
                />
                <Text selectable style={styles.walletRowMeta}>{contact.address}</Text>
                <View style={styles.contactEditorActions}>
                  <PressScale
                    accessibilityRole="button"
                    onPress={() => {
                      remove(contact.address);
                      haptic('warning');
                      setEditing(null);
                    }}
                    feedback={null}
                    style={styles.fieldAction}
                  >
                    <Text style={[styles.textButtonLabel, styles.dangerLabel]}>Delete</Text>
                  </PressScale>
                  <PressScale accessibilityRole="button" onPress={() => setEditing(null)} feedback={null} style={styles.fieldAction}>
                    <Text style={styles.textButtonLabel}>Cancel</Text>
                  </PressScale>
                  <PressScale accessibilityRole="button" onPress={() => saveContact(contact.address)} feedback={null} style={styles.fieldAction}>
                    <Text style={styles.textButtonLabel}>Save</Text>
                  </PressScale>
                </View>
              </View>
            ) : (
              <PressScale
                accessibilityRole="button"
                accessibilityLabel={contact.name + ', ' + contact.address + '. Edit'}
                feedback="selection"
                scaleTo={0.98}
                onPress={() => startEdit(contact)}
                style={styles.settingsRow}
              >
                <View style={styles.settingsText}>
                  <Text style={styles.walletRowName} numberOfLines={1}>{contact.name}</Text>
                  <Text style={styles.walletRowMeta}>{shortAddress(contact.address)}</Text>
                </View>
                <Feather name="pencil" size={14} color={palette.faint} strokeWidth={2} />
              </PressScale>
            )}
          </View>
        ))}
        {shown.length ? <View style={styles.settingsDivider} /> : null}
        {adding ? (
          <View style={styles.contactEditor}>
            <TextInput
              accessibilityLabel="New contact name"
              autoFocus
              maxLength={40}
              onChangeText={setName}
              placeholder="Name"
              placeholderTextColor={muted}
              returnKeyType="next"
              style={styles.walletNameInput}
              value={name}
            />
            <View style={styles.fieldHeader}>
              <TextInput
                accessibilityLabel="New contact address"
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={128}
                onChangeText={(text) => setAddress(text.trim().toLowerCase())}
                onSubmitEditing={() => saveContact(address)}
                placeholder={hrp + '1p…'}
                placeholderTextColor={muted}
                returnKeyType="done"
                spellCheck={false}
                style={[styles.walletNameInput, styles.contactAddressInput]}
                value={address}
              />
              <PressScale accessibilityRole="button" onPress={() => void pasteAddress()} feedback="selection" style={styles.fieldAction}>
                <Text style={styles.textButtonLabel}>Paste</Text>
              </PressScale>
            </View>
            <View style={styles.contactEditorActions}>
              <PressScale accessibilityRole="button" onPress={() => setAdding(false)} feedback={null} style={styles.fieldAction}>
                <Text style={styles.textButtonLabel}>Cancel</Text>
              </PressScale>
              <PressScale accessibilityRole="button" onPress={() => saveContact(address)} feedback={null} style={styles.fieldAction}>
                <Text style={styles.textButtonLabel}>Save</Text>
              </PressScale>
            </View>
          </View>
        ) : (
          <PressScale accessibilityRole="button" accessibilityLabel="Add a contact" feedback="selection" scaleTo={0.98} onPress={startAdd} style={styles.walletRow}>
            <View style={styles.walletPearlSlot}>
              <Feather name="plus" size={18} color={accent} strokeWidth={2.2} />
            </View>
            <Text style={[styles.walletRowName, styles.walletAddText]}>Add a contact</Text>
          </PressScale>
        )}
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {!contacts.length && !adding ? (
        <Text style={styles.centerHint}>You can also save a recipient from Send.</Text>
      ) : null}
      <SecondaryButton label="Back to Settings" onPress={onBack} />
    </>
  );
}

/** Wallets on this network: tap to switch, pencil or long press to rename. */
function WalletsContent({ network, activeId, wallets, onSelect, onAdd, onRename, onBack }: {
  onBack?: () => void;
  network: PearlNetwork;
  activeId: string;
  wallets: readonly WalletEntry[];
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  function startRename(entry: WalletEntry) {
    haptic('selection');
    setEditing(entry.id);
    setDraft(entry.name);
    setError('');
  }

  function saveRename() {
    if (!editing) return;
    try {
      onRename(editing, draft);
      haptic('success');
      setEditing(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not rename this wallet.');
    }
  }

  return (
    <>
      <SheetHeading icon={null} title="Wallets" description={'Pearl ' + pearlNetworks[network].label} />
      <View style={styles.walletGroup}>
        {wallets.map((entry, index) => {
          const active = entry.id === activeId;
          const divider = index > 0 ? <View style={styles.walletDivider} /> : null;
          if (editing === entry.id) {
            return (
              <View key={entry.id}>
                {divider}
                <View style={styles.walletRow}>
                  <View style={[styles.walletPearlRing, active && styles.walletPearlRingActive]}>
                    <Image source={pearlArt} style={styles.walletPearl} />
                  </View>
                  <TextInput
                    accessibilityLabel="Wallet name"
                    autoFocus
                    maxLength={maxWalletName}
                    onChangeText={setDraft}
                    onSubmitEditing={saveRename}
                    returnKeyType="done"
                    selectTextOnFocus
                    style={styles.walletNameInput}
                    value={draft}
                  />
                  <PressScale accessibilityRole="button" onPress={saveRename} feedback={null} style={styles.fieldAction}>
                    <Text style={styles.textButtonLabel}>Save</Text>
                  </PressScale>
                </View>
              </View>
            );
          }
          return (
            <View key={entry.id}>
              {divider}
              <PressScale
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={entry.name + (entry.watchOnly ? ', watch-only' : '') + (active ? ', current wallet' : '')}
                accessibilityHint="Long press to rename"
                feedback="selection"
                scaleTo={0.98}
                delayLongPress={400}
                onPress={() => (active ? undefined : onSelect(entry.id))}
                onLongPress={() => startRename(entry)}
                style={styles.walletRow}
              >
                <View style={[styles.walletPearlRing, active && styles.walletPearlRingActive]}>
                  <Image source={pearlArt} style={[styles.walletPearl, !active && styles.pearlDotIdle]} />
                </View>
                <View style={styles.walletRowText}>
                  <Text style={styles.walletRowName} numberOfLines={1}>{entry.name}</Text>
                  {entry.watchOnly ? <Text style={styles.walletRowMeta}>Watch-only</Text> : null}
                </View>
                <PressScale
                  accessibilityRole="button"
                  accessibilityLabel={'Rename ' + entry.name}
                  hitSlop={10}
                  feedback={null}
                  scaleTo={0.9}
                  onPress={() => startRename(entry)}
                  style={styles.walletEdit}
                >
                  <Feather name="pencil" size={14} color={palette.faint} strokeWidth={2} />
                </PressScale>
              </PressScale>
            </View>
          );
        })}
        <View style={styles.walletDivider} />
        <PressScale
          accessibilityRole="button"
          accessibilityLabel="Add a wallet: create, restore or watch"
          feedback="selection"
          scaleTo={0.98}
          onPress={onAdd}
          style={styles.walletRow}
        >
          <View style={styles.walletPearlSlot}>
            <Feather name="plus" size={18} color={accent} strokeWidth={2.2} />
          </View>
          <Text style={[styles.walletRowName, styles.walletAddText]}>Add a wallet</Text>
        </PressScale>
      </View>
      <Text style={styles.centerHint}>Create, restore or watch a wallet. Long press a name to rename it.</Text>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {onBack ? <SecondaryButton label="Back to Settings" onPress={onBack} /> : null}
    </>
  );
}

const coinbaseMaturity = pearlNetworks.mainnet.coinbaseMaturity;

function blocksLeftLabel(blocks: number) {
  return blocks === 1 ? '1 block left' : blocks.toLocaleString('en-US') + ' blocks left';
}

/** A mined pearl on its way to maturity: brighter as it ripens. */
function RipeningRow({ pearl, hidden }: { pearl: WalletPearl; hidden: boolean }) {
  const progress = ripeness(pearl, coinbaseMaturity);
  return (
    <View
      accessible
      accessibilityLabel={(hidden ? 'Hidden amount' : formatPrl(pearl.valueGrains) + ' PRL') + ', ' + blocksLeftLabel(pearl.blocksToRipe)}
      style={styles.pearlRow}
    >
      <Image source={pearlArt} style={[styles.pearlDot, { opacity: 0.35 + 0.65 * progress }]} />
      <View style={styles.pearlRowText}>
        <View style={styles.reviewRow}>
          <Text style={styles.pearlAmount}>{hidden ? '••••' : formatPrl(pearl.valueGrains) + ' PRL'}</Text>
          <Text style={styles.pearlMeta}>{blocksLeftLabel(pearl.blocksToRipe)}</Text>
        </View>
        <View style={styles.ripeTrack}>
          <View style={[styles.ripeFill, { width: Math.round(progress * 100) + '%' }]} />
        </View>
      </View>
    </View>
  );
}

function MiningContent({ mining, onShowAddress, onBack }: {
  mining: MiningSummary | null;
  onShowAddress?: () => void;
  onBack?: () => void;
}) {
  const { preferences } = usePreferences();
  const hidden = preferences.hideBalance;
  const amount = (grains: number) => hidden ? '••••' : formatPrl(grains) + ' PRL';
  return (
    <>
      <SheetHeading icon="cpu" title="Mining" description="Mined PRL ripens for 100 blocks before you can spend it." />
      {mining ? (
        <>
          <View style={styles.reviewList}>
            <ReviewRow label="Ripening" value={amount(mining.ripeningGrains)} />
            <ReviewRow label="Ready on payout address" value={amount(mining.ripeGrains)} />
            <ReviewRow
              label={'Payouts, last ' + mining.windowBlocks.toLocaleString('en-US') + ' blocks'}
              value={amount(mining.recentGrains) + (mining.recentCount ? ' · ' + mining.recentCount : '')}
            />
          </View>
          <View style={styles.settingsSection}>
            <Text accessibilityRole="header" style={styles.settingsSectionTitle}>Ripening pearls</Text>
            {mining.ripening.length ? (
              <View style={styles.pearlList}>
                {mining.ripening.map((pearl) => <RipeningRow key={pearl.id} pearl={pearl} hidden={hidden} />)}
              </View>
            ) : (
              <Text style={styles.hint}>Nothing ripening. New payouts appear here with a countdown.</Text>
            )}
          </View>
          <View style={styles.settingsSection}>
            <Text accessibilityRole="header" style={styles.settingsSectionTitle}>Network</Text>
            <View style={styles.reviewList}>
              <ReviewRow label="Block height" value={mining.tipHeight.toLocaleString('en-US')} />
              <ReviewRow label="Difficulty" value={formatDifficulty(mining.difficulty)} />
            </View>
          </View>
          <Text style={styles.centerHint}>Totals count payouts this wallet has not spent yet.</Text>
        </>
      ) : (
        <Text style={styles.centerHint}>Mining details appear once Pearl Mainnet syncs.</Text>
      )}
      {onShowAddress ? <SecondaryButton label="Payout address" onPress={onShowAddress} /> : null}
      {onBack ? <SecondaryButton label="Back to Receive" onPress={onBack} /> : null}
    </>
  );
}

function TransferReceipt({ network, status, txid, onClose }: {
  network: PearlNetwork;
  status: 'accepted' | 'unknown';
  txid: string;
  onClose: () => void;
}) {
  const accepted = status === 'accepted';
  return (
    <>
      {accepted ? <SuccessMark /> : null}
      <SheetHeading
        icon={accepted ? null : 'clock'}
        title={accepted ? 'Transfer submitted' : 'Transfer status pending'}
        description={accepted
          ? 'Submitted to Pearl ' + pearlNetworks[network].label + '. Check Activity for confirmations.'
          : 'Close this sheet to refresh Activity or retry broadcasting the same transaction from your wallet.'}
      />
      <View style={styles.addressCard}>
        <Text style={styles.fieldLabel}>Transaction ID</Text>
        <Text selectable style={styles.address}>{txid}</Text>
      </View>
      <CopyButton value={txid} label="Copy transaction ID" copiedLabel="Copied transaction ID" secondary />
      <ExplorerButton network={network} txid={txid} />
      <SheetButton label="Done" onPress={onClose} />
    </>
  );
}

function ReceiveContent({
  network, address, mining = false, fresh = false, used = false, onNewAddress,
  backupVerified = true, onOpenBackup, onOpenMining, onBack,
}: {
  network: PearlNetwork;
  address: string;
  mining?: boolean;
  fresh?: boolean;
  used?: boolean;
  onNewAddress?: () => Promise<void>;
  backupVerified?: boolean;
  onOpenBackup?: () => void;
  onOpenMining?: () => void;
  onBack?: () => void;
}) {
  const { width } = useWindowDimensions();
  const qrSize = Math.max(130, Math.min(width - 148, 174));
  const { label } = pearlNetworks[network];
  const [requesting, setRequesting] = useState(false);
  const [requestAmount, setRequestAmount] = useState('');
  const [requestLabel, setRequestLabel] = useState('');
  const [newAddressError, setNewAddressError] = useState('');
  const [makingAddress, setMakingAddress] = useState(false);
  async function makeNewAddress() {
    if (!onNewAddress || makingAddress) return;
    setMakingAddress(true);
    setNewAddressError('');
    try {
      await onNewAddress();
      haptic('success');
    } catch (failure) {
      haptic('error');
      setNewAddressError(failure instanceof Error ? failure.message : 'Could not make a new address.');
    } finally {
      setMakingAddress(false);
    }
  }
  let requestError = '';
  let requestGrains: number | undefined;
  if (requesting && requestAmount.trim()) {
    try {
      requestGrains = parseSendAmount(requestAmount);
    } catch (failure) {
      requestError = failure instanceof Error ? failure.message : 'Enter a PRL amount.';
    }
  }
  const requestUri = requesting && !mining
    ? buildPaymentUri({ address, amountGrains: requestGrains, label: requestLabel })
    : null;
  const qrValue = requestUri ?? address;

  return (
    <>
      <SheetHeading
        icon="arrow-down"
        title={mining ? 'Mining payouts' : 'Receive PRL'}
        description={mining
          ? 'Use this stable Mainnet address as the payout address in your miner or pool.'
          : 'Use this address to receive PRL on Pearl ' + label + '.'}
      />
      <View style={styles.addressCard}>
        <View
          accessible
          accessibilityLabel={mining ? 'QR code for your Mainnet mining payout address' : 'QR code for your Pearl ' + label + ' address'}
          style={styles.qr}
        >
          <QrCode value={qrValue} size={qrSize} quietZone={16} color={ink} backgroundColor="#FFFFFF" />
        </View>
        <Text style={styles.fieldLabel}>
          {mining ? 'Mining payout address' : used ? 'Used address' : fresh ? 'New ' + label + ' address' : label + ' address'}
        </Text>
        <Text selectable style={styles.address}>{address}</Text>
        {requestUri && requestGrains ? (
          <Text style={styles.requestSummary}>
            Requesting {grainsToDecimal(requestGrains)} PRL{requestLabel.trim() ? ' · ' + requestLabel.trim() : ''}
          </Text>
        ) : null}
      </View>
      {!mining ? (
        requesting ? (
          <View style={styles.fields}>
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Amount to request</Text>
              <View style={styles.amountField}>
                <TextInput
                  accessibilityLabel="Amount to request in PRL"
                  inputMode="decimal"
                  maxLength={26}
                  onChangeText={(text) => setRequestAmount(text.replace(',', '.').replace(/[^0-9.]/g, ''))}
                  placeholder="0.00"
                  placeholderTextColor={muted}
                  style={[styles.input, styles.amountInput]}
                  value={requestAmount}
                />
                <Text style={styles.amountUnit}>PRL</Text>
              </View>
            </View>
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Note (optional)</Text>
              <TextInput
                accessibilityLabel="Note for this request"
                maxLength={60}
                onChangeText={setRequestLabel}
                placeholder="What it's for"
                placeholderTextColor={muted}
                style={styles.input}
                value={requestLabel}
              />
            </View>
            {requestError ? <Text accessibilityRole="alert" style={styles.error}>{requestError}</Text> : null}
          </View>
        ) : (
          <SecondaryButton label="Request an amount" onPress={() => setRequesting(true)} />
        )
      ) : null}
      <CopyButton
        value={requestUri ?? address}
        label={mining ? 'Copy payout address' : requestUri ? 'Copy payment request' : 'Copy address'}
        copiedLabel={mining ? 'Copied payout address' : requestUri ? 'Copied payment request' : 'Copied address'}
      />
      {!backupVerified && onOpenBackup ? (
        <PressScale
          accessibilityRole="button"
          accessibilityLabel="Back up your wallet before receiving larger amounts"
          onPress={onOpenBackup}
          feedback="selection"
          scaleTo={0.98}
          style={styles.backupHint}
        >
          <Feather name="shield" size={16} color={palette.warning} strokeWidth={1.9} />
          <Text style={styles.backupHintText}>Back up your wallet before receiving larger amounts.</Text>
          <Feather name="chevron-right" size={15} color={palette.faint} />
        </PressScale>
      ) : null}
      {!mining && onNewAddress ? (
        <>
          <SecondaryButton label={makingAddress ? 'Making a new address…' : 'New address'} onPress={() => void makeNewAddress()} disabled={makingAddress} />
          <Text style={styles.copyWarning}>
            {newAddressError || 'A new address for each payment keeps your history more private. Old addresses keep working.'}
          </Text>
        </>
      ) : null}
      {onOpenMining ? <SecondaryButton label="Mining" onPress={onOpenMining} /> : null}
      {onBack ? <SecondaryButton label="Back to Receive" onPress={onBack} /> : null}
    </>
  );
}

function ExplorerButton({ network, txid }: { network: PearlNetwork; txid: string }) {
  const [failed, setFailed] = useState(false);

  async function open() {
    setFailed(false);
    try {
      await Linking.openURL(pearlNetworks[network].explorer + '/tx/' + encodeURIComponent(txid));
    } catch {
      setFailed(true);
    }
  }

  return (
    <>
      <SecondaryButton label="View on explorer" onPress={open} />
      {failed ? <Text accessibilityRole="alert" style={styles.error}>Could not open the explorer.</Text> : null}
    </>
  );
}

function SecondaryButton({ label, onPress, disabled = false }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.textButton, (pressed || disabled) && styles.pressed]}
    >
      <Text style={styles.textButtonLabel}>{label}</Text>
    </Pressable>
  );
}

function CopyButton({ value, label, copiedLabel, secondary = false }: {
  value: string;
  label: string;
  copiedLabel: string;
  secondary?: boolean;
}) {
  const [feedback, setFeedback] = useState<'copied' | 'failed' | null>(null);
  const title = feedback === 'copied' ? copiedLabel : label;

  async function copyValue() {
    try {
      await setClipboardString(value);
      haptic('success');
      setFeedback('copied');
    } catch {
      setFeedback('failed');
    }
  }

  return (
    <>
      {secondary ? (
        <Pressable
          accessibilityLabel={title}
          accessibilityRole="button"
          onPress={() => void copyValue()}
          style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}
        >
          <Text style={styles.textButtonLabel}>{title}</Text>
        </Pressable>
      ) : (
        <SheetButton label={title} icon={feedback === 'copied' ? 'check' : 'copy'} onPress={() => void copyValue()} />
      )}
      {feedback === 'failed' ? (
        <Text accessibilityLiveRegion="polite" style={styles.copyFeedback}>Select the text to copy it.</Text>
      ) : null}
      {feedback === 'copied' ? (
        <Text accessibilityLiveRegion="polite" style={styles.copyFeedback}>Available on your clipboard</Text>
      ) : null}
    </>
  );
}

function SettingsRow({ title, hint, onPress, danger = false, disabled = false }: {
  title: string;
  hint?: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <PressScale
      accessibilityLabel={title}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      feedback="selection"
      scaleTo={0.98}
      style={styles.settingsRow}
    >
      <View style={styles.settingsText}>
        <Text style={[styles.fieldLabel, danger && styles.dangerLabel]}>{title}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <Feather name="chevron-right" size={17} color={muted} />
    </PressScale>
  );
}

/** One rounded glass card with hairlines between its rows. */
function SettingsGroup({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <View style={styles.settingsGroup}>
      {rows.map((row, index) => (
        <View key={index}>
          {index > 0 ? <View style={styles.settingsDivider} /> : null}
          {row}
        </View>
      ))}
    </View>
  );
}

function SettingsValue({ title, value }: { title: string; value: string }) {
  return (
    <View accessible accessibilityLabel={title + ': ' + value} style={styles.settingsRow}>
      <Text style={styles.fieldLabel}>{title}</Text>
      <Text style={styles.settingsValue}>{value}</Text>
    </View>
  );
}

function SettingsSwitch({ title, hint, value, onChange, disabled = false }: {
  title: string;
  hint?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.settingsRow}>
      <View style={styles.settingsText}>
        <Text style={styles.fieldLabel}>{title}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <Switch
        accessibilityLabel={title}
        disabled={disabled}
        onValueChange={(next) => {
          haptic('selection');
          onChange(next);
        }}
        trackColor={{ true: accent }}
        value={value}
      />
    </View>
  );
}

function SettingsContent({
  network, address, watchOnly, onWatchKey, backupVerified, pending, onSwitchNetwork, onOpenBackup, onOpenRemove,
  walletName, walletCount, onOpenWallets, onSupport, onOpenContacts,
}: Pick<
  WalletSheetProps, 'network' | 'address' | 'watchOnly' | 'onWatchKey' | 'backupVerified' | 'pending' | 'onSwitchNetwork'
> & {
  onOpenBackup: () => void;
  onOpenRemove: () => void;
  walletName: string;
  walletCount: number;
  onOpenWallets: () => void;
  onSupport?: () => void;
  onOpenContacts: () => void;
}) {
  const { contacts: savedContacts } = useContacts(network);
  const [watchKeyCopied, setWatchKeyCopied] = useState(false);
  async function copyWatchKey() {
    setError('');
    try {
      // The watch key reveals every address: keep it off other devices and let it expire.
      await copySensitive(await onWatchKey());
      haptic('success');
      setWatchKeyCopied(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not copy the watch key.');
    }
  }
  const { preferences, setPreference } = usePreferences();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const { version, build } = appVersion();
  const indexerHost = pearlNetworks[network].explorer.replace(/^https?:\/\//, '');

  async function switchNetwork(enabled: boolean) {
    const target = enabled ? 'testnet2' : 'mainnet';
    if (inFlight.current || target === network) return;
    inFlight.current = true;
    setSwitching(true);
    setError('');
    try {
      await onSwitchNetwork(target);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not switch networks.');
    } finally {
      inFlight.current = false;
      setSwitching(false);
    }
  }

  async function setAppLock(enabled: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setError('');
    try {
      // Changing the lock needs the device owner either way.
      await requireDeviceAuthentication('unlock');
      setPreference('appLock', enabled);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not change App lock.');
    } finally {
      inFlight.current = false;
    }
  }

  async function open(url: string) {
    try {
      await Linking.openURL(url);
    } catch {
      setError('Could not open the link.');
    }
  }

  return (
    <>
      <SheetHeading icon="settings" title="Settings" />
      {onSupport && network === 'mainnet' && !watchOnly ? (
        <PressScale
          accessibilityRole="button"
          accessibilityLabel="Support Pearlet. Send a tip to the team."
          onPress={onSupport}
          feedback="selection"
          scaleTo={0.98}
          style={styles.supportCard}
        >
          <Image source={pearlArt} style={styles.walletPearl} />
          <View style={styles.settingsText}>
            <Text style={styles.fieldLabel}>Support Pearlet</Text>
            <Text style={styles.hint}>Free, open source and independent. Tips keep it going.</Text>
          </View>
          <Feather name="chevron-right" size={17} color={muted} />
        </PressScale>
      ) : null}
      {address ? (
        <View style={styles.settingsSection}>
          <Text accessibilityRole="header" style={styles.settingsSectionTitle}>This wallet</Text>
          <SettingsGroup>
            <SettingsRow
              title={walletName}
              hint={(watchOnly ? 'Watch-only' : 'Wallet') + ' · ' + (walletCount > 1 ? walletCount + ' wallets · switch or rename' : 'Rename or add a wallet')}
              onPress={onOpenWallets}
              disabled={switching}
            />
            {watchOnly ? (
              <SettingsValue title="Recovery phrase" value="Not on this device" />
            ) : (
              <SettingsRow
                title="Recovery phrase"
                hint={backupVerified ? 'Backed up' : 'Not backed up yet'}
                onPress={onOpenBackup}
                disabled={switching}
              />
            )}
            <SettingsRow
              title={watchKeyCopied ? 'Watch key copied' : 'Copy watch key'}
              hint="Follow this wallet on another device. It can't spend."
              onPress={() => void copyWatchKey()}
              disabled={switching}
            />
          </SettingsGroup>
        </View>
      ) : null}
      <View style={styles.settingsSection}>
        <Text accessibilityRole="header" style={styles.settingsSectionTitle}>Address book</Text>
        <SettingsGroup>
          <SettingsRow
            title="Contacts"
            hint={savedContacts.length
              ? savedContacts.length + (savedContacts.length === 1 ? ' contact' : ' contacts') + ' on Pearl ' + pearlNetworks[network].label
              : 'Save people you pay often'}
            onPress={onOpenContacts}
            disabled={switching}
          />
        </SettingsGroup>
      </View>
      <View style={styles.settingsSection}>
        <Text accessibilityRole="header" style={styles.settingsSectionTitle}>Security & privacy</Text>
        <SettingsGroup>
          <SettingsSwitch
            title="App lock"
            hint={`${Platform.OS === 'ios' ? 'Face ID or passcode' : 'Fingerprint or screen lock'} when you return. All wallets.`}
            value={preferences.appLock}
            onChange={(next) => void setAppLock(next)}
          />
          <SettingsSwitch
            title="Hide balance"
            hint="Or tap the balance on Home."
            value={preferences.hideBalance}
            onChange={(next) => setPreference('hideBalance', next)}
          />
        </SettingsGroup>
      </View>
      <View style={styles.settingsSection}>
        <Text accessibilityRole="header" style={styles.settingsSectionTitle}>Preferences</Text>
        <SettingsGroup>
          {network === 'mainnet' ? (
            <SettingsSwitch
              title="Mining"
              hint="Show mining payouts and ripening pearls."
              value={preferences.showMiningPayouts}
              onChange={(next) => setPreference('showMiningPayouts', next)}
            />
          ) : null}
          <SettingsSwitch
            title="Haptics"
            value={preferences.haptics}
            onChange={(next) => setPreference('haptics', next)}
          />
          <SettingsSwitch
            title="Testnet2"
            hint={switching ? 'Switching networks…' : 'Separate wallets for test coins.'}
            value={network === 'testnet2'}
            onChange={(next) => void switchNetwork(next)}
            disabled={switching}
          />
        </SettingsGroup>
      </View>
      <View style={styles.settingsSection}>
        <Text accessibilityRole="header" style={styles.settingsSectionTitle}>About</Text>
        <SettingsGroup>
          <SettingsValue title="Version" value={version ? version + (build ? ' (' + build + ')' : '') : 'Unavailable'} />
          <SettingsValue title="Network" value={'Pearl ' + pearlNetworks[network].label} />
          <SettingsValue title="Indexer" value={indexerHost} />
          <SettingsRow title="Block explorer" onPress={() => void open(pearlNetworks[network].explorer)} />
          <SettingsRow title="Privacy policy" hint="pearlet.io" onPress={() => void open(privacyPolicyUrl)} />
          <SettingsRow title="Source code" hint="GitHub" onPress={() => void open(sourceCodeUrl)} />
        </SettingsGroup>
      </View>
      {address ? (
        <SettingsGroup>
          <SettingsRow
            title={watchOnly ? 'Stop watching this wallet' : 'Remove wallet from this device'}
            hint={watchOnly
              ? 'Nothing on the network changes.'
              : !backupVerified
              ? 'Back up your recovery phrase first.'
              : pending ? 'Wait for the pending transfer to sync.' : 'You will need your phrase to restore it.'}
            onPress={onOpenRemove}
            disabled={!backupVerified || Boolean(pending) || switching}
            danger
          />
        </SettingsGroup>
      ) : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </>
  );
}

const removeConfirmation = 'REMOVE';

function RemoveWalletContent({ network, watchOnly, onBack, onRemove }: {
  network: PearlNetwork;
  watchOnly: boolean;
  onBack: () => void;
  onRemove: () => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const confirmed = typed.trim().toUpperCase() === removeConfirmation;

  async function remove() {
    if (!confirmed || working) return;
    Keyboard.dismiss();
    setWorking(true);
    setError('');
    try {
      await onRemove();
      haptic('success');
    } catch (failure) {
      haptic('error');
      setError(failure instanceof Error ? failure.message : 'Could not remove this wallet.');
      setWorking(false);
    }
  }

  return (
    <>
      <SheetHeading
        icon="shield"
        title="Remove wallet"
        description={watchOnly
          ? 'This stops watching the Pearl ' + pearlNetworks[network].label + ' wallet on this device. You can watch it again later.'
          : 'This deletes your Pearl ' + pearlNetworks[network].label + ' wallet and its recovery phrase from this device. Your PRL stays on the network.'}
      />
      {!watchOnly ? (
        <View style={styles.reviewList}>
          <BackupTip text="Without your written recovery phrase, this wallet and its PRL cannot be recovered." />
          <BackupTip text="Make sure your backup is somewhere safe before continuing." />
        </View>
      ) : null}
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Type {removeConfirmation} to confirm</Text>
        <TextInput
          accessibilityLabel={'Type ' + removeConfirmation + ' to confirm'}
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect={false}
          editable={!working}
          onChangeText={(value) => {
            setTyped(value);
            setError('');
          }}
          placeholder={removeConfirmation}
          placeholderTextColor={palette.faint}
          spellCheck={false}
          style={styles.input}
          value={typed}
        />
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <PressScale
        accessibilityRole="button"
        accessibilityLabel="Authenticate and remove wallet"
        accessibilityState={{ disabled: !confirmed || working, busy: working }}
        disabled={!confirmed || working}
        onPress={() => void remove()}
        feedback="warning"
        scaleTo={0.97}
        style={[styles.button, styles.dangerButton]}
      >
        <Text style={[styles.buttonText, styles.dangerButtonText]}>{working ? 'Removing…' : 'Authenticate and remove'}</Text>
      </PressScale>
      <SecondaryButton label="Keep wallet" disabled={working} onPress={onBack} />
    </>
  );
}

type BackupStep = 'intro' | 'reveal' | 'check' | 'phrase' | 'done';

function BackupContent({
  network,
  backupVerified,
  onShowBackup,
  onVerifyBackup,
  onBackupQuiz,
  onBack,
  onDone,
}: Pick<WalletSheetProps, 'network' | 'backupVerified' | 'onShowBackup' | 'onVerifyBackup' | 'onBackupQuiz'> & {
  onBack?: () => void;
  onDone: () => void;
}) {
  const inFlight = useRef(false);
  const epoch = useRef(0);
  const authenticatingReveal = useRef(false);
  const [working, setWorking] = useState(false);
  const [step, setStep] = useState<BackupStep>('intro');
  const [phrase, setPhrase] = useState('');
  const [quiz, setQuiz] = useState<BackupQuizQuestion[]>([]);
  const [answers, setAnswers] = useState<Readonly<Record<number, string>>>({});
  const [words, setWords] = useState<string[]>(emptyPhrase);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const networkLabel = pearlNetworks[network].label;

  const clearOnBackground = useCallback(() => {
    // Android device authentication can open a separate Activity.
    if (Platform.OS !== 'android' || !authenticatingReveal.current) epoch.current += 1;
    setPhrase('');
    setQuiz([]);
    setAnswers({});
    setWords(emptyPhrase());
    setCopied(false);
    setError('');
    setStep((current) => (current === 'done' ? current : 'intro'));
  }, []);
  const captured = useScreenGuard();
  const sensitiveVisible = useSensitiveForeground(clearOnBackground) && !captured;

  useEffect(() => () => {
    epoch.current += 1;
  }, []);

  async function runBackup(operation: (request: number) => Promise<void>, fallback: string) {
    if (inFlight.current) return;
    const request = epoch.current;
    inFlight.current = true;
    setWorking(true);
    setError('');
    try {
      await operation(request);
    } catch (failure) {
      if (request === epoch.current) {
        haptic('error');
        setError(failure instanceof Error ? failure.message : fallback);
      }
    } finally {
      setWorking(false);
      inFlight.current = false;
    }
  }

  function revealPhrase() {
    void runBackup(async (request) => {
      authenticatingReveal.current = true;
      try {
        const nextPhrase = await onShowBackup();
        if (request === epoch.current && AppState.currentState === 'active') {
          setPhrase(nextPhrase);
          setStep('reveal');
        }
      } finally {
        authenticatingReveal.current = false;
      }
    }, 'Could not open your recovery phrase.');
  }

  function finish(request: number) {
    if (request !== epoch.current) return;
    haptic('success');
    setPhrase('');
    setQuiz([]);
    setAnswers({});
    setWords(emptyPhrase());
    setCopied(false);
    setStep('done');
  }

  function startQuiz() {
    void runBackup(async (request) => {
      const questions = await onBackupQuiz(phrase);
      if (request === epoch.current) {
        setQuiz(questions);
        setAnswers({});
        setStep('check');
      }
    }, 'Could not start the backup check.');
  }

  function copyPhrase() {
    void runBackup(async (request) => {
      await copySensitive(phrase);
      if (request === epoch.current) {
        haptic('success');
        setCopied(true);
      }
    }, 'Could not copy the recovery phrase.');
  }

  function checkWords() {
    Keyboard.dismiss();
    void runBackup(async (request) => {
      const words = phrase.split(' ');
      if (!quiz.length || quiz.some((question) => answers[question.position] !== words[question.position])) {
        throw new Error('Some words do not match. Check your written copy and try again.');
      }
      await onVerifyBackup(phrase);
      finish(request);
    }, 'Could not verify your backup.');
  }

  function checkFullPhrase() {
    Keyboard.dismiss();
    void runBackup(async (request) => {
      await onVerifyBackup(phraseFromWords(words));
      finish(request);
    }, 'Could not verify your recovery phrase.');
  }

  function restart() {
    setPhrase('');
    setQuiz([]);
    setAnswers({});
    setWords(emptyPhrase());
    setCopied(false);
    setError('');
    setStep('intro');
  }

  const alert = error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null;

  if (step === 'done') {
    return (
      <>
        <SuccessMark />
        <SheetHeading
          icon={null}
          title="Wallet backed up"
          description={'Keep your written phrase somewhere safe and offline. Anyone with it can spend from this ' + networkLabel + ' wallet.'}
        />
        <SheetButton label="Done" onPress={onBack ?? onDone} />
      </>
    );
  }

  if (step === 'reveal' && sensitiveVisible && phrase) {
    return (
      <>
        <SheetHeading
          icon="shield"
          title="Write these down"
          description="Use paper, in order. Don't screenshot or copy them to another app."
        />
        <RecoveryWords phrase={phrase} />
        {canCopyRecoveryPhrase ? (
          <>
            <SecondaryButton
              label={copied ? 'Copied for ' + sensitiveClipboardSeconds + ' seconds' : 'Copy to clipboard'}
              disabled={working}
              onPress={copyPhrase}
            />
            <Text style={styles.copyWarning}>
              {copied
                ? 'Paste it only into a password manager you trust. It stays on this phone and clears automatically.'
                : 'Paper is safest. If you copy, it stays on this phone and clears after a minute.'}
            </Text>
          </>
        ) : null}
        {alert}
        <SheetButton label="I've saved them" onPress={startQuiz} busy={working} disabled={working} />
        <SecondaryButton label="Hide and finish later" disabled={working} onPress={restart} />
      </>
    );
  }

  if (step === 'check' && sensitiveVisible && phrase) {
    const complete = quiz.every((question) => answers[question.position]);
    return (
      <>
        <SheetHeading icon="check" title="Quick check" description="Tap the right word for each number, using your saved copy." />
        <View style={styles.quiz}>
          {quiz.map((question) => (
            <View key={question.position} style={styles.quizRow}>
              <Text style={styles.quizLabel}>Word {question.position + 1}</Text>
              <View style={styles.quizChoices}>
                {question.choices.map((choice) => {
                  const selected = answers[question.position] === choice;
                  return (
                    <PressScale
                      key={choice}
                      accessibilityRole="radio"
                      accessibilityState={{ selected, disabled: working }}
                      accessibilityLabel={'Word ' + (question.position + 1) + ': ' + choice}
                      disabled={working}
                      feedback="selection"
                      scaleTo={0.94}
                      onPress={() => {
                        setAnswers((previous) => ({ ...previous, [question.position]: choice }));
                        setError('');
                      }}
                      pressableStyle={styles.quizChoiceTarget}
                      style={[styles.quizChoice, selected && styles.quizChoiceSelected]}
                    >
                      <Text style={[styles.quizChoiceText, selected && styles.quizChoiceTextSelected]}>{choice}</Text>
                    </PressScale>
                  );
                })}
              </View>
            </View>
          ))}
        </View>
        {alert}
        <SheetButton label="Confirm backup" onPress={checkWords} busy={working} disabled={working || !complete} />
        <SecondaryButton label="Show the words again" disabled={working} onPress={() => setStep('reveal')} />
      </>
    );
  }

  if (step === 'phrase' && sensitiveVisible) {
    return (
      <>
        <SheetHeading icon="check" title="Check your backup" description="Enter your recovery words. You can paste them all into the first box." />
        <PhraseInput
          words={words}
          editable={!working}
          onChange={(next) => {
            setWords(next);
            setError('');
          }}
        />
        {alert}
        <SheetButton label="Confirm backup" onPress={checkFullPhrase} busy={working} disabled={working || words.some((word) => !word)} />
        <SecondaryButton label="Back" disabled={working} onPress={restart} />
      </>
    );
  }

  return (
    <>
      <SheetHeading
        icon="shield"
        title={backupVerified ? 'Recovery phrase' : 'Back up your wallet'}
        description={backupVerified
          ? 'Your backup is verified. You can view the words again with device authentication.'
          : 'Your recovery phrase is the only way to restore this ' + networkLabel + ' wallet if you lose this phone.'}
      />
      {!backupVerified ? (
        <View style={styles.reviewList}>
          <BackupTip text="Find a private place where no one can see your screen." />
          <BackupTip text="Have paper and a pen ready. It takes about a minute." />
          <BackupTip text="Never share these words. Pearlet will never ask for them." />
        </View>
      ) : null}
      {captured ? <Text accessibilityRole="alert" style={styles.error}>{captureNotice}</Text> : null}
      {alert}
      <SheetButton
        label={backupVerified ? 'View recovery phrase' : "I'm somewhere private"}
        onPress={revealPhrase}
        busy={working}
        disabled={working || !sensitiveVisible}
      />
      {!backupVerified ? (
        <SecondaryButton label="I already wrote it down" disabled={working} onPress={() => setStep('phrase')} />
      ) : null}
      {onBack ? <SecondaryButton label="Back to Settings" disabled={working} onPress={onBack} /> : null}
    </>
  );
}

function BackupTip({ text }: { text: string }) {
  return (
    <View style={styles.tipRow}>
      <View style={styles.tipDot} />
      <Text style={styles.tipText}>{text}</Text>
    </View>
  );
}

function SwapContent({ onClose }: { onClose: () => void }) {
  return (
    <>
      <SheetHeading
        icon="arrow-left-right"
        title="Swap PRL"
        description="Live quotes and swaps through NEAR Intents are planned for a future build."
      />
      <SheetButton label="Done" onPress={onClose} />
    </>
  );
}

function ActivityContent({ network, activity }: { network: PearlNetwork; activity: WalletActivity }) {
  const received = activity.kind === 'receive';
  const amount = formatPrl(Math.abs(activity.amountGrains));
  const sign = activity.kind === 'self' || activity.amountGrains === 0 ? '' : received ? '+' : '−';
  const icon = activity.kind === 'self' ? 'repeat' : received ? 'arrow-down' : 'arrow-up';

  return (
    <>
      <SheetHeading icon={icon} title={activity.title} description={activity.subtitle} />
      <Text style={[styles.activityAmount, received && styles.receivedAmount]}>
        {sign}{amount} PRL
      </Text>
      <View style={styles.reviewList}>
        {activity.recipient ? <ReviewRow label={received ? 'From' : 'To'} value={activity.recipient} /> : null}
        {activity.feeGrains !== undefined ? (
          <ReviewRow label="Network fee" value={`${formatPrl(activity.feeGrains)} PRL`} />
        ) : null}
        <Text style={styles.reviewLabel}>Transaction ID</Text>
        <Text selectable style={styles.reviewAddress}>{activity.id}</Text>
      </View>
      <ExplorerButton network={network} txid={activity.id} />
    </>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(22, 17, 32, 0.32)',
  },
  sheet: {
    width: '100%',
    maxWidth: 472,
    maxHeight: '94%',
    backgroundColor: '#FBFAFD',
    overflow: 'hidden',
    borderTopLeftRadius: 34,
    borderTopRightRadius: 34,
    borderWidth: 1,
    borderColor: palette.glassBorder,
    paddingHorizontal: 24,
    paddingTop: 10,
    boxShadow: '0 -15px 56px rgba(33, 32, 57, 0.13)',
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(108, 86, 135, 0.26)',
  },
  closePosition: {
    position: 'absolute',
    zIndex: 1,
    right: 16,
    top: 16,
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.86)',
    backgroundColor: 'transparent',
  },
  body: {
    paddingTop: 20,
    paddingBottom: 2,
  },
  bodyInner: {
    gap: 19,
  },
  dangerLabel: { color: palette.danger },
  dangerButton: { backgroundColor: 'rgba(164, 56, 86, 0.1)', borderColor: 'rgba(164, 56, 86, 0.35)' },
  dangerButtonText: { color: palette.danger },
  requestSummary: { color: ink, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  fieldHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fieldAction: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 4 },
  contactRow: { gap: 8, paddingRight: 8 },
  contactChip: {
    height: 34,
    maxWidth: 160,
    paddingHorizontal: 14,
    borderRadius: 17,
    justifyContent: 'center',
    backgroundColor: palette.glassStrong,
    borderWidth: 1,
    borderColor: 'rgba(22, 19, 31, 0.08)',
  },
  contactChipSelected: { backgroundColor: 'rgba(214, 204, 245, 0.75)', borderColor: 'rgba(75, 61, 102, 0.35)' },
  contactChipText: { color: ink, fontSize: 14, fontWeight: '600' },
  contactChipQuiet: { backgroundColor: 'transparent' },
  contactChipQuietText: { color: accent },
  contactBrowser: { gap: 8 },
  contactResults: { maxHeight: 248 },
  contactResult: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 46,
    paddingHorizontal: 14,
    marginBottom: 6,
    borderRadius: 14,
    backgroundColor: palette.glassStrong,
  },
  contactSaveRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  contactNameInput: { flex: 1 },
  speedRow: { flexDirection: 'row', gap: 8 },
  speedTarget: { flex: 1 },
  speedOption: {
    minHeight: 54,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(22, 19, 31, 0.08)',
    backgroundColor: palette.glassStrong,
  },
  speedOptionSelected: { backgroundColor: 'rgba(214, 204, 245, 0.75)', borderColor: 'rgba(75, 61, 102, 0.35)' },
  speedTitle: { color: ink, fontSize: 15, fontWeight: '500' },
  speedTitleSelected: { fontWeight: '700' },
  speedHint: { color: muted, fontSize: 11 },
  pearlList: { gap: 8 },
  supportTipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: palette.glassBorder,
    backgroundColor: palette.glass,
  },
  supportCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: palette.glassBorder,
    backgroundColor: palette.glassStrong,
  },
  walletGroup: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: palette.glassBorder,
    backgroundColor: palette.glassStrong,
    overflow: 'hidden',
  },
  walletRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 62, paddingLeft: 14, paddingRight: 10 },
  walletDivider: { height: StyleSheet.hairlineWidth, marginLeft: 64, backgroundColor: 'rgba(22, 19, 31, 0.12)' },
  walletPearl: { width: 30, height: 30, resizeMode: 'contain' },
  walletPearlSlot: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  walletPearlRing: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  walletPearlRingActive: { borderColor: 'rgba(75, 61, 102, 0.28)', backgroundColor: 'rgba(255, 255, 255, 0.55)' },
  walletRowText: { flex: 1, justifyContent: 'center', gap: 2 },
  walletRowName: { color: ink, fontSize: 16, fontWeight: '600' },
  walletRowMeta: { color: muted, fontSize: 13 },
  walletAddText: { flex: 1, color: accent },
  contactEditor: { gap: 6, paddingHorizontal: 16, paddingVertical: 10 },
  contactEditorActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 16 },
  contactAddressInput: { flex: 1, fontSize: 14, fontWeight: '500' },
  walletEdit: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  walletNameInput: { flex: 1, color: ink, fontSize: 16, fontWeight: '600', paddingVertical: 12 },
  pearlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 16,
    backgroundColor: palette.glass,
    borderWidth: 1,
    borderColor: palette.glassBorder,
  },
  pearlRowText: { flex: 1, gap: 8 },
  pearlChoice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 48,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(22, 19, 31, 0.08)',
    backgroundColor: palette.glassStrong,
  },
  pearlDot: { width: 26, height: 26, resizeMode: 'contain' },
  pearlDotIdle: { opacity: 0.45 },
  pearlAmount: { flex: 1, color: ink, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  pearlMeta: { color: muted, fontSize: 12 },
  ripeTrack: { height: 4, borderRadius: 2, backgroundColor: 'rgba(22, 19, 31, 0.07)', overflow: 'hidden' },
  ripeFill: { height: 4, borderRadius: 2, backgroundColor: accent },
  copyWarning: { color: muted, fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: -12, paddingHorizontal: 12 },
  quiz: { gap: 16 },
  quizRow: { gap: 8 },
  quizLabel: { color: muted, fontSize: 13, fontWeight: '600' },
  quizChoices: { flexDirection: 'row', gap: 8 },
  quizChoiceTarget: { flex: 1 },
  quizChoice: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(22, 19, 31, 0.08)',
    backgroundColor: palette.glassStrong,
  },
  quizChoiceSelected: { backgroundColor: 'rgba(214, 204, 245, 0.75)', borderColor: 'rgba(75, 61, 102, 0.35)' },
  quizChoiceText: { color: ink, fontSize: 15, fontWeight: '500' },
  quizChoiceTextSelected: { fontWeight: '700' },
  tipRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  tipDot: { width: 6, height: 6, borderRadius: 3, marginTop: 7, backgroundColor: palette.faint },
  tipText: { flex: 1, color: ink, fontSize: 14, lineHeight: 20 },
  backupHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 246, 232, 0.7)',
    borderWidth: 1,
    borderColor: 'rgba(213, 154, 59, 0.22)',
  },
  backupHintText: { flex: 1, color: ink, fontSize: 13, lineHeight: 18 },
  successWrap: {
    alignSelf: 'center',
    width: 96,
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: -6,
  },
  successRing: {
    position: 'absolute',
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    borderColor: palette.positive,
  },
  sendingStage: { alignSelf: 'center', height: 132, width: 160, alignItems: 'center', justifyContent: 'flex-end', marginTop: -8, marginBottom: -4 },
  settingWrap: { width: 88, height: 88, alignItems: 'center', justifyContent: 'center' },
  settingGlint: {
    position: 'absolute',
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.95)',
    boxShadow: '0 0 18px rgba(255, 255, 255, 0.9)',
  },
  flyingPearl: { position: 'absolute', width: 64, height: 64, resizeMode: 'contain' },
  successStamp: {
    width: 72,
    height: 72,
    borderRadius: 36,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: palette.glassBorder,
    boxShadow: '0 10px 26px rgba(35, 112, 95, 0.18)',
  },
  heading: {
    alignItems: 'center',
    gap: 7,
  },
  stamp: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 26,
    marginBottom: 4,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: palette.glassBorder,
    boxShadow: '0 8px 20px rgba(40, 28, 66, 0.1)',
  },
  title: {
    color: ink,
    fontSize: 24,
    fontWeight: '600',
    letterSpacing: -0.6,
    textAlign: 'center',
  },
  description: {
    color: muted,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  settingsSection: { gap: 8 },
  settingsSectionTitle: { fontSize: 16, fontWeight: '700', color: ink },
  settingsRow: {
    minHeight: 56,
    paddingVertical: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  settingsGroup: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: palette.glassBorder,
    backgroundColor: palette.glassStrong,
    overflow: 'hidden',
  },
  settingsDivider: { height: StyleSheet.hairlineWidth, marginLeft: 16, backgroundColor: 'rgba(22, 19, 31, 0.12)' },
  settingsValue: { color: muted, fontSize: 15 },
  settingsText: { gap: 4, flexShrink: 1 },
  fields: {
    gap: 16,
  },
  field: {
    gap: 6,
  },
  fieldLabel: {
    color: ink,
    fontSize: 14,
    fontWeight: '600',
  },
  input: {
    minHeight: 51,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 15,
    borderColor: 'rgba(22, 19, 31, 0.08)',
    backgroundColor: palette.glassStrong,
    color: ink,
    fontSize: 16,
  },
  phraseInput: {
    minHeight: 90,
    textAlignVertical: 'top',
  },
  amountField: {
    justifyContent: 'center',
  },
  amountInput: {
    paddingRight: 65,
  },
  amountUnit: {
    position: 'absolute',
    right: 14,
    color: muted,
    fontSize: 13,
    fontWeight: '600',
  },
  hint: {
    color: muted,
    fontSize: 13,
  },
  centerHint: { color: muted, fontSize: 13, textAlign: 'center' },
  error: {
    color: palette.danger,
    fontSize: 14,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    minHeight: 54,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 27,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: palette.glassBorder,
    backgroundColor: 'transparent',
  },
  buttonText: {
    color: ink,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.72,
  },
  textButton: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    marginTop: -8,
  },
  textButtonLabel: {
    color: accent,
    fontSize: 13,
    fontWeight: '600',
  },
  reviewList: {
    gap: 13,
    padding: 16,
    borderRadius: 17,
    backgroundColor: palette.glass,
    borderWidth: 1,
    borderColor: palette.glassBorder,
  },
  reviewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  reviewLabel: {
    color: muted,
    fontSize: 14,
  },
  reviewValue: {
    color: ink,
    flexShrink: 1,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'right',
  },
  reviewAddress: {
    color: ink,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 13,
    lineHeight: 19,
  },
  reviewDivider: {
    height: 1,
    backgroundColor: 'rgba(22, 19, 31, 0.08)',
  },
  qr: {
    padding: 4,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
  },
  addressCard: {
    gap: 8,
    alignItems: 'center',
    padding: 16,
    borderRadius: 17,
    backgroundColor: palette.glass,
    borderWidth: 1,
    borderColor: palette.glassBorder,
  },
  address: {
    width: '100%',
    color: accent,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 14,
    textAlign: 'center',
  },
  copyFeedback: {
    color: muted,
    marginTop: -9,
    fontSize: 13,
    textAlign: 'center',
  },
  activityAmount: {
    color: ink,
    fontSize: 32,
    fontWeight: '700',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    letterSpacing: -1,
  },
  receivedAmount: {
    color: palette.positive,
  },
});
