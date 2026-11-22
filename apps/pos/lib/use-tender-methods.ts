import { useEffect, useMemo, useRef, useState } from 'react';
import type { PaymentMethodDescriptor, ServerCapabilities } from '@tallyui/core';
import { defaultStore, sessionContext, sessionKey, type Session } from './session';
import { parseTenderMethods } from './tender-methods';

// Device storage for the store's last good /info paymentMethods (raw JSON), one per session key, so an offline start
// shows the same tiles. Never RxDB: nothing replicates it.
export const TENDER_METHODS_KEY = 'vendurepos.tender_methods';

function stored(key: string): string | null {
  try {
    return defaultStore().getItem(key);
  } catch {
    return null;
  }
}

function listOf(json: string | null): unknown[] | undefined {
  try {
    const list: unknown = JSON.parse(json ?? 'null');
    return Array.isArray(list) ? list : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The store's Tally POS payment methods for TenderPane, or undefined for its default tiles. It reads /tally/v1/info on
 * mount and whenever `capabilities` (the sale settings' read) changes. A refused or failed read, or a body with no
 * paymentMethods array, keeps the last good list; an empty list replaces it. The result is the same array while the
 * list and the order.create cap are unchanged, because useTender starts its state again on a new `methods`.
 */
export function useTenderMethods(session: Session, capabilities?: ServerCapabilities): PaymentMethodDescriptor[] | undefined {
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const storageKey = `${TENDER_METHODS_KEY}:${sessionKey(session)}`;
  const [entry, setEntry] = useState(() => ({ key: storageKey, json: stored(storageKey) }));
  const json = entry.key === storageKey ? entry.json : stored(storageKey);
  useEffect(() => {
    const unmount = new AbortController();
    void (async () => {
      try {
        const current = sessionRef.current;
        const response = await fetch(`${current.url}/tally/v1/info`, { headers: sessionContext(current).headers, signal: unmount.signal });
        if (!response.ok) return;
        const listed = ((await response.json()) as { paymentMethods?: unknown } | null)?.paymentMethods;
        if (!Array.isArray(listed) || unmount.signal.aborted) return;
        const next = JSON.stringify(listed);
        setEntry((last) => last.key === storageKey && last.json === next ? last : { key: storageKey, json: next });
        defaultStore().setItem(storageKey, next);
      } catch {
        // Offline, aborted or unreadable: the last good list stands.
      }
    })();
    return () => unmount.abort();
  }, [storageKey, capabilities]);
  const orderCreate = capabilities?.orderCreate ?? 0;
  return useMemo(() => {
    const list = listOf(json);
    return list ? parseTenderMethods({ paymentMethods: list }, orderCreate) : undefined;
  }, [json, orderCreate]);
}
