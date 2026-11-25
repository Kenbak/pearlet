import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';

import { PearletMark } from './PearlDesign';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  NativeModules,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

export type HapticKind = 'selection' | 'light' | 'soft' | 'medium' | 'success' | 'warning' | 'error';

const nativeHaptics: { trigger?: (kind: HapticKind) => void } | undefined = NativeModules.LustreHaptics;

let hapticsEnabled = true;

/** Turn every haptic on or off, following the Settings preference. */
export function setHapticsEnabled(enabled: boolean) {
  hapticsEnabled = enabled;
}

/** Fire a system haptic. A no-op when disabled or without the native module. */
export function haptic(kind: HapticKind = 'light') {
  if (!hapticsEnabled) return;
  try {
    nativeHaptics?.trigger?.(kind);
  } catch {
    // Haptics are decorative; never let them interrupt a wallet action.
  }
}

export function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let mounted = true;
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (mounted) setReduce(value);
    }).catch(() => {});
    return () => {
      mounted = false;
      listener.remove();
    };
  }, []);
  return reduce;
}

type PressableProps = ComponentProps<typeof Pressable>;

/**
 * A Pressable that springs down slightly under the finger and gives a light
 * haptic on press. `style` is applied to the animated wrapper.
 */
export function PressScale({
  children,
  style,
  pressableStyle,
  scaleTo = 0.96,
  feedback = 'light',
  onPress,
  disabled,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Layout for the touch target itself, e.g. absolute positioning. */
  pressableStyle?: StyleProp<ViewStyle>;
  scaleTo?: number;
  feedback?: HapticKind | null;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const reduce = useReduceMotion();

  function spring(to: number) {
    if (reduce) return;
    Animated.spring(scale, { toValue: to, speed: 40, bounciness: to === 1 ? 6 : 0, useNativeDriver: true }).start();
  }

  return (
    <Pressable
      {...rest}
      style={pressableStyle}
      disabled={disabled}
      onPressIn={(event) => {
        spring(scaleTo);
        rest.onPressIn?.(event);
      }}
      onPressOut={(event) => {
        spring(1);
        rest.onPressOut?.(event);
      }}
      onPress={(event: GestureResponderEvent) => {
        if (feedback) haptic(feedback);
        onPress?.(event);
      }}
    >
      <Animated.View style={[style, disabled && { opacity: 0.5 }, { transform: [{ scale }] }]}>
        {children}
      </Animated.View>
    </Pressable>
  );
}

/** Fades and lifts its children in on mount; `delay` staggers siblings. */
export function Rise({ children, delay = 0, distance = 14, style }: {
  children: ReactNode;
  delay?: number;
  distance?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const reduce = useReduceMotion();

  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: reduce ? 1 : 520,
      delay: reduce ? 0 : delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, delay, reduce]);

  return (
    <Animated.View
      style={[style, {
        opacity: progress,
        transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [reduce ? 0 : distance, 0] }) }],
      }]}
    >
      {children}
    </Animated.View>
  );
}

function useLoop(active: boolean, duration: number) {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) {
      value.setValue(0);
      return;
    }
    const loop = Animated.loop(Animated.timing(value, {
      toValue: 1,
      duration,
      easing: Easing.inOut(Easing.sin),
      useNativeDriver: true,
    }));
    loop.start();
    return () => loop.stop();
  }, [active, duration, value]);
  return value;
}

/**
 * The Pearlet mark breathing gently while a soft ring of light expands behind
 * it. Used while the wallet opens instead of a system spinner.
 */
export function PearlLoader({ size = 96, label = 'Opening wallet' }: { size?: number; label?: string }) {
  const reduce = useReduceMotion();
  const breath = useLoop(!reduce, 2400);
  const ring = useLoop(!reduce, 2400);
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label} style={[loaderStyles.wrap, { width: size * 2, height: size * 2 }]}>
      <Animated.View
        style={[loaderStyles.ring, {
          width: size * 1.3,
          height: size * 1.3,
          borderRadius: size * 0.65,
          opacity: ring.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.5, 0.15, 0] }),
          transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.5] }) }],
        }]}
      />
      <Animated.View
        style={{
          transform: [{ scale: breath.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.06, 1] }) }],
        }}
      >
        <PearletMark size={size} />
      </Animated.View>
    </View>
  );
}

/** A soft pulsing placeholder block for content that is still loading. */
export function Shimmer({ width, height, radius = 8, style }: {
  width: number | `${number}%`;
  height: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const reduce = useReduceMotion();
  const pulse = useLoop(!reduce, 1400);
  return (
    <Animated.View
      style={[loaderStyles.shimmer, style, {
        width,
        height,
        borderRadius: radius,
        opacity: reduce ? 0.6 : pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.45, 0.85, 0.45] }),
      }]}
    />
  );
}

/**
 * Eases a number from its previous value to `target` over `duration`.
 * Jumps straight to the value with Reduce Motion or on the first value when
 * `fromZero` is false.
 */
export function useCountUp(target: number | null, duration = 700, fromZero = true) {
  const reduce = useReduceMotion();
  const [display, setDisplay] = useState<number | null>(target === null || reduce || !fromZero ? target : 0);
  const current = useRef<number | null>(display);

  useEffect(() => {
    if (target === null) {
      current.current = null;
      setDisplay(null);
      return;
    }
    const start = current.current ?? (fromZero ? 0 : target);
    if (reduce || start === target) {
      current.current = target;
      setDisplay(target);
      return;
    }
    let frame = 0;
    const began = Date.now();
    const tick = () => {
      const progress = Math.min(1, (Date.now() - began) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = Math.round(start + (target - start) * eased);
      current.current = value;
      setDisplay(value);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration, reduce, fromZero]);

  return display;
}

const loaderStyles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', borderWidth: 1.5, borderColor: 'rgba(160, 150, 210, 0.7)', backgroundColor: 'rgba(255, 255, 255, 0.25)' },
  shimmer: { backgroundColor: 'rgba(255, 255, 255, 0.75)' },
});
