import { useEffect, useMemo, useState } from 'react';
import type { TallyConnector } from '@tallyui/core';
import { getStorageHealth } from '@tallyui/database';
import { isStorageWorkerStartError } from '@tallyui/storage-sqlite/web';
import type { Subscription } from 'rxjs';
import { catalogueConnector, startCatalogueSync, stopCatalogueSync } from './catalogue';
import type { Session } from './session';

export function useCatalogue(session: Session): {
  connector: TallyConnector;
  products: any[];
  lastSyncedAt: Date | null;
  error: string | null;
} {
  const connector = useMemo(() => catalogueConnector(session), [session]);
  const [products, setProducts] = useState<any[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let wasActive = false;
    let failed = false;
    let dead = false;
    const subscriptions: Subscription[] = [];
    void startCatalogueSync(session, connector).then(({ db, replication }) => {
      if (cancelled) return;
      subscriptions.push(db.products.find().$.subscribe((docs) => {
        if (!cancelled) setProducts(docs.map((doc) => doc.toJSON()));
      }));
      subscriptions.push(replication.active$.subscribe((active) => {
        if (cancelled || dead) return;
        // A new run starts clean; received$ also clears an error recovered by a retry within the same run.
        if (active && !wasActive) failed = false;
        if (wasActive && !active && !failed) {
          setLastSyncedAt(new Date());
          setError(null);
        }
        wasActive = active;
      }));
      subscriptions.push(replication.error$.subscribe((error) => {
        if (cancelled || dead) return;
        failed = true;
        let inner: any = error;
        while (inner.parameters?.errors?.[0]) inner = inner.parameters.errors[0];
        setError(inner.message ?? String(inner));
      }));
      subscriptions.push(replication.received$.subscribe(() => {
        if (cancelled || dead || !failed) return;
        failed = false;
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
      setError(isStorageWorkerStartError(error)
        ? 'VendurePOS is open in another tab. Close it, then reload this page.'
        : error.message ?? String(error));
    });
    return () => {
      cancelled = true;
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      // Queued behind any pending start so its replication is stopped too.
      void stopCatalogueSync().catch((error) => console.warn('Failed to stop catalogue sync', error));
    };
  }, [session, connector]);

  return { connector, products, lastSyncedAt, error };
}
