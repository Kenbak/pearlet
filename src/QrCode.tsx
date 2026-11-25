import { useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';

import { qrModules, qrPath } from './qr-core';

/** A QR code of `size` points, surrounded by a `quietZone` margin on every side. */
export default function QrCode({ value, size, quietZone = 16, color = '#000000', backgroundColor = '#FFFFFF' }: {
  value: string;
  size: number;
  quietZone?: number;
  color?: string;
  backgroundColor?: string;
}) {
  const { count, path } = useMemo(() => {
    const modules = qrModules(value);
    return { count: modules.length, path: qrPath(modules) };
  }, [value]);
  const total = size + quietZone * 2;
  const margin = quietZone * count / size;
  const span = count + margin * 2;

  return (
    <Svg width={total} height={total} viewBox={[-margin, -margin, span, span].join(' ')} accessible={false}>
      <Rect x={-margin} y={-margin} width={span} height={span} fill={backgroundColor} />
      <Path d={path} fill={color} />
    </Svg>
  );
}
