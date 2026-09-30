import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, ScrollView, useWindowDimensions, View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { Button, Catalogue, HStack, Text, VStack } from '@tallyui/components';
import { ConnectorProvider, type ServerCapabilities } from '@tallyui/core';
import {
  CurrencyProvider, getDeviceId, TaxProvider, taxProviderProps, useOrderOutbox, useSale, type OutboxState, type UseOrderOutboxResult,
} from '@tallyui/pos';
import { removeCatalogueDatabaseWithin } from '../lib/catalogue';
import { logout } from '../lib/logout';
import { openOrderStore, outboxStoreKey } from '../lib/orders-db';
import { orderTransport } from '../lib/order-transport';
import { SaleCart } from '../lib/sale-cart';
import { SaleReceipt } from '../lib/sale-receipt';
import { SaleTender } from '../lib/sale-tender';
import { defaultStore, sessionContext, type Session } from '../lib/session';
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
  const [registerId] = useState(() => getDeviceId(defaultStore(), REGISTER_ID_KEY));
  // The store's latest capabilities, for the order.create version of each first send: set when the settings are
  // ready (before the outbox opens) and by a refresh that reads them, never cleared by a failed one.
  const capabilities = useRef<ServerCapabilities | undefined>(undefined);
  useEffect(() => { if (saleSettings.status === 'ready') capabilities.current = saleSettings.capabilities; }, [saleSettings]);
  // Here rather than in the sale, so orders keep sending while the sale shows a notice.
  const outbox = useOrderOutbox({
    storeKey: outboxStoreKey(session, saleSettings), open: openOrderStore, transport: () => orderTransport(session), deviceId: registerId,
    getMaxOrderCreateVersion: () => capabilities.current?.orderCreate,
    refreshCapabilities: async () => {
      const read = await connector.capabilities?.(sessionContext(session));
      if (read) capabilities.current = read;
    },
  });
  const notice = outboxNotice(outbox.state);
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
        {outbox.state.pending ? (
          <Text testID="orders-waiting" className="text-sm text-muted-foreground">
            {countOrders(outbox.state.pending)} waiting to send{outbox.state.sending ? ' · sending…' : ''}
          </Text>
        ) : null}
        {outbox.state.rejected ? (
          <Text testID="orders-rejected" className="text-sm text-muted-foreground">{countOrders(outbox.state.rejected)} need attention</Text>
        ) : null}
        {/* A record() not yet settled would be lost with the sale; the outbox closes its store at unmount. */}
        <Button testID="sign-out" variant="secondary" disabled={pending || saving || outbox.savesInFlight > 0} onPress={handleSignOut}>
          <Text>Sign out</Text>
        </Button>
      </HStack>
      {notice ? <Text testID="orders-notice" className="border-b border-border px-4 py-2 text-sm text-muted-foreground">{notice}</Text> : null}
      <ConnectorProvider connector={connector} traitContext={traitContext} stockOverlay={stockOverlay} stockOverlayAsOf={stockOverlayAsOf}>
        {saleSettings.status === 'ready' ? (
          <CurrencyProvider currencyCode={saleSettings.settings.currency}>
            <TaxProvider {...taxProviderProps(saleSettings.settings)} rateCodes={saleSettings.rateCodes}>
              <Sale session={session} capabilities={saleSettings.capabilities} catalogue={catalogue} registerId={registerId}
                outbox={outbox} onSaving={setSaving} />
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

function countOrders(count: number): string {
  return `${count} ${count === 1 ? 'order' : 'orders'}`;
}

/** The one outbox notice the header shows, the most pressing first; undefined when there is none. */
function outboxNotice({ authRequired, refused, backendMissing, stuck }: OutboxState): string | undefined {
  if (authRequired) return 'The store refused this sign-in. Sign out, then sign in again.';
  if (refused) return `The store refused the orders (${refused.reason}). They are kept and will be sent again.`;
  if (backendMissing) return "The store's VendurePOS plugin isn't answering. Orders are kept and retried.";
  if (stuck) return `${countOrders(stuck.commandIds.length)} keep failing at the store. They are kept and retried.`;
}

function Sale({ session, capabilities, catalogue, registerId, outbox, onSaving }: {
  session: Session; capabilities?: ServerCapabilities; catalogue: ReturnType<typeof useCatalogue>; registerId: string;
  outbox: UseOrderOutboxResult; onSaving(saving: boolean): void;
}) {
  const { connector, products, lastSyncedAt, error, stockOverlayAsOf } = catalogue;
  // The session knows the cashier only by the email they signed in with. Its orders go to its own store's outbox.
  const sale = useSale(session.settings, {
    registerId, cashierRef: session.email, capabilities, onSaleCompleted: outbox.record, isStored: outbox.isStored,
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
