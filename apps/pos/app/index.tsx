import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, ScrollView, useWindowDimensions, View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import Constants from 'expo-constants';
import {
  Button, Catalogue, ClosureSheet, HStack, OpenRegisterCard, OrdersList, RegisterColumn, RegisterCount, RegisterPanel, Tabs, TabsList,
  TabsTrigger, Text, VStack,
} from '@tallyui/components';
import { ConnectorProvider, type ServerCapabilities } from '@tallyui/core';
import {
  createRegisterOutbox, CurrencyProvider, registerCommandsLogger, RegisterSessionRequiredError, TaxProvider, taxProviderProps,
  useCurrencyFormatter, useOrderOutbox, useRegisterSession, useSale, type OutboxState, type UseOrderOutboxResult,
} from '@tallyui/pos';
import { cartTabLabel } from '../lib/cart-totals';
import { removeCatalogueDatabaseWithin } from '../lib/catalogue';
import { logout } from '../lib/logout';
import { openOrderStore, ordersDatabaseName, outboxStoreKey, registerCollections } from '../lib/orders-db';
import { orderTransport } from '../lib/order-transport';
import { printLines } from '../lib/print-lines';
import { SaleCart } from '../lib/sale-cart';
import { SaleReceipt } from '../lib/sale-receipt';
import { SaleTender } from '../lib/sale-tender';
import { defaultStore, type Session } from '../lib/session';
import { useSession } from '../lib/session-context';
import { boundRegisterId as mintBoundRegisterId, deviceId } from '../lib/till-ids';
import { FORBIDDEN_TEXT, SESSION_ENDED_TEXT, useCatalogue } from '../lib/use-catalogue';
import { MIN_ORDER_CREATE, readCapabilities, useSaleSettings } from '../lib/use-sale-settings';
import { zReportLines } from '../lib/z-report';

// Stamped on each closure; the plugin needs a non-empty softwareVersion.
const APP_VERSION = Constants.expoConfig?.version ?? 'unknown';
// The business day a session opens on is the device's.
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
// The cashier-facing refusal for a Pay with no open session (RegisterSessionRequiredError carries only a code).
const OPEN_REGISTER_TEXT = 'Open the register to take payment.';
// From this window width the cart sits beside the catalogue; below it, Products and Cart are tabs.
const WIDE_MIN_WIDTH = 768;
// How long the Cart tab lights up when an add on the Products tab lands in the cart (vendurepos #70).
const CART_HIGHLIGHT_MS = 600;

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
  const [ordersOpen, setOrdersOpen] = useState(false);
  // Sign-out unmounts the sale: a save still pending (in flight, or failed and not yet retried) would be lost with it.
  const [saving, setSaving] = useState(false);
  const [registerId] = useState(() => deviceId(defaultStore()));
  // The store's latest capabilities, for the order.create version of each first send: set when the settings are
  // ready (before the outbox opens) and by a refresh that reads them, never cleared by a failed one.
  const capabilities = useRef<ServerCapabilities | undefined>(undefined);
  useEffect(() => { if (saleSettings.status === 'ready') capabilities.current = saleSettings.capabilities; }, [saleSettings]);
  // Here rather than in the sale, so orders keep sending while the sale shows a notice.
  const outbox = useOrderOutbox({
    storeKey: outboxStoreKey(session, saleSettings), open: (name) => openOrderStore(name, Platform.OS), transport: () => orderTransport(session),
    deviceId: registerId,
    getMaxOrderCreateVersion: () => capabilities.current?.orderCreate,
    refreshCapabilities: async () => {
      // Timed out like the sale's own read, so a hung /info can't hold the outbox's send.
      const read = connector.capabilities && await readCapabilities(session, connector);
      // Never below MIN_ORDER_CREATE: the outbox would re-send a refused order lower, without the net-discount rule;
      // kept at 4, such an order stays rejected and needs attention instead.
      if (read && read.orderCreate >= MIN_ORDER_CREATE) capabilities.current = read;
    },
  });
  const notice = outboxNotice(outbox.state);
  const traitContext = useMemo(() => ({ currency: session.settings.currency }), [session.settings.currency]);
  const currency = session.settings.currency;
  // The register's collections share the orders database, so they open, close and are kept with it.
  const registerStore = useMemo(() => registerCollections(outbox.orders), [outbox.orders]);
  // Register commands go to the same POST /tally/v1/commands as the orders. Nothing but the app starts this outbox
  // (TallyUI #290). No result is applied to the session yet (TallyUI's c2b anchoring), so results are only logged.
  useEffect(() => {
    if (!registerStore) return;
    const registerOutbox = createRegisterOutbox({
      collection: registerStore.commands, transport: orderTransport(session), deviceId: registerId,
      onResult: (command, result) => registerCommandsLogger.debug('Register command result', { key: command.key, result }),
    });
    registerOutbox.start();
    return () => registerOutbox.stop();
  }, [registerStore, session, registerId]);
  const [boundRegisterId] = useState(() => mintBoundRegisterId(defaultStore()));
  const [tenderInProgress, setTenderInProgress] = useState(false);
  const actor = useMemo(() => ({ id: session.email, name: session.email }), [session.email]);
  const readSettingsCapabilities = saleSettings.status === 'ready' ? saleSettings.capabilities : undefined;
  // The one register session hook for this store: the sale, the panel and the count share it.
  const register = useRegisterSession({
    sessions: registerStore?.sessions ?? null, movements: registerStore?.movements ?? null, closures: registerStore?.closures ?? null,
    commands: registerStore?.commands ?? null, orders: outbox.orders, register: registerStore?.sessions ?? null,
    capabilities: readSettingsCapabilities, storeKey: ordersDatabaseName(session), registerId: boundRegisterId,
    enabled: (readSettingsCapabilities?.register ?? 0) >= 1, actor, timezone: TIMEZONE, softwareVersion: APP_VERSION, tenderInProgress,
  });
  const [registerOpen, setRegisterOpen] = useState(false);
  // The session being counted or closed: once its closure (whose id is the session's) is written, it shows as the Z.
  const [closingSessionId, setClosingSessionId] = useState<string | null>(null);
  const { id: sessionId, status: sessionStatus } = register.session ?? {};
  useEffect(() => { if (sessionId && sessionStatus !== 'open') setClosingSessionId(sessionId); }, [sessionId, sessionStatus]);
  const printZ = async () => {
    const closure = register.lastClosure;
    if (!closure) return;
    await printLines(`Z report #${closure.number}`,
      zReportLines(closure, { store: session.url, currency, timezone: TIMEZONE, printedAt: new Date().toISOString() }));
  };

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
          <Button testID="orders-rejected" variant="ghost" size="sm" onPress={() => setOrdersOpen(true)}>
            <Text className="text-sm text-muted-foreground">
              {countOrders(outbox.state.rejected)} {outbox.state.rejected === 1 ? 'needs' : 'need'} attention
            </Text>
          </Button>
        ) : null}
        {outbox.orders !== null ? (
          <Button testID="orders-open" variant="secondary" onPress={() => setOrdersOpen((open) => !open)}>
            <Text>Orders</Text>
          </Button>
        ) : null}
        {sessionStatus === 'open' ? (
          <Button testID="register-open-panel" variant="secondary" onPress={() => setRegisterOpen(true)}>
            <Text>Register</Text>
          </Button>
        ) : null}
        {/* A record() not yet settled would be lost with the sale, and a close with its Z; the outbox closes its store at unmount. */}
        <Button testID="sign-out" variant="secondary" disabled={pending || saving || outbox.savesInFlight > 0 || register.closing}
          onPress={handleSignOut}>
          <Text>Sign out</Text>
        </Button>
      </HStack>
      {notice ? (
        <HStack className="items-center border-b border-border px-4 py-2" space="sm">
          <Text testID="orders-notice" className="flex-1 text-sm text-muted-foreground">{notice}</Text>
          {/* The outbox pauses a refused batch until the next flush; a new sale's flush sends it too. */}
          {outbox.state.refused && !outbox.state.authRequired ? (
            <Button testID="orders-send-again" variant="secondary" size="sm" disabled={outbox.state.sending}
              onPress={() => void outbox.flush()}>
              <Text>Send again</Text>
            </Button>
          ) : null}
        </HStack>
      ) : null}
      {ordersOpen ? (
        <VStack testID="orders-panel" className="flex-1">
          <HStack className="border-b border-border px-4 py-2">
            <Button testID="orders-close" variant="secondary" size="sm" onPress={() => setOrdersOpen(false)}>
              <Text>Back to sale</Text>
            </Button>
          </HStack>
          <OrdersList orders={outbox.recent} onRetry={outbox.requeue} stuck={outbox.state.stuck}
            formatDate={(iso) => new Date(iso).toLocaleString()} />
        </VStack>
      ) : null}
      {/* Hidden, never unmounted, while the orders panel shows: the cart, tender or receipt in progress is kept. */}
      <View className="flex-1" style={ordersOpen ? { display: 'none' } : undefined}>
        <ConnectorProvider connector={connector} traitContext={traitContext} stockOverlay={stockOverlay} stockOverlayAsOf={stockOverlayAsOf}>
          {saleSettings.status === 'ready' ? (
            <CurrencyProvider currencyCode={saleSettings.settings.currency}>
              <TaxProvider {...taxProviderProps(saleSettings.settings)}>
                <Sale session={session} capabilities={saleSettings.capabilities} catalogue={catalogue} registerId={registerId}
                  outbox={outbox} onSaving={setSaving} register={register} boundRegisterId={boundRegisterId}
                  registerReady={!!registerStore} onTender={setTenderInProgress} />
              </TaxProvider>
            </CurrencyProvider>
          ) : catalogue.error === SESSION_ENDED_TEXT || catalogue.error === FORBIDDEN_TEXT ? (
            // A refused session or account fails the settings reads too: the catalogue's notice says why.
            <Text className="p-4 text-sm text-muted-foreground">{catalogue.error}</Text>
          ) : saleSettings.status === 'plugin' ? (
            // Below order.create 4 a discounted sale would lose the net-discount rule: no sale until the plugin is updated.
            <Text testID="sale-settings-plugin" className="p-4 text-sm text-muted-foreground">
              {"This store's VendurePOS plugin is missing or out of date. Install or update it, then this till continues."}
            </Text>
          ) : saleSettings.status === 'retrying' ? (
            // No sale on guessed settings: the cart waits until both reads succeed.
            <Text testID="sale-settings-retrying" className="p-4 text-sm text-muted-foreground">{"Can't reach the store's settings yet. Retrying…"}</Text>
          ) : <Text className="p-4 text-sm text-muted-foreground">Loading store settings…</Text>}
        </ConnectorProvider>
      </View>
      {/* Dialogs, drawn through the root PortalHost. */}
      <RegisterPanel register={register} currency={currency} open={registerOpen && sessionStatus === 'open'} onOpenChange={setRegisterOpen} />
      {closingSessionId && register.lastClosure?.id === closingSessionId ? (
        <ClosureSheet register={register} currency={currency} onPrint={printZ} onDone={() => setClosingSessionId(null)} />
      ) : null}
    </VStack>
  );
}

function countOrders(count: number): string {
  return `${count} ${count === 1 ? 'order' : 'orders'}`;
}

/** The one outbox notice the header shows, the most pressing first; undefined when there is none. */
function outboxNotice({ authRequired, refused, backendMissing, stuck }: OutboxState): string | undefined {
  if (authRequired) return 'The store refused this sign-in. Sign out, then sign in again.';
  if (refused) return `The store refused the orders (${refused.reason}). They are kept; send them again once the store is fixed.`;
  if (backendMissing) return "The store's VendurePOS plugin isn't answering. Orders are kept and retried.";
  if (stuck) return `${countOrders(stuck.commandIds.length)} keep failing at the store. They are kept and retried.`;
}

function Sale({ session, capabilities, catalogue, registerId, outbox, onSaving, register, boundRegisterId, registerReady, onTender }: {
  session: Session; capabilities?: ServerCapabilities; catalogue: ReturnType<typeof useCatalogue>; registerId: string;
  outbox: UseOrderOutboxResult; onSaving(saving: boolean): void; register: ReturnType<typeof useRegisterSession>;
  boundRegisterId: string; registerReady: boolean; onTender(inProgress: boolean): void;
}) {
  const { connector, products, lastSyncedAt, error, stockOverlayAsOf } = catalogue;
  // The session knows the cashier only by the email they signed in with. Its orders go to its own store's outbox, each
  // stamped with the register session it was taken in.
  const sale = useSale(session.settings, {
    registerId, cashierRef: session.email, capabilities, session: register.saleSession, onSaleCompleted: outbox.record,
    isStored: outbox.isStored,
  });
  useEffect(() => onSaving(sale.saving), [sale.saving, onSaving]);
  const wide = useWindowDimensions().width >= WIDE_MIN_WIDTH;
  const { stage } = sale;
  const currency = session.settings.currency;
  // The register refuses to count or close under a tender.
  useEffect(() => {
    onTender(stage.kind === 'tender');
    return () => onTender(false);
  }, [stage.kind, onTender]);
  const [payError, setPayError] = useState<string>();
  async function pay(method: 'cash' | 'external') {
    setPayError(undefined);
    try {
      // Read from storage, not the rendered session, and pinned to the tender (INTEGRATION.md). Null means sessions
      // are off, which this till never sells under: the settings gate needs MIN_REGISTER, and a database still opening
      // is refused the same way.
      const confirmed = await register.requireSaleSession();
      if (!confirmed) throw new RegisterSessionRequiredError();
      sale.startTender(method, { session: confirmed });
    } catch (refusal) {
      setPayError(refusal instanceof RegisterSessionRequiredError ? OPEN_REGISTER_TEXT : String(refusal));
    }
  }
  const cart = (payGate?: ReactNode) => <SaleCart sale={sale} onPay={(method) => void pay(method)} payGate={payGate} payError={payError} />;
  const format = useCurrencyFormatter();
  // Narrow only. The cashier picks the tab: an add, a scan or a tender never switches it, and the Cart tab shows
  // whatever stage the sale is at.
  const [tab, setTab] = useState<'products' | 'cart'>('products');
  const [highlight, setHighlight] = useState(false);
  const highlightTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(highlightTimer.current), []);
  const onProducts = !wide && tab === 'products';
  function add(entry: Parameters<typeof sale.add>[0]) {
    // Only the cart takes new lines: a tender or a receipt is for the sale as it stands.
    if (stage.kind !== 'cart') return;
    sale.add(entry, connector.traits.product);
    if (!onProducts) return;
    // Confirmed in place: the Cart tab's count and total tick up and the tab lights up briefly.
    setHighlight(true);
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlight(false), CART_HIGHLIGHT_MS);
  }
  return (
    <View className={wide ? 'flex-1 flex-row' : 'flex-1'}>
      {wide ? null : (
        <Tabs value={tab} onValueChange={(value) => setTab(value === 'cart' ? 'cart' : 'products')}>
          {/* Keyed on the tab for TallyUI #350 (on web the active fill stays on the tab it mounted with); removed once a
              fixed @tallyui/components is pinned. */}
          <TabsList key={tab} className="m-2 flex-row">
            <TabsTrigger testID="tab-products" value="products" className="flex-1"><Text>Products</Text></TabsTrigger>
            <TabsTrigger testID="tab-cart" value="cart" className="flex-1">
              {highlight ? (
                <View testID="tab-cart-highlight" pointerEvents="none" className="absolute inset-0 rounded-sm border border-primary bg-primary/10" />
              ) : null}
              <Text>{cartTabLabel(sale.order, format)}</Text>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {/* The tab not shown is hidden, never unmounted: the catalogue keeps its search and the cart its stage. */}
      <View className="flex-1" style={!wide && tab === 'cart' ? { display: 'none' } : undefined}>
        <Catalogue
          products={products}
          traits={connector.traits.product}
          currency={session.settings.currency}
          lastSyncedAt={lastSyncedAt}
          lastStockCheckAt={stockOverlayAsOf ? new Date(stockOverlayAsOf) : null}
          onSelect={add}
          statusText={error ?? (lastSyncedAt ? undefined : 'Syncing catalogue…')}
        />
      </View>
      <View className={wide ? 'w-96 border-l border-border' : 'flex-1'} style={onProducts ? { display: 'none' } : undefined}>
        {stage.kind !== 'cart' ? (
          <ScrollView>
            <SaleTender sale={sale} />
            <SaleReceipt sale={sale} store={session.url} cashier={session.email} registerId={registerId} />
          </ScrollView>
        ) : register.session ? (
          // Counting (or finishing a close) swaps the cart for the count; one drawer per till, so no picker.
          <RegisterColumn register={register} registerId={boundRegisterId} registers={[]} onPick={() => undefined} currency={currency}
            countSlot={<RegisterCount register={register} currency={currency} />} cartEmpty={!sale.order.lineItems.length}>
            {cart()}
          </RegisterColumn>
        ) : cart(registerReady
          // The cart stays usable with no session; only Pay waits for the register to open (INTEGRATION.md).
          ? <OpenRegisterCard register={register} currency={currency} className="mt-2 border border-border" />
          : <Text className="mt-2 text-sm text-muted-foreground">Opening the register…</Text>)}
      </View>
    </View>
  );
}
