import { useState } from 'react';
import type { RxStorageSQLiteWasm } from '@tallyui/storage-sqlite/web';
import { Button, HStack, Text } from '@tallyui/components';
import { appStorage } from '../app-storage';
import { trackDemoEvent } from './analytics';
import { demoStore, resetDemo } from './install';

// opfs-sahpool releases its access handles a moment after the worker ends: how often, and how long apart, to retry.
const REMOVE_ATTEMPTS = 30;
const REMOVE_RETRY_MS = 100;

/**
 * Every local database, the orders' included. Sign-out's path (removeCatalogueDatabaseWithin) keeps the orders
 * database by design (lib/orders-db.ts) and needs the till to unmount, which would start the demo's sign-in again, so
 * the reset ends the storage worker instead, which frees its OPFS files, and removes them all.
 */
async function removeLocalDatabases(): Promise<void> {
  (appStorage() as RxStorageSQLiteWasm).terminate();
  // Expo's tsconfig has the DOM lib without DOM.AsyncIterable, where a directory's keys() is typed.
  const root = await navigator.storage.getDirectory() as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };
  for (const name of await Array.fromAsync(root.keys())) {
    for (let attempt = 1; ; attempt++) {
      try {
        await root.removeEntry(name, { recursive: true });
        break;
      } catch (error) {
        if (attempt >= REMOVE_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, REMOVE_RETRY_MS));
      }
    }
  }
}

/** The demo build's banner (VA9): the demo stays in this browser, and Reset demo starts a fresh visit. */
export function DemoBanner() {
  const [resetting, setResetting] = useState(false);
  async function reset() {
    trackDemoEvent('demo_reset');
    setResetting(true);
    await resetDemo({
      store: demoStore!, storage: localStorage, removeDatabases: removeLocalDatabases,
      reload: () => window.location.assign('/demo'),
    }).catch((error: unknown) => {
      console.warn('Demo reset failed', error);
      setResetting(false);
    });
  }
  return (
    <HStack testID="demo-banner" dataSet={{ print: 'hide' }} className="items-center border-b border-border bg-background px-4 py-2" space="sm">
      <Text className="flex-1 text-sm text-muted-foreground">Demo: everything stays in this browser</Text>
      <Button testID="demo-reset" variant="secondary" size="sm" disabled={resetting} onPress={() => void reset()}>
        <Text>{resetting ? 'Resetting…' : 'Reset demo'}</Text>
      </Button>
    </HStack>
  );
}
