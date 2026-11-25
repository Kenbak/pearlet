import { validatePearlAddress } from './pearl-keys.ts';
import type { PearlNetwork } from './pearl-network.ts';
import { parseSendAmount } from './testnet-wallet.ts';

/**
 * Pearl payment requests in the BIP 21 style: `pearl:<address>?amount=…&label=…&message=…`.
 * Amounts are in PRL with up to 8 decimals. `prl:` is accepted when reading.
 */
export type PaymentRequest = {
  address: string;
  amountGrains?: number;
  label?: string;
  message?: string;
};

export const paymentScheme = 'pearl';
const acceptedSchemes = ['pearl:', 'prl:'];
const maxTextLength = 120;

function decodeText(value: string): string {
  const text = decodeURIComponent(value.replace(/\+/g, ' ')).trim();
  if (text.length > maxTextLength) throw new Error('This payment request has a label that is too long.');
  return text;
}

/** Read a bare address or a payment request for `network`. Throws a user-facing error. */
export function parsePaymentRequest(input: string, network: PearlNetwork): PaymentRequest {
  let rest = input.trim();
  const scheme = acceptedSchemes.find((prefix) => rest.toLowerCase().startsWith(prefix));
  if (scheme) rest = rest.slice(scheme.length).replace(/^\/\//, '');
  const [rawAddress, query = ''] = rest.split('?', 2);
  const address = validatePearlAddress(rawAddress.trim().toLowerCase(), network);
  if (!address) throw new Error('This is not a valid Pearl ' + (network === 'mainnet' ? 'Mainnet' : 'Testnet2') + ' address.');

  const request: PaymentRequest = { address };
  if (!query) return request;
  if (!scheme) throw new Error('Paste a Pearl address or a pearl: payment link.');

  for (const pair of query.split('&')) {
    if (!pair) continue;
    const [key, value = ''] = pair.split('=', 2);
    const name = decodeURIComponent(key).toLowerCase();
    if (name === 'amount') {
      if (request.amountGrains !== undefined) throw new Error('This payment request repeats the amount.');
      request.amountGrains = parseSendAmount(decodeURIComponent(value));
    } else if (name === 'label') {
      request.label = decodeText(value);
    } else if (name === 'message') {
      request.message = decodeText(value);
    } else if (name.startsWith('req-')) {
      throw new Error('This payment request needs a feature Pearlet does not support.');
    }
    // Other optional parameters are ignored, as BIP 21 allows.
  }
  return request;
}

/** Exact decimal PRL for a grain amount, without trailing zeros. */
export function grainsToDecimal(grains: number): string {
  if (!Number.isSafeInteger(grains) || grains < 0) throw new Error('Invalid PRL amount.');
  const whole = Math.floor(grains / 100_000_000);
  const fraction = String(grains % 100_000_000).padStart(8, '0').replace(/0+$/, '');
  return fraction ? whole + '.' + fraction : String(whole);
}

/** Build a `pearl:` request. Only the address is required. */
export function buildPaymentUri(request: PaymentRequest): string {
  const params: string[] = [];
  if (request.amountGrains !== undefined && request.amountGrains > 0) params.push('amount=' + grainsToDecimal(request.amountGrains));
  if (request.label?.trim()) params.push('label=' + encodeURIComponent(request.label.trim().slice(0, maxTextLength)));
  if (request.message?.trim()) params.push('message=' + encodeURIComponent(request.message.trim().slice(0, maxTextLength)));
  return paymentScheme + ':' + request.address + (params.length ? '?' + params.join('&') : '');
}
