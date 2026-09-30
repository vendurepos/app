import { useEffect, useMemo, useState } from 'react';
import { Platform, ScrollView, useWindowDimensions, View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { Button, Catalogue, HStack, Text, VStack } from '@tallyui/components';
import { ConnectorProvider, type ServerCapabilities } from '@tallyui/core';
import { CurrencyProvider, getDeviceId, TaxProvider, taxProviderProps, useSale } from '@tallyui/pos';
import { removeCatalogueDatabaseWithin } from '../lib/catalogue';
import { logout } from '../lib/logout';
import { isOrderStored, recordOrder, usePendingOrderCount } from '../lib/orders-db';
import { SaleCart } from '../lib/sale-cart';
import { SaleReceipt } from '../lib/sale-receipt';
import { SaleTender } from '../lib/sale-tender';
import { defaultStore, type Session } from '../lib/session';
import { useSession } from '../lib/session-context';
import { SESSION_ENDED_TEXT, useCatalogue } from '../lib/use-catalogue';
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
  // Sign-out unmounts the sale: a save still pending (in flight, or failed and not yet retried) would be lost with it.
  const [saving, setSaving] = useState(false);
  const waiting = usePendingOrderCount();
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
        {waiting ? (
          <Text testID="orders-waiting" className="text-sm text-muted-foreground">
            {waiting} {waiting === 1 ? 'order' : 'orders'} waiting to send
          </Text>
        ) : null}
        <Button testID="sign-out" variant="secondary" disabled={pending || saving} onPress={handleSignOut}>
          <Text>Sign out</Text>
        </Button>
      </HStack>
      <ConnectorProvider connector={connector} traitContext={traitContext} stockOverlay={stockOverlay} stockOverlayAsOf={stockOverlayAsOf}>
        {saleSettings.status === 'ready' ? (
          <CurrencyProvider currencyCode={saleSettings.settings.currency}>
            <TaxProvider {...taxProviderProps(saleSettings.settings)} rateCodes={saleSettings.rateCodes}>
              <Sale session={session} capabilities={saleSettings.capabilities} catalogue={catalogue} onSaving={setSaving} />
            </TaxProvider>
          </CurrencyProvider>
        ) : catalogue.error === SESSION_ENDED_TEXT ? (
          // A refused session fails the settings reads too, and no retry fixes that: the catalogue's notice says why.
          <Text className="p-4 text-sm text-muted-foreground">{SESSION_ENDED_TEXT}</Text>
        ) : saleSettings.status === 'retrying' ? (
          // No sale on guessed settings: the cart waits until both reads succeed.
          <Text testID="sale-settings-retrying" className="p-4 text-sm text-muted-foreground">{"Can't reach the store's settings yet. Retrying…"}</Text>
        ) : <Text className="p-4 text-sm text-muted-foreground">Loading store settings…</Text>}
      </ConnectorProvider>
    </VStack>
  );
}

function Sale({ session, capabilities, catalogue, onSaving }: {
  session: Session; capabilities?: ServerCapabilities; catalogue: ReturnType<typeof useCatalogue>; onSaving(saving: boolean): void;
}) {
  const { connector, products, lastSyncedAt, error, stockOverlayAsOf } = catalogue;
  const [registerId] = useState(() => getDeviceId(defaultStore(), REGISTER_ID_KEY));
  // The session knows the cashier only by the email they signed in with.
  const sale = useSale(session.settings, {
    registerId, cashierRef: session.email, capabilities, onSaleCompleted: recordOrder, isStored: isOrderStored,
  });
  useEffect(() => onSaving(sale.saving), [sale.saving, onSaving]);
  const wide = useWindowDimensions().width >= WIDE_MIN_WIDTH;
  const { stage } = sale;
  return (
    <View className={wide ? 'flex-1 flex-row' : 'flex-1'}>
      <View className="flex-1">
        <Catalogue
          products={products}
          traits={connector.traits.product}
          currency={session.settings.currency}
          lastSyncedAt={lastSyncedAt}
          lastStockCheckAt={stockOverlayAsOf ? new Date(stockOverlayAsOf) : null}
          // Only the cart takes new lines: a tender or a receipt is for the sale as it stands.
          onSelect={(entry) => { if (stage.kind === 'cart') sale.add(entry, connector.traits.product); }}
          statusText={error ?? (lastSyncedAt ? undefined : 'Syncing catalogue…')}
        />
      </View>
      <View className={wide ? 'w-96 border-l border-border' : 'h-80 border-t border-border'}>
        {stage.kind === 'cart' ? <SaleCart sale={sale} /> : (
          <ScrollView>
            <SaleTender sale={sale} />
            <SaleReceipt sale={sale} store={session.url} cashier={session.email} registerId={registerId} />
          </ScrollView>
        )}
      </View>
    </View>
  );
}
