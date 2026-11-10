import { useState, type JSX } from 'react';
import { Button, formatStockSyncTime, Text } from '@tallyui/components';
import { refreshCatalogue } from './catalogue';
import { syncNow, type Flushable } from './sync-now';

export function SyncNowControl({ lastSyncedAt, outboxes }: { lastSyncedAt: Date | null; outboxes: readonly Flushable[] }): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Text testID="last-synced" className="text-sm text-muted-foreground">
        {lastSyncedAt ? `Last synced ${formatStockSyncTime(lastSyncedAt)}` : 'Not synced yet'}
      </Text>
      <Button testID="sync-now" variant="secondary" disabled={busy} onPress={() => {
        setBusy(true);
        void syncNow(outboxes, refreshCatalogue).finally(() => setBusy(false));
      }}>
        <Text>{busy ? 'Syncing…' : 'Sync now'}</Text>
      </Button>
    </>
  );
}
