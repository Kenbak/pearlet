import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import Feather from './Feather';
import { PearletMark, PearlButtonFill, Wordmark, palette } from './PearlDesign';
import { PressScale, Rise, haptic } from './motion';
import { captureNotice, useScreenGuard } from './screen-guard';
import PhraseInput, { emptyPhrase, phraseFromWords } from './PhraseInput';
import { pearlNetworks, type PearlNetwork } from './pearl-network';
import type { RestorePreview } from './wallet-backup';

const { ink, muted, accent } = palette;

type OnboardingProps = {
  network: PearlNetwork;
  busy: boolean;
  error: string | null;
  onOpenSettings: () => void;
  onCreate: () => Promise<void>;
  onPreviewRestore: (phrase: string, expectedAddress?: string) => Promise<RestorePreview>;
  onRestore: (phrase: string, preview: RestorePreview) => Promise<void>;
  onWatch: (input: string) => Promise<void>;
  /** Return to the previous wallet when this setup was started from the switcher. */
  onCancel?: () => void;
};

type SetupStep =
  | { kind: 'start' }
  | { kind: 'restore' }
  | { kind: 'watch' }
  | { kind: 'confirmRestore'; preview: RestorePreview };

export function useSensitiveForeground(clearOnBackground: () => void) {
  const [visible, setVisible] = useState(() => AppState.currentState === 'active');

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      setVisible(next === 'active');
      if (next === 'background') clearOnBackground();
    });
    setVisible(AppState.currentState === 'active');
    return () => subscription.remove();
  }, [clearOnBackground]);

  return visible;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default function Onboarding({
  network,
  busy,
  error,
  onOpenSettings,
  onCreate,
  onPreviewRestore,
  onRestore,
  onWatch,
  onCancel,
}: OnboardingProps) {
  const [watchInput, setWatchInput] = useState('');
  const [step, setStep] = useState<SetupStep>({ kind: 'start' });
  const [words, setWords] = useState<string[]>(emptyPhrase);
  const phrase = phraseFromWords(words);
  const [expectedAddress, setExpectedAddress] = useState('');
  const [localError, setLocalError] = useState('');
  const [working, setWorking] = useState(false);
  const inFlight = useRef(false);
  const draftEpoch = useRef(0);
  const authenticatedSetup = useRef<'create' | 'restore' | null>(null);
  const networkName = pearlNetworks[network].label;
  const disabled = busy || working;
  const message = error || localError;

  const clearOnBackground = useCallback(() => {
    // Android's system credential picker can put the app in background.
    const credentialActivity = Platform.OS === 'android' ? authenticatedSetup.current : null;
    if (!credentialActivity) draftEpoch.current += 1;
    setStep({ kind: credentialActivity === 'restore' ? 'restore' : 'start' });
    setWords(emptyPhrase());
    setExpectedAddress('');
    setLocalError('');
  }, []);
  const captured = useScreenGuard();
  const sensitiveVisible = useSensitiveForeground(clearOnBackground) && !captured;

  useEffect(() => () => {
    draftEpoch.current += 1;
  }, []);

  async function runSetup(
    operation: (epoch: number) => Promise<void>,
    fallback: string,
    authenticated: 'create' | 'restore' | null = null,
  ) {
    if (inFlight.current || busy) return;
    Keyboard.dismiss();
    const epoch = draftEpoch.current;
    inFlight.current = true;
    authenticatedSetup.current = authenticated;
    setWorking(true);
    setLocalError('');
    try {
      await operation(epoch);
    } catch (failure) {
      if (epoch === draftEpoch.current) {
        haptic('error');
        setLocalError(errorText(failure, fallback));
      }
    } finally {
      authenticatedSetup.current = null;
      inFlight.current = false;
      setWorking(false);
    }
  }

  function createWallet() {
    void runSetup(async () => {
      await onCreate();
      haptic('success');
    }, 'Could not create your wallet. Try again.', 'create');
  }

  function reviewRestore() {
    void runSetup(async (epoch) => {
      const preview = await onPreviewRestore(phrase, expectedAddress.trim() || undefined);
      if (epoch === draftEpoch.current) setStep({ kind: 'confirmRestore', preview });
    }, 'Could not derive the wallet addresses. Check the phrase and try again.');
  }

  function restore(preview: RestorePreview) {
    void runSetup(async () => {
      await onRestore(phrase, preview);
    }, 'Could not restore this wallet. Try again.', 'restore');
  }

  function watch() {
    void runSetup(async () => {
      await onWatch(watchInput);
      haptic('success');
    }, 'Could not watch this wallet. Try again.');
  }

  function changeStep(next: SetupStep) {
    setLocalError('');
    setStep(next);
  }

  function goToStart() {
    setWords(emptyPhrase());
    setExpectedAddress('');
    changeStep({ kind: 'start' });
  }

  const alert = message ? <Text accessibilityRole="alert" style={styles.error}>{message}</Text> : null;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.screen}
    >
      <ScrollView
        contentContainerStyle={[styles.scroll, step.kind === 'start' && styles.welcomeScroll]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.page, step.kind === 'start' && styles.welcomePage]}>
          <View style={styles.topBar}>
            {network !== 'mainnet' && step.kind !== 'start' ? (
              <View style={styles.networkBadge}>
                <View style={styles.networkDot} />
                <Text style={styles.networkLabel}>{networkName}</Text>
              </View>
            ) : <View />}
          </View>

          {step.kind === 'start' ? (
            <>
              <View style={styles.welcomeHero}>
                <Rise distance={20}>
                  <PearletMark size={88} />
                </Rise>
                <Rise delay={90} style={styles.welcomeText}>
                  <View accessible accessibilityRole="header" accessibilityLabel="Pearlet">
                    <Wordmark size={54} />
                  </View>
                  <Text style={styles.welcomeTagline}>
                    {network === 'testnet2' ? 'A separate wallet for Pearl Testnet2 coins.' : 'The simple wallet for Pearl.'}
                  </Text>
                </Rise>
              </View>
              <Rise delay={180} style={styles.actions}>
                {alert}
                <SetupButton label="Create a new wallet" onPress={createWallet} disabled={disabled} busy={working} />
                <SetupButton
                  label="Add an existing wallet"
                  onPress={() => changeStep({ kind: 'restore' })}
                  disabled={disabled}
                  secondary
                />
                {onCancel ? (
                  <SetupButton label="Cancel" onPress={onCancel} disabled={disabled} secondary />
                ) : null}
                <PressScale
                  accessibilityRole="button"
                  accessibilityLabel={'Network: Pearl ' + networkName + '. Change network'}
                  accessibilityState={{ disabled }}
                  disabled={disabled}
                  onPress={onOpenSettings}
                  feedback="selection"
                  pressableStyle={styles.networkLinkTarget}
                  style={styles.networkLink}
                >
                  <Text style={styles.networkLinkText}>Pearl {networkName} · <Text style={styles.networkLinkAction}>Change</Text></Text>
                </PressScale>
              </Rise>
            </>
          ) : null}

          {captured && (step.kind === 'restore' || step.kind === 'confirmRestore') ? (
            <Text accessibilityRole="alert" style={styles.error}>{captureNotice}</Text>
          ) : null}

          {step.kind === 'restore' && sensitiveVisible ? (
            <>
              <Text accessibilityRole="header" style={styles.title}>Restore wallet</Text>
              <Text style={styles.description}>
                Enter the 12 or 24 words of your {networkName} wallet. You can paste them all into the first box.
              </Text>
              <PhraseInput
                label="Pearlet recovery phrase"
                words={words}
                editable={!disabled}
                onChange={(next) => {
                  setWords(next);
                  setLocalError('');
                }}
              />
              <TextInput
                accessibilityLabel="Known Pearlet address, optional"
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                editable={!disabled}
                maxLength={128}
                onChangeText={(value) => {
                  setExpectedAddress(value);
                  setLocalError('');
                }}
                placeholder="Known Pearlet address (optional)"
                placeholderTextColor={muted}
                spellCheck={false}
                style={styles.addressInput}
                value={expectedAddress}
              />
              {alert}
              <View style={styles.actions}>
                <SetupButton
                  label="Review addresses"
                  onPress={reviewRestore}
                  disabled={disabled || words.some((word) => !word)}
                  busy={working || busy}
                />
                <SetupButton label="Back" onPress={goToStart} disabled={disabled} secondary />
                <PressScale
                  accessibilityRole="button"
                  disabled={disabled}
                  onPress={() => changeStep({ kind: 'watch' })}
                  feedback="selection"
                  pressableStyle={styles.networkLinkTarget}
                  style={styles.networkLink}
                >
                  <Text style={styles.networkLinkText}>No phrase? <Text style={styles.networkLinkAction}>Watch only</Text></Text>
                </PressScale>
              </View>
            </>
          ) : null}

          {step.kind === 'watch' ? (
            <>
              <Text accessibilityRole="header" style={styles.title}>Watch a wallet</Text>
              <Text style={styles.description}>
                Follow a balance without its recovery phrase. Paste a {networkName} address, or the watch key from
                another Pearlet's Settings to follow all of its addresses. A watched wallet can receive but not send.
              </Text>
              <TextInput
                accessibilityLabel="Address or watch key"
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                editable={!disabled}
                multiline
                maxLength={200}
                onChangeText={(value) => {
                  setWatchInput(value.trim());
                  setLocalError('');
                }}
                placeholder={pearlNetworks[network].hrp + '1p… or ' + pearlNetworks[network].hrp + 'watch1…'}
                placeholderTextColor={muted}
                spellCheck={false}
                style={styles.addressInput}
                value={watchInput}
              />
              {alert}
              <View style={styles.actions}>
                <SetupButton label="Watch wallet" onPress={watch} disabled={disabled || !watchInput} busy={working || busy} />
                <SetupButton label="Back" onPress={() => changeStep({ kind: 'restore' })} disabled={disabled} secondary />
              </View>
            </>
          ) : null}

          {step.kind === 'confirmRestore' && sensitiveVisible ? (
            <>
              <Text accessibilityRole="header" style={styles.title}>Review restored addresses</Text>
              <Text style={styles.description}>Check these against your previous wallet, then authenticate to restore it.</Text>
              <View style={styles.restorePreview}>
                <Text style={styles.restoreLabel}>Receive address</Text>
                <Text selectable style={styles.restoreAddress}>{step.preview.address}</Text>
                {step.preview.miningAddress ? (
                  <>
                    <Text style={styles.restoreLabel}>Mining payout address</Text>
                    <Text selectable style={styles.restoreAddress}>{step.preview.miningAddress}</Text>
                  </>
                ) : null}
              </View>
              {alert}
              <View style={styles.actions}>
                <SetupButton
                  label="Restore wallet"
                  onPress={() => restore(step.preview)}
                  disabled={disabled}
                  busy={working || busy}
                />
                <SetupButton
                  label="Back"
                  onPress={() => changeStep({ kind: 'restore' })}
                  disabled={disabled}
                  secondary
                />
              </View>
            </>
          ) : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function RecoveryWords({ phrase }: { phrase: string }) {
  return (
    <View style={styles.words}>
      {phrase.trim().split(/\s+/).map((word, index) => (
        <View key={index} style={styles.word}>
          <Text style={styles.wordIndex}>{index + 1}</Text>
          <Text style={styles.wordLabel}>{word}</Text>
        </View>
      ))}
    </View>
  );
}

function SetupButton({ label, onPress, disabled, busy = false, secondary = false }: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  busy?: boolean;
  secondary?: boolean;
}) {
  return (
    <PressScale
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ busy, disabled }}
      disabled={disabled}
      onPress={onPress}
      feedback={secondary ? 'light' : 'medium'}
      style={[styles.button, secondary && styles.secondaryButton]}
    >
      {secondary ? null : <PearlButtonFill variant="primary" />}
      {busy ? <ActivityIndicator color={ink} /> : null}
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{label}</Text>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center' },
  page: {
    width: '100%',
    maxWidth: 448,
    alignSelf: 'center',
    gap: 13,
    paddingHorizontal: 24,
    paddingVertical: 40,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  settingsButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.86)',
    backgroundColor: 'transparent',
  },
  networkBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 11,
    borderRadius: 20,
    backgroundColor: palette.glass,
    borderWidth: 1,
    borderColor: palette.glassBorder,
  },
  networkDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: '#34A788' },
  networkLabel: { fontSize: 13, fontWeight: '600', color: ink },
  title: { color: ink, fontSize: 30, fontWeight: '600', letterSpacing: -0.9 },
  welcomeScroll: { justifyContent: 'flex-start' },
  welcomePage: { flexGrow: 1, paddingTop: 12, paddingBottom: 28 },
  welcomeHero: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 22, paddingVertical: 40 },
  welcomeText: { alignItems: 'center', gap: 8 },
  welcomeTitle: { color: ink, fontSize: 40, fontWeight: '600', letterSpacing: -1.4 },
  networkLinkTarget: { alignSelf: 'center' },
  networkLink: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  networkLinkText: { color: palette.faint, fontSize: 13, textAlign: 'center' },
  networkLinkAction: { color: muted, fontWeight: '600' },
  welcomeTagline: { color: muted, fontSize: 16, lineHeight: 22, textAlign: 'center' },
  description: { color: muted, fontSize: 16, lineHeight: 23 },
  actions: { gap: 10, paddingTop: 8 },
  button: {
    minHeight: 54,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 27,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: palette.glassBorder,
    backgroundColor: 'transparent',
    boxShadow: '0 8px 24px rgba(40, 28, 66, 0.12), 0 1px 2px rgba(40, 28, 66, 0.06)',
  },
  secondaryButton: {
    borderWidth: 0,
    boxShadow: 'none',
  },
  buttonText: { color: ink, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  secondaryButtonText: { color: ink },
  pressed: { opacity: 0.65 },
  addressInput: {
    minHeight: 50,
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: 'rgba(22, 19, 31, 0.08)',
    backgroundColor: 'rgba(255, 255, 255, 0.78)',
    color: ink,
    fontSize: 15,
  },
  restorePreview: {
    padding: 15,
    gap: 9,
    borderRadius: 17,
    backgroundColor: 'rgba(255, 255, 255, 0.58)',
  },
  restoreLabel: { color: ink, fontSize: 14, fontWeight: '600' },
  restoreAddress: {
    color: accent,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 13,
    lineHeight: 19,
  },
  challenge: { gap: 8 },
  error: { color: palette.danger, fontSize: 14, lineHeight: 20 },
  words: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    padding: 12,
    borderRadius: 17,
    backgroundColor: 'rgba(255, 255, 255, 0.58)',
  },
  word: {
    flexBasis: '45%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 7,
    minHeight: 36,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: '#EEEAF6',
    backgroundColor: 'rgba(255, 255, 255, 0.78)',
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  wordIndex: { color: muted, minWidth: 16, fontSize: 12, fontVariant: ['tabular-nums'] },
  wordLabel: { color: ink, fontSize: 14, fontWeight: '600', flexShrink: 1 },
});
