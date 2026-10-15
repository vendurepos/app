import { useEffect, useMemo, useState } from 'react';
import { withStockOverlay, type TallyConnector } from '@tallyui/core';
import { stockOverlay$, stockOverlayAsOf$ } from '@tallyui/pos';
import type { Subscription } from 'rxjs';
import { catalogueConnector, startCatalogueSync, stopCatalogueSync } from './catalogue';
import { sessionKey, type Session } from './session';
import { catalogueStatus, INITIAL_CATALOGUE_STATUS, type CatalogueError, type CatalogueEvent, type CatalogueRefusal } from './catalogue-status';

// One connector per store session (TallyUI #307): a shared instance would share its reconcile feeds across stores.
// The session key, not the session object, decides when it is rebuilt.
export function useCatalogueConnector(session: Session): TallyConnector;
export function useCatalogueConnector(session: Session | null): TallyConnector | null;
export function useCatalogueConnector(session: Session | null): TallyConnector | null {
  const key = session ? sessionKey(session) : null;
  return useMemo(() => session ? catalogueConnector(session) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]);
}

export function useCatalogue(session: Session): {
  connector: TallyConnector;
  products: any[];
  lastSyncedAt: Date | null;
  error: string | null;
  refusal: CatalogueRefusal | null;
  stockOverlay: ReadonlyMap<string, unknown> | undefined;
  stockOverlayAsOf: string | undefined;
} {
  const connector = useCatalogueConnector(session);
  const [products, setProducts] = useState<any[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [error, setError] = useState<CatalogueError | null>(null);
  const [stockOverlay, setStockOverlay] = useState<Map<string, unknown>>();
  const [stockOverlayAsOf, setStockOverlayAsOf] = useState<string>();
  const overlaidProducts = useMemo(() => products.map(doc => withStockOverlay(doc, connector.reconcile?.stock, stockOverlay)), [products, connector, stockOverlay]);

  useEffect(() => {
    setError(null);
    let cancelled = false;
    const subscriptions: Subscription[] = [];
    let catalogueState = INITIAL_CATALOGUE_STATUS;
    function feed(event: CatalogueEvent) {
      if (cancelled) return;
      const step = catalogueStatus(catalogueState, event);
      catalogueState = step.state;
      if (step.synced) setLastSyncedAt(new Date());
      if (step.error !== undefined) setError(step.error);
    }
    void startCatalogueSync(session, connector).then(({ db, replication, stockLevels, health }) => {
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
        feed({ type: 'notice', notice });
      }));
      subscriptions.push(replication.active$.subscribe((active) => {
        feed({ type: 'active', active });
      }));
      subscriptions.push(replication.error$.subscribe((error) => {
        feed({ type: 'error', error });
      }));
      subscriptions.push(replication.received$.subscribe(() => {
        feed({ type: 'received' });
      }));
      if (health) subscriptions.push(health.subscribe(({ status }) => {
        feed({ type: 'health', status });
      }));
    }).catch((error) => {
      feed({ type: 'start-failed', error });
    });
    return () => {
      cancelled = true;
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      // Queued behind any pending start so its replication is stopped too.
      void stopCatalogueSync().catch((error) => console.warn('Failed to stop catalogue sync', error));
    };
  }, [session, connector]);

  return { connector, products: overlaidProducts, lastSyncedAt, error: error?.text ?? null, refusal: error?.refusal ?? null, stockOverlay, stockOverlayAsOf };
}
