import { useState } from 'react';
import { Link } from 'expo-router';
import type { RxStorageSQLiteWasm } from '@tallyui/storage-sqlite/web';
import { Button, HStack, Text, VStack } from '@tallyui/components';
import { appStorage } from '../app-storage';
import { useSession } from '../session-context';
import { trackDemoEvent } from './analytics';
import { demoStore, resetDemo } from './install';

const DEMO_LINKS_QUICKSTART = 'https://vendurepos.com/docs/quick-start';

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

/** The demo build's banner (VA9): the demo stays in this browser, Reset demo starts a fresh visit, and signed in it links to the site, the quick start and GitHub. */
export function DemoBanner() {
  const [resetting, setResetting] = useState(false);
  const [linksHidden, setLinksHidden] = useState(false);
  const { session } = useSession();
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
    <VStack testID="demo-banner" dataSet={{ print: 'hide' }} className="border-b border-border bg-background px-4 py-2" space="sm">
      <HStack className="items-center" space="sm">
        <Text className="flex-1 text-sm text-muted-foreground">Demo: everything stays in this browser</Text>
        <Button testID="demo-reset" variant="secondary" size="sm" disabled={resetting} onPress={() => void reset()}>
          <Text>{resetting ? 'Resetting…' : 'Reset demo'}</Text>
        </Button>
      </HStack>
      {session && !linksHidden ? (
        <HStack testID="demo-links" className="flex-wrap items-center" space="md">
          <Link href="https://vendurepos.com" target="_blank" rel="noopener" testID="demo-links-site" className="text-sm text-primary">VendurePOS</Link>
          <Link href={DEMO_LINKS_QUICKSTART} target="_blank" rel="noopener" testID="demo-links-quickstart" className="text-sm text-primary">Quick start</Link>
          <Link href="https://github.com/vendurepos/app" target="_blank" rel="noopener" testID="demo-links-github" className="text-sm text-primary">GitHub</Link>
          <Button testID="demo-links-dismiss" variant="ghost" size="sm" accessibilityLabel="Hide these links" onPress={() => setLinksHidden(true)}><Text>Hide</Text></Button>
        </HStack>
      ) : null}
    </VStack>
  );
}
