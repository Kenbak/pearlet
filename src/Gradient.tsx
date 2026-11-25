import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

type Point = { x: number; y: number };

export default function Gradient({
  colors,
  locations,
  opacities,
  start = { x: 0.5, y: 0 },
  end = { x: 0.5, y: 1 },
  style,
  children,
}: {
  colors: readonly string[];
  locations?: readonly number[];
  opacities?: readonly number[];
  start?: Point;
  end?: Point;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  return (
    <View style={style}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Svg width="100%" height="100%" accessible={false}>
          <Defs>
            <LinearGradient id="fill" x1={start.x} y1={start.y} x2={end.x} y2={end.y}>
              {colors.map((color, index) => (
                <Stop
                  key={index}
                  stopColor={color}
                  stopOpacity={opacities?.[index]}
                  offset={locations?.[index] ?? index / (colors.length - 1)}
                />
              ))}
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#fill)" />
        </Svg>
      </View>
      {children}
    </View>
  );
}
