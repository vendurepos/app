import { useEffect, useMemo, useState } from 'react';
import { withStockOverlay, type TallyConnector } from '@tallyui/core';
import { getStorageHealth } from '@tallyui/database';
import { stockOverlay$, stockOverlayAsOf$ } from '@tallyui/pos';
import type { Subscription } from 'rxjs';
import { catalogueConnector, startCatalogueSync, stopCatalogueSync } from './catalogue';
import type { Session } from './session';
import { storageStartMessage } from './storage-start-failure';

// A till notice (TallyUI #261): the store refused the session, so the pull stays stopped until the cashier signs in again.
export const SESSION_ENDED_TEXT = 'Your session has ended. Sign out, then sign in again.';
// A `forbidden` notice (TallyUI #342): a 403, fixed by the store; the pull retries on its own, and signing out won't help.
export const FORBIDDEN_TEXT = "This account isn't allowed to use the till on this store. Ask the store's admin; the till retries on its own.";

export function useCatalogue(session: Session): {
  connector: TallyConnector;
  products: any[];
  lastSyncedAt: Date | null;
  error: string | null;
  stockOverlay: ReadonlyMap<string, unknown> | undefined;
  stockOverlayAsOf: string | undefined;
} {
  // One connector per store session (TallyUI #307): a shared instance would share its reconcile feeds across stores.
  const connector = useMemo(() => catalogueConnector(session), [session]);
  const [products, setProducts] = useState<any[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stockOverlay, setStockOverlay] = useState<Map<string, unknown>>();
  const [stockOverlayAsOf, setStockOverlayAsOf] = useState<string>();
  const overlaidProducts = useMemo(() => products.map(doc => withStockOverlay(doc, connector.reconcile?.stock, stockOverlay)), [products, connector, stockOverlay]);

  useEffect(() => {
    let cancelled = false;
    let wasActive = false;
    let failed = false;
    let errorShown = false;
    let dead = false;
    // From TallyUI 3.0 a refused session reaches notice$, never error$, and the pull pauses without an error.
    let tillStopped = false;
    // A forbidden notice stands until the store answers a pull again: the errors rethrown meanwhile don't replace it.
    let forbidden = false;
    const subscriptions: Subscription[] = [];
    void startCatalogueSync(session, connector).then(({ db, replication, stockLevels }) => {
      if (cancelled) return;
      subscriptions.push(db.products.find().$.subscribe((docs) => {
        if (!cancelled) setProducts(docs.map((doc) => doc.toJSON()));
      }));
      subscriptions.push(stockOverlay$(stockLevels).subscribe((overlay) => {
        if (!cancelled) setStockOverlay(overlay);
      }));
      subscriptions.push(stockOverlayAsOf$(stockLevels).subscribe((asOf) => {
        if (!cancelled) setStockOverlayAsOf(asOf);
      }));
      subscriptions.push(replication.notice$.subscribe((notice) => {
        if (cancelled) return;
        if (dead) return;
        tillStopped = notice?.fixedBy === 'till';
        forbidden = notice?.code === 'forbidden';
        const text = notice?.code === 'unauthorized' ? SESSION_ENDED_TEXT : forbidden ? FORBIDDEN_TEXT : undefined;
        if (!text) return;
        errorShown = true;
        setError(text);
      }));
      subscriptions.push(replication.active$.subscribe((active) => {
        if (cancelled || dead || tillStopped || forbidden) return;
        // A new run starts clean; received$ also clears an error recovered by a retry within the same run.
        if (active && !wasActive) failed = false;
        if (wasActive && !active && !failed) {
          setLastSyncedAt(new Date());
          errorShown = false;
          setError(null);
        }
        wasActive = active;
      }));
      subscriptions.push(replication.error$.subscribe((error) => {
        if (cancelled || dead || tillStopped || forbidden) return;
        failed = true;
        let inner: any = error;
        while (inner.parameters?.errors?.[0]) inner = inner.parameters.errors[0];
        errorShown = true;
        setError(inner.message ?? String(inner));
      }));
      subscriptions.push(replication.received$.subscribe(() => {
        if (cancelled || dead || tillStopped || forbidden || !errorShown) return;
        failed = false;
        errorShown = false;
        setError(null);
      }));
      const health = getStorageHealth(db);
      if (health) subscriptions.push(health.subscribe(({ status }) => {
        if (cancelled || status !== 'dead') return;
        dead = true;
        setError('Local storage stopped responding. Reload this page.');
      }));
    }).catch((error) => {
      if (cancelled || dead) return;
      setError(storageStartMessage(error) ?? error.message ?? String(error));
    });
    return () => {
      cancelled = true;
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      // Queued behind any pending start so its replication is stopped too.
      void stopCatalogueSync().catch((error) => console.warn('Failed to stop catalogue sync', error));
    };
  }, [session, connector]);

  return { connector, products: overlaidProducts, lastSyncedAt, error, stockOverlay, stockOverlayAsOf };
}
