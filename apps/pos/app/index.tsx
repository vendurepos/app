import { useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { Button, Catalogue, HStack, Text, VStack } from '@tallyui/components';
import { ConnectorProvider } from '@tallyui/core';
import { removeCatalogueDatabaseWithin } from '../lib/catalogue';
import type { Session } from '../lib/session';
import { useSession } from '../lib/session-context';
import { useCatalogue } from '../lib/use-catalogue';

export default function HomeScreen() {
  const { session, signOut } = useSession();
  if (!session) return <Redirect href="/sign-in" />;
  return <SignedInCatalogue session={session} signOut={signOut} />;
}

function SignedInCatalogue({ session, signOut }: { session: Session; signOut(): void }) {
  const { connector, products, lastSyncedAt, error } = useCatalogue(session);
  const [pending, setPending] = useState(false);
  const traitContext = useMemo(() => ({ currency: session.settings.currency }), [session.settings.currency]);

  async function handleSignOut() {
    setPending(true);
    const result = await removeCatalogueDatabaseWithin();
    setPending(false);
    signOut();
    if (result === 'timed_out' && Platform.OS === 'web') {
      // A hung storage worker is recovered by a reload (ADR-061).
      window.location.reload();
    }
  }

  return (
    <VStack className="flex-1 bg-background">
      <Stack.Screen options={{ title: 'VendurePOS' }} />
      <HStack className="items-center justify-between border-b border-border px-4 py-2" space="sm">
        <Text testID="signed-in-store" className="flex-1 text-sm text-muted-foreground">Signed in to {session.url}</Text>
        <Button testID="sign-out" variant="secondary" disabled={pending} onPress={handleSignOut}>
          <Text>Sign out</Text>
        </Button>
      </HStack>
      <ConnectorProvider connector={connector} traitContext={traitContext}>
        <Catalogue
          products={products}
          traits={connector.traits.product}
          currency={session.settings.currency}
          lastSyncedAt={lastSyncedAt}
          // Cart integration is a later job.
          onSelect={() => {}}
          statusText={error ?? (lastSyncedAt ? undefined : 'Syncing catalogue…')}
        />
      </ConnectorProvider>
    </VStack>
  );
}
