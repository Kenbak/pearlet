import encodeQR from 'qr';

const border = 2;

/** QR modules for a value (medium error correction), without a quiet zone. */
export function qrModules(value: string): boolean[][] {
  const withBorder = encodeQR(value, 'raw', { ecc: 'medium', border });
  return withBorder.slice(border, -border).map(row => row.slice(border, -border));
}

/** One SVG path covering every dark module, each a unit square, merged along rows. */
export function qrPath(modules: readonly (readonly boolean[])[]): string {
  let path = '';
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (!row[x]) continue;
      let end = x;
      while (end + 1 < row.length && row[end + 1]) end += 1;
      path += 'M' + x + ' ' + y + 'h' + (end - x + 1) + 'v1h-' + (end - x + 1) + 'z';
      x = end;
    }
  });
  return path;
}
