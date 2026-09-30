import { useEffect, useState } from 'react';
import type { ServerCapabilities, StoreSettings, TallyConnector } from '@tallyui/core';
import { sessionContext, type Session } from './session';
import { fetchTaxRateCodes } from './tax-rate-codes';

export type SaleSettings = { settings: StoreSettings; rateCodes: Record<string, string>; capabilities?: ServerCapabilities };
export type SaleSettingsState =
  | { status: 'resolving' | 'retrying'; attempt: number; lastError?: unknown }
  | ({ status: 'ready' } & SaleSettings);

// A read that has not settled by then is a failed read, so a hung request is retried rather than waited on forever.
export const READ_TIMEOUT_MS = 10_000;
// The first retry waits this long, and each one after doubles it…
export const FIRST_RETRY_MS = 1_000;
// …up to this cap; retries go on for as long as the screen is mounted.
export const MAX_RETRY_MS = 30_000;

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

/**
 * The sale's settings: the session's store settings (read at sign-in, the same copy the connector's traits use), with
 * the store's `taxRounding` from its capabilities as `useStoreSettings` adds it (TallyUI #324), and the rate names.
 * A failed read is not an absent value: a read that throws, times out or comes back inconclusive (`undefined` from
 * `connector.capabilities`) keeps the sale waiting and is retried with backoff, so no sale runs on guessed rounding.
 * Only a connector with no `capabilities` read at all gets the default rounding. Once ready, the reads stop.
 */
export function useSaleSettings(session: Session, connector: TallyConnector): SaleSettingsState {
  const [state, setState] = useState<SaleSettingsState>({ status: 'resolving', attempt: 1 });
  useEffect(() => {
    const unmount = new AbortController();
    const context = sessionContext(session);
    let capabilities: { value?: ServerCapabilities } | undefined = connector.capabilities ? undefined : {};
    let rateCodes: Record<string, string> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ status: 'resolving', attempt: 1 });
    const attempt = async (count: number) => {
      const errors: unknown[] = [];
      await Promise.all([
        capabilities ?? readWithTimeout((signal) => connector.capabilities!({ ...context, signal }), unmount.signal).then((value) => {
          if (value === undefined) throw new Error("The store's capabilities read was inconclusive");
          capabilities = { value };
        }).catch((error) => { errors.push(error); }),
        rateCodes ?? readWithTimeout((signal) => fetchTaxRateCodes({ ...context, signal }), unmount.signal).then((value) => {
          rateCodes = value;
        }).catch((error) => { errors.push(error); }),
      ]);
      if (unmount.signal.aborted) return;
      if (capabilities && rateCodes) {
        const taxRounding = capabilities.value?.taxRounding;
        const settings = taxRounding ? { ...session.settings, taxRounding } : session.settings;
        setState({ status: 'ready', settings, rateCodes, capabilities: capabilities.value });
        return;
      }
      console.warn("Could not read the store's sale settings; retrying", errors[0]);
      setState({ status: 'retrying', attempt: count, lastError: errors[0] });
      timer = setTimeout(() => void attempt(count + 1), retryDelayMs(count));
    };
    void attempt(1);
    return () => { unmount.abort(); clearTimeout(timer); };
  }, [session, connector]);
  return state;
}
