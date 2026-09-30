import { useEffect, useState } from 'react';
import type { ServerCapabilities, StoreSettings, TallyConnector } from '@tallyui/core';
import { sessionContext, type Session } from './session';
import { fetchTaxRateCodes } from './tax-rate-codes';

export type SaleSettings = { settings: StoreSettings; rateCodes: Record<string, string>; capabilities?: ServerCapabilities };

/**
 * The sale's settings: the session's store settings (read at sign-in, the same copy the connector's traits use), with
 * the store's `taxRounding` from its capabilities as `useStoreSettings` adds it (TallyUI #324), and the rate names.
 * Null until both reads settle, so no sale starts on the default rounding. A failed read falls back (the till still
 * sells offline): no capabilities give the default rounding, no rate names group by rate value alone.
 */
export function useSaleSettings(session: Session, connector: TallyConnector): SaleSettings | null {
  const [sale, setSale] = useState<SaleSettings | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const context = { ...sessionContext(session), signal: controller.signal };
    setSale(null);
    void Promise.all([
      Promise.resolve().then(() => connector.capabilities?.(context)).catch(() => undefined),
      fetchTaxRateCodes(context).catch((error) => {
        if (!controller.signal.aborted) console.warn('Could not read the tax rate names', error);
        return {};
      }),
    ]).then(([capabilities, rateCodes]) => {
      if (controller.signal.aborted) return;
      const taxRounding = capabilities?.taxRounding;
      setSale({ settings: taxRounding ? { ...session.settings, taxRounding } : session.settings, rateCodes, capabilities });
    });
    return () => controller.abort();
  }, [session, connector]);
  return sale;
}
