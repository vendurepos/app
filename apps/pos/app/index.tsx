import { useMemo, useState } from 'react';
import { Platform, useWindowDimensions, View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { Button, Catalogue, HStack, Text, VStack } from '@tallyui/components';
import { ConnectorProvider, type ServerCapabilities } from '@tallyui/core';
import { CurrencyProvider, getDeviceId, TaxProvider, taxProviderProps, useSale } from '@tallyui/pos';
import { removeCatalogueDatabaseWithin } from '../lib/catalogue';
import { logout } from '../lib/logout';
import { SaleCart } from '../lib/sale-cart';
import { defaultStore, type Session } from '../lib/session';
import { useSession } from '../lib/session-context';
import { useCatalogue } from '../lib/use-catalogue';
import { useSaleSettings } from '../lib/use-sale-settings';

// The till's register id, minted once per device (medusapos uses 'medusapos.register_id').
const REGISTER_ID_KEY = 'vendurepos.register_id';
// From this window width the cart sits beside the catalogue; below it, under it.
const WIDE_MIN_WIDTH = 768;

export default function HomeScreen() {
  const { session, signOut } = useSession();
  if (!session) return <Redirect href="/sign-in" />;
  return <SignedInCatalogue session={session} signOut={signOut} />;
}

function SignedInCatalogue({ session, signOut }: { session: Session; signOut(): void }) {
  const catalogue = useCatalogue(session);
  const { connector, stockOverlay, stockOverlayAsOf } = catalogue;
  const saleSettings = useSaleSettings(session, connector);
  const [pending, setPending] = useState(false);
  const traitContext = useMemo(() => ({ currency: session.settings.currency }), [session.settings.currency]);

  async function handleSignOut() {
    setPending(true);
    const result = await removeCatalogueDatabaseWithin();
    await logout(session);
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
      <ConnectorProvider connector={connector} traitContext={traitContext} stockOverlay={stockOverlay} stockOverlayAsOf={stockOverlayAsOf}>
        {saleSettings ? (
          <CurrencyProvider currencyCode={saleSettings.settings.currency}>
            <TaxProvider {...taxProviderProps(saleSettings.settings)} rateCodes={saleSettings.rateCodes}>
              <Sale session={session} capabilities={saleSettings.capabilities} catalogue={catalogue} />
            </TaxProvider>
          </CurrencyProvider>
        ) : <Text className="p-4 text-sm text-muted-foreground">Loading store settings…</Text>}
      </ConnectorProvider>
    </VStack>
  );
}

function Sale({ session, capabilities, catalogue }: {
  session: Session; capabilities?: ServerCapabilities; catalogue: ReturnType<typeof useCatalogue>;
}) {
  const { connector, products, lastSyncedAt, error, stockOverlayAsOf } = catalogue;
  const [registerId] = useState(() => getDeviceId(defaultStore(), REGISTER_ID_KEY));
  // The session knows the cashier only by the email they signed in with.
  const sale = useSale(session.settings, { registerId, cashierRef: session.email, capabilities });
  const wide = useWindowDimensions().width >= WIDE_MIN_WIDTH;
  return (
    <View className={wide ? 'flex-1 flex-row' : 'flex-1'}>
      <View className="flex-1">
        <Catalogue
          products={products}
          traits={connector.traits.product}
          currency={session.settings.currency}
          lastSyncedAt={lastSyncedAt}
          lastStockCheckAt={stockOverlayAsOf ? new Date(stockOverlayAsOf) : null}
          onSelect={(entry) => sale.add(entry, connector.traits.product)}
          statusText={error ?? (lastSyncedAt ? undefined : 'Syncing catalogue…')}
        />
      </View>
      <View className={wide ? 'w-96 border-l border-border' : 'h-80 border-t border-border'}>
        <SaleCart sale={sale} />
      </View>
    </View>
  );
}
