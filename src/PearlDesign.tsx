import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Easing,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Svg, { Circle, Defs, Ellipse, LinearGradient, Path, RadialGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';

import Gradient from './Gradient';

const pearl = require('../assets/pearl.png');
const PearlMotion = createContext<Animated.Value | null>(null);

export const palette = {
  ink: '#16131F',
  muted: '#6B6579',
  faint: '#9A94A8',
  accent: '#4B3D66',
  positive: '#23705F',
  danger: '#A43856',
  warning: '#B57A24',
  onDark: '#FBF8FF',
  hairline: 'rgba(22, 19, 31, 0.07)',
  glass: 'rgba(255, 255, 255, 0.4)',
  glassStrong: 'rgba(255, 255, 255, 0.66)',
  glassBorder: 'rgba(255, 255, 255, 0.85)',
} as const;

// Iridescent light that sits underneath the frosted veil. Each orb drifts on
// the shared phase so the whole surface shifts slowly like nacre.
const orbs = [
  { color: '#AFD3F7', x: -0.32, y: -0.08, size: 1.05, dx: 26, dy: 34, opacity: 1 },
  { color: '#D9C2F4', x: 0.42, y: 0.06, size: 1.1, dx: -34, dy: 22, opacity: 1 },
  { color: '#F6C6DC', x: 0.05, y: 0.44, size: 1.0, dx: 30, dy: -26, opacity: 0.9 },
  { color: '#BFE7DD', x: 0.55, y: 0.62, size: 0.95, dx: -22, dy: -30, opacity: 0.85 },
  { color: '#D6CCF5', x: -0.2, y: 0.82, size: 1.0, dx: 24, dy: -20, opacity: 0.8 },
] as const;

const surfaces = {
  screen: { base: ['#F8F6FC', '#F1ECF8', '#ECEEF8'], frost: 0.16, pearl: 0.5, pearlSize: 1.15, pearlTop: '6%', pearlRight: -0.42, scale: 1 },
  sheet: { base: ['#FBFAFD', '#F4EFFA', '#EFEFF8'], frost: 0.3, pearl: 0.4, pearlSize: 0.9, pearlTop: '-18%', pearlRight: -0.32, scale: 0.85 },
} as const;

export function PearlMotionProvider({ children }: { children: ReactNode }) {
  const [phase] = useState(() => new Animated.Value(0));
  const [reduceMotion, setReduceMotion] = useState(true);
  const [foreground, setForeground] = useState(() => AppState.currentState === 'active');

  useEffect(() => {
    let mounted = true;
    let receivedUpdate = false;
    const reduceMotionListener = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
      receivedUpdate = true;
      setReduceMotion(value);
    });
    const appStateListener = AppState.addEventListener('change', state => setForeground(state === 'active'));
    setForeground(AppState.currentState === 'active');
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (mounted && !receivedUpdate) setReduceMotion(value);
    }).catch(() => {});

    return () => {
      mounted = false;
      reduceMotionListener.remove();
      appStateListener.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      phase.setValue(0);
      return;
    }
    if (!foreground) return;

    const drift = Animated.loop(Animated.sequence([
      Animated.timing(phase, {
        toValue: 1,
        duration: 14_000,
        easing: Easing.inOut(Easing.sin),
        isInteraction: false,
        useNativeDriver: true,
      }),
      Animated.timing(phase, {
        toValue: 0,
        duration: 16_000,
        easing: Easing.inOut(Easing.sin),
        isInteraction: false,
        useNativeDriver: true,
      }),
    ]));
    drift.start();
    return () => drift.stop();
  }, [phase, reduceMotion, foreground]);

  return <PearlMotion.Provider value={phase}>{children}</PearlMotion.Provider>;
}

function drift(phase: Animated.Value | null, dx: number, dy: number, scale = 1.06) {
  if (!phase) return undefined;
  return {
    transform: [
      { translateX: phase.interpolate({ inputRange: [0, 1], outputRange: [0, dx] }) },
      { translateY: phase.interpolate({ inputRange: [0, 1], outputRange: [0, dy] }) },
      { scale: phase.interpolate({ inputRange: [0, 1], outputRange: [1, scale] }) },
    ],
  };
}

function Orb({ color, size, opacity }: { color: string; size: number; opacity: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <RadialGradient id="orb" cx="50" cy="50" r="50" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={color} stopOpacity={opacity} />
          <Stop offset="0.55" stopColor={color} stopOpacity={opacity * 0.45} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx="50" cy="50" r="50" fill="url(#orb)" />
    </Svg>
  );
}

/**
 * Full-bleed iridescent pearl light under a frosted veil. React Native has no
 * cross-platform backdrop blur, so the light itself is pre-softened (radial
 * falloff and a heavily blurred pearl render) and then frosted with a white
 * veil, which reads as glass over nacre.
 */
export function PearlBackdrop({ variant = 'screen' }: { variant?: keyof typeof surfaces }) {
  const phase = useContext(PearlMotion);
  const { width, height } = useWindowDimensions();
  const surface = surfaces[variant];
  const unit = Math.min(width, 520) * surface.scale;
  const pearlSize = Math.min(width * surface.pearlSize, 600);

  return (
    <View pointerEvents="none" style={styles.backdrop} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Gradient colors={surface.base} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      {orbs.map((orb, index) => {
        const size = unit * orb.size * 1.4;
        return (
          <Animated.View
            key={index}
            style={[
              styles.layer,
              { width: size, height: size, left: width * orb.x, top: Math.min(height, 900) * orb.y },
              drift(phase, orb.dx, orb.dy, 1.08),
            ]}
          >
            <Orb color={orb.color} size={size} opacity={orb.opacity} />
          </Animated.View>
        );
      })}
      <Animated.Image
        source={pearl}
        accessible={false}
        blurRadius={30}
        style={[
          styles.layer,
          styles.texture,
          {
            width: pearlSize,
            height: pearlSize,
            right: pearlSize * surface.pearlRight,
            top: surface.pearlTop,
            opacity: surface.pearl,
          },
          drift(phase, -22, 32, 1.065),
        ]}
      />
      {/* Frost: a milky veil plus a cool sheen so text on top stays crisp. */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(255, 255, 255, ${surface.frost})` }]} />
      <Gradient
        colors={['#FFFFFF', '#FFFFFF', '#F7F3FC']}
        opacities={[0.4, 0, 0.25]}
        locations={[0, 0.35, 1]}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

/** Frosted glass panel: translucent fill, specular top edge, hairline rim. */
export function Glass({ children, style, radius = 26, strong = false }: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  radius?: number;
  strong?: boolean;
}) {
  return (
    <View style={[styles.glassShadow, { borderRadius: radius }, style]}>
      <View style={[styles.glassClip, { borderRadius: radius, backgroundColor: strong ? palette.glassStrong : palette.glass }]}>
        <Gradient
          colors={['#FFFFFF', '#FFFFFF', '#FFFFFF']}
          opacities={[0.6, 0.04, 0.16]}
          locations={[0, 0.45, 1]}
          style={StyleSheet.absoluteFill}
        />
        {children}
      </View>
    </View>
  );
}

/**
 * Button finishes. `primary` is a brighter, more opaque pearl glass for the
 * main action; `glass` is the quieter secondary surface; `nacre` is a soft
 * iridescent fill (lavender, ice and blush) for the wallet's key actions.
 */
export function PearlButtonFill({ variant }: { variant: 'primary' | 'glass' | 'nacre' }) {
  if (variant === 'nacre') return <NacreFill />;
  const primary = variant === 'primary';
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Gradient
        colors={['#FFFFFF', '#FFFFFF', '#FFFFFF']}
        locations={[0, 0.5, 1]}
        opacities={primary ? [0.96, 0.84, 0.78] : [0.78, 0.5, 0.42]}
        start={{ x: 0.2, y: 0 }}
        end={{ x: 0.8, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="sheen" gradientUnits="userSpaceOnUse" cx="96" cy="-4" rx="80" ry="96">
            <Stop offset="0" stopColor="#DCEBFA" stopOpacity={0.5} />
            <Stop offset="0.55" stopColor="#EADCF7" stopOpacity={0.22} />
            <Stop offset="1" stopColor="#EADCF7" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="blush" gradientUnits="userSpaceOnUse" cx="4" cy="108" rx="70" ry="80">
            <Stop offset="0" stopColor="#F6DCE9" stopOpacity={0.4} />
            <Stop offset="1" stopColor="#F6DCE9" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100" height="100" fill="url(#sheen)" />
        <Rect x="0" y="0" width="100" height="100" fill="url(#blush)" />
      </Svg>
    </View>
  );
}

function NacreFill() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Gradient
        colors={['#EDE6FA', '#E1ECFA', '#F7E3EE']}
        locations={[0, 0.55, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="glow" gradientUnits="userSpaceOnUse" cx="28" cy="-20" rx="90" ry="85">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.95} />
            <Stop offset="0.6" stopColor="#FFFFFF" stopOpacity={0.25} />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="mint" gradientUnits="userSpaceOnUse" cx="100" cy="110" rx="60" ry="70">
            <Stop offset="0" stopColor="#CFEDE6" stopOpacity={0.55} />
            <Stop offset="1" stopColor="#CFEDE6" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100" height="100" fill="url(#glow)" />
        <Rect x="0" y="0" width="100" height="100" fill="url(#mint)" />
      </Svg>
    </View>
  );
}

const wordmarkFont = Platform.select({ ios: 'Didot', default: 'serif' });

/** The Pearlet logotype: Didot title case in ink. */
export function Wordmark({ size = 24 }: { size?: number }) {
  const width = Math.ceil(size * 3.4);
  const height = Math.ceil(size * 1.3);
  return (
    <Svg width={width} height={height} accessible={false}>
      <Defs>
        <LinearGradient id="wordmark" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={palette.ink} />
          <Stop offset="1" stopColor={palette.ink} />
        </LinearGradient>
      </Defs>
      <SvgText x={0} y={size * 0.98} fontFamily={wordmarkFont} fontSize={size} fill="url(#wordmark)">
        Pearlet
      </SvgText>
    </Svg>
  );
}

/** The official Pearl (PRL) mark, from Pearl Research Labs' desktop wallet. */
export function PrlGlyph({ size = 24, color = palette.ink }: { size?: number; color?: string }) {
  return (
    <Svg width={size * (376 / 310)} height={size} viewBox="0 0 376 310" accessible={false}>
      <Path
        d="M172.982 29.9973H240.204C304 30 347 59 347 108.5C347 154 307 187 240 187V170C284 168 300 142 300 108C300 70 274 47 234 47H218V263H265V280H131V263H172.982V29.9973Z"
        fill={color}
      />
      <Path d="M135 186.934C69.6493 186.934 29 157.511 29 108.249C29 62.9709 67.7444 29.9969 135 29.9969L135 186.934Z" fill={color} />
    </Svg>
  );
}

/** The Pearlet mark: a nacre pearl set into a shallow recess, pressed into the background or, with `tile`, a pale nacre tile. */
export function PearletMark({ size = 32, tile = false }: { size?: number; tile?: boolean }) {
  const radius = size * 0.26;
  if (!tile) {
    // The pearl pressed straight into the background: just the recess, its
    // lit lower lip and the pearl, no tile.
    return (
      <View style={{ width: size, height: size }} accessible={false}>
        <Svg width={size} height={size} viewBox="196 196 632 632">
          <Defs>
            <LinearGradient id="well" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#C9C1DE" stopOpacity={0.95} />
              <Stop offset="0.55" stopColor="#E6E0F2" stopOpacity={0.85} />
              <Stop offset="1" stopColor="#FBF9FE" stopOpacity={0.6} />
            </LinearGradient>
            <LinearGradient id="lip" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0} />
              <Stop offset="0.6" stopColor="#FFFFFF" stopOpacity={0.4} />
              <Stop offset="1" stopColor="#FFFFFF" stopOpacity={1} />
            </LinearGradient>
            <RadialGradient id="shade" cx="512" cy="540" r="246" gradientUnits="userSpaceOnUse">
              <Stop offset="0.7" stopColor="#3A3058" stopOpacity={0.24} />
              <Stop offset="1" stopColor="#3A3058" stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id="nacre" cx="0.36" cy="0.3" r="0.8">
              <Stop offset="0" stopColor="#FFFFFF" />
              <Stop offset="0.35" stopColor="#F7F3FC" />
              <Stop offset="0.68" stopColor="#E2DBF0" />
              <Stop offset="0.9" stopColor="#C6C4E0" />
              <Stop offset="1" stopColor="#AFAACF" />
            </RadialGradient>
            <RadialGradient id="iris" cx="0.8" cy="0.76" r="0.5">
              <Stop offset="0" stopColor="#F1C3DA" stopOpacity={0.7} />
              <Stop offset="1" stopColor="#F1C3DA" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx="512" cy="512" r="300" fill="url(#well)" />
          <Circle cx="512" cy="512" r="298" fill="none" stroke="url(#lip)" strokeWidth={10} />
          <Circle cx="512" cy="540" r="246" fill="url(#shade)" />
          <Circle cx="512" cy="512" r="232" fill="url(#nacre)" />
          <Circle cx="512" cy="512" r="232" fill="url(#iris)" />
          <Ellipse cx="434" cy="422" rx="72" ry="43" transform="rotate(-32 434 422)" fill="#FFFFFF" opacity={0.95} />
        </Svg>
      </View>
    );
  }
  return (
    <View style={[styles.markShadow, { width: size, height: size, borderRadius: radius }]} accessible={false}>
      <View style={[styles.markClip, { borderRadius: radius }]}>
        <Svg width={size} height={size} viewBox="0 0 1024 1024">
          <Defs>
            <LinearGradient id="ground" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#FDFCFF" />
              <Stop offset="0.55" stopColor="#F3EFFA" />
              <Stop offset="1" stopColor="#E9EDF8" />
            </LinearGradient>
            <RadialGradient id="ice" cx="0.12" cy="0.2" r="0.7">
              <Stop offset="0" stopColor="#CFE3FA" stopOpacity={0.85} />
              <Stop offset="1" stopColor="#CFE3FA" stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id="blush" cx="0.92" cy="0.88" r="0.65">
              <Stop offset="0" stopColor="#F3D2E4" stopOpacity={0.8} />
              <Stop offset="1" stopColor="#F3D2E4" stopOpacity={0} />
            </RadialGradient>
            <LinearGradient id="well" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#CFC8E2" />
              <Stop offset="0.55" stopColor="#E9E4F3" />
              <Stop offset="1" stopColor="#FBF9FE" />
            </LinearGradient>
            <RadialGradient id="shade" cx="0.5" cy="0.62" r="0.5">
              <Stop offset="0.7" stopColor="#3A3058" stopOpacity={0.22} />
              <Stop offset="1" stopColor="#3A3058" stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id="nacre" cx="0.36" cy="0.3" r="0.8">
              <Stop offset="0" stopColor="#FFFFFF" />
              <Stop offset="0.35" stopColor="#F7F3FC" />
              <Stop offset="0.68" stopColor="#E2DBF0" />
              <Stop offset="0.9" stopColor="#C6C4E0" />
              <Stop offset="1" stopColor="#AFAACF" />
            </RadialGradient>
            <RadialGradient id="iris" cx="0.8" cy="0.76" r="0.5">
              <Stop offset="0" stopColor="#F1C3DA" stopOpacity={0.7} />
              <Stop offset="1" stopColor="#F1C3DA" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect width="1024" height="1024" fill="url(#ground)" />
          <Rect width="1024" height="1024" fill="url(#ice)" />
          <Rect width="1024" height="1024" fill="url(#blush)" />
          <Circle cx="512" cy="512" r="300" fill="url(#well)" />
          <Circle cx="512" cy="540" r="246" fill="url(#shade)" />
          <Circle cx="512" cy="512" r="232" fill="url(#nacre)" />
          <Circle cx="512" cy="512" r="232" fill="url(#iris)" />
          <Ellipse cx="434" cy="422" rx="72" ry="43" transform="rotate(-32 434 422)" fill="#FFFFFF" opacity={0.95} />
        </Svg>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, overflow: 'hidden' },
  layer: { position: 'absolute' },
  texture: { resizeMode: 'contain' },
  glassShadow: { boxShadow: '0 10px 30px rgba(40, 28, 66, 0.08), 0 1px 2px rgba(40, 28, 66, 0.05)' },
  glassClip: { flexGrow: 1, overflow: 'hidden', borderWidth: 1, borderColor: palette.glassBorder },
  markShadow: { boxShadow: '0 4px 14px rgba(40, 28, 66, 0.14)' },
  markClip: { flex: 1, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.9)' },
});
