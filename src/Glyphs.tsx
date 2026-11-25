import Svg, { Path } from 'react-native-svg';

import { palette } from './PearlDesign';

/**
 * Pearlet's own action glyphs, drawn on a 24-unit grid with one stroke weight
 * and round joins so they sit together as a set.
 */
const paths = {
  // A paper plane with its centre fold.
  send: ['M20.5 3.5 3.75 10.1a.6.6 0 0 0 0 1.12l6.4 2.53 2.53 6.4a.6.6 0 0 0 1.12 0z', 'M20.5 3.5 10.15 13.75'],
  // Arrow settling into an open tray.
  receive: ['M12 4v11', 'M7.5 10.5 12 15l4.5-4.5', 'M5 13.5v3.25A2.25 2.25 0 0 0 7.25 19h9.5A2.25 2.25 0 0 0 19 16.75V13.5'],
  // Two offset arrows passing each other.
  swap: ['M5 8.5h12.5', 'M14.5 5.5l3 3-3 3', 'M19 15.5H6.5', 'M9.5 12.5l-3 3 3 3'],
} as const;

export type GlyphName = keyof typeof paths;

export default function Glyph({ name, size = 24, color = palette.ink, weight = 1.7 }: {
  name: GlyphName;
  size?: number;
  color?: string;
  weight?: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessible={false}>
      {paths[name].map((d) => (
        <Path key={d} d={d} stroke={color} strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </Svg>
  );
}
