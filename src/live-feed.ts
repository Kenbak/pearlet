import { pearlNetworks, type PearlNetwork } from './pearl-network.ts';

/** Blockbook's websocket endpoint for a network. */
export function liveFeedUrl(network: PearlNetwork): string {
  return pearlNetworks[network].explorer.replace(/^http/, 'ws') + '/websocket';
}

export type LiveEvent = { kind: 'block'; height: number } | { kind: 'address'; address: string; txid: string | null };

const blockSubscription = 'block';
const addressSubscription = 'addresses';

/** Read a Blockbook websocket message as a wallet event, ignoring replies and malformed data. */
export function parseLiveMessage(raw: string, watched: readonly string[]): LiveEvent | null {
  let message: { id?: unknown; data?: unknown };
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  const data = message.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object' || 'subscribed' in data || 'error' in data) return null;
  if (message.id === blockSubscription && typeof data.height === 'number') {
    return { kind: 'block', height: data.height };
  }
  if (message.id === addressSubscription && typeof data.address === 'string' && watched.includes(data.address)) {
    const tx = data.tx as Record<string, unknown> | undefined;
    return { kind: 'address', address: data.address, txid: typeof tx?.txid === 'string' ? tx.txid : null };
  }
  return null;
}

/** Reconnect delays: 1s, 2s, 4s… capped at 30s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
}

/**
 * Subscribe to new blocks and to activity on the given addresses. Calls
 * `onEvent` for each event and reconnects with backoff until stopped.
 * Read-only: only public addresses are sent to the indexer, as with REST.
 */
export function openLiveFeed(
  network: PearlNetwork,
  addresses: readonly string[],
  onEvent: (event: LiveEvent) => void,
  onStatus?: (connected: boolean) => void,
): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (stopped) return;
    const next = new WebSocket(liveFeedUrl(network));
    socket = next;
    next.onopen = () => {
      attempt = 0;
      onStatus?.(true);
      next.send(JSON.stringify({ id: blockSubscription, method: 'subscribeNewBlock', params: {} }));
      next.send(JSON.stringify({ id: addressSubscription, method: 'subscribeAddresses', params: { addresses } }));
    };
    next.onmessage = (message) => {
      const event = parseLiveMessage(String(message.data), addresses);
      if (event) onEvent(event);
    };
    next.onclose = () => {
      onStatus?.(false);
      if (stopped || socket !== next) return;
      retry = setTimeout(connect, reconnectDelay(attempt++));
    };
    next.onerror = () => {
      // onclose follows and schedules the reconnect.
    };
  };

  connect();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    socket?.close();
    socket = null;
  };
}
