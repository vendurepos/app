import { useEffect, useRef, useState } from 'react';
import type { ServerCapabilities, StoreSettings, TallyConnector } from '@tallyui/core';
import { sessionContext, sessionKey, type Session } from './session';

export type SaleSettings = { settings: StoreSettings; capabilities?: ServerCapabilities };
export type SaleSettingsState =
  | { status: 'resolving' | 'retrying' | 'plugin'; attempt: number; lastError?: unknown }
  | ({ status: 'ready' } & SaleSettings);

// A read that has not settled by then is a failed read, so a hung request is retried rather than waited on forever.
export const READ_TIMEOUT_MS = 10_000;
// The first retry waits this long, and each one after doubles it…
export const FIRST_RETRY_MS = 1_000;
// …up to this cap; retries go on for as long as the screen is mounted.
export const MAX_RETRY_MS = 30_000;
// The plugin this app ships with advertises order.create 4, and v4 carries the net-discount rule. A store below it (no
// plugin, or an older one: a 404 /info reads as 1) would take a discounted sale at 3 and apply it without that rule.
export const MIN_ORDER_CREATE = 4;
// A sale is taken only inside an open register session, synced as the plugin's register commands (vendurepos #79):
// a store without them has no server record of the drawer, so it waits as `plugin` too.
export const MIN_REGISTER = 1;

export function retryDelayMs(attempt: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS);
}

/** Runs `read` with a signal that aborts at unmount or after READ_TIMEOUT_MS, and rejects then even if `read` hangs. */
function readWithTimeout<T>(read: (signal: AbortSignal) => Promise<T>, unmount: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(unmount.reason);
  unmount.addEventListener('abort', abort);
  const timer = setTimeout(() => controller.abort(new Error(`No answer within ${READ_TIMEOUT_MS} ms`)), READ_TIMEOUT_MS);
  const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason)));
  return Promise.race([Promise.resolve().then(() => read(controller.signal)), aborted])
    .finally(() => { clearTimeout(timer); unmount.removeEventListener('abort', abort); });
}

/** One read of the store's capabilities, rejected after READ_TIMEOUT_MS or at `unmount`. The connector must have the read. */
export function readCapabilities(session: Session, connector: TallyConnector, unmount = new AbortController().signal) {
  return readWithTimeout((signal) => connector.capabilities!({ ...sessionContext(session), signal }), unmount);
}

/**
 * The sale's settings: the session's store settings (read at sign-in, the same copy the connector's traits use, with the
 * rate names the connector reads beside the rates), with the store's `taxRounding` from its capabilities as
 * `useStoreSettings` adds it (TallyUI #324). A failed read is not an absent value: a read that throws, times out or
 * comes back inconclusive (`undefined` from `connector.capabilities`) keeps the sale waiting and is retried with
 * backoff, so no sale runs on guessed rounding. A store whose plugin is below MIN_ORDER_CREATE or MIN_REGISTER waits the
 * same way, as `plugin`. Only a connector with no `capabilities` read at all gets the default rounding. Once ready, the reads stop.
 */
export function useSaleSettings(session: Session, connector: TallyConnector): SaleSettingsState {
  const [state, setState] = useState<SaleSettingsState>({ status: 'resolving', attempt: 1 });
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // Whether the current read reached ready: a new token then keeps the sale; while waiting, a new token retries at once.
  const readyRef = useRef(false);
  const lastToken = useRef(session.token);
  const [tokenEpoch, setTokenEpoch] = useState(0);
  useEffect(() => {
    if (lastToken.current === session.token) return;
    lastToken.current = session.token;
    if (!readyRef.current) setTokenEpoch((epoch) => epoch + 1);
  }, [session.token]);
  useEffect(() => {
    readyRef.current = false;
    const unmount = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ status: 'resolving', attempt: 1 });
    const attempt = async (count: number) => {
      let capabilities: ServerCapabilities | undefined;
      let waiting: Extract<SaleSettingsState, { attempt: number }> | undefined;
      if (connector.capabilities) {
        try {
          capabilities = await readCapabilities(sessionRef.current, connector, unmount.signal);
          if (capabilities === undefined) throw new Error("The store's capabilities read was inconclusive");
          // Written so a missing or non-numeric orderCreate or register waits too.
          if (!(capabilities.orderCreate >= MIN_ORDER_CREATE) || !((capabilities.register ?? 0) >= MIN_REGISTER)) {
            waiting = { status: 'plugin', attempt: count };
          }
        } catch (error) {
          waiting = { status: 'retrying', attempt: count, lastError: error };
        }
      }
      if (unmount.signal.aborted) return;
      if (!waiting) {
        const taxRounding = capabilities?.taxRounding;
        readyRef.current = true;
        setState({ status: 'ready', settings: taxRounding ? { ...sessionRef.current.settings, taxRounding } : sessionRef.current.settings, capabilities });
        return;
      }
      console.warn("Could not read the store's sale settings; retrying", waiting.status === 'plugin' ? capabilities : waiting.lastError);
      setState(waiting);
      timer = setTimeout(() => void attempt(count + 1), retryDelayMs(count));
    };
    void attempt(1);
    return () => { unmount.abort(); clearTimeout(timer); };
  }, [sessionKey(session), connector, tokenEpoch]);
  return state;
}
