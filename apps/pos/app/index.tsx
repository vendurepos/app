import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, ScrollView, useWindowDimensions, View } from 'react-native';
import { Link, Redirect, Stack } from 'expo-router';
import Constants from 'expo-constants';
import {
  Button, Catalogue, ClosureSheet, HStack, OpenRegisterCard, OrdersList, RegisterColumn, RegisterCount, RegisterPanel, Tabs, TabsList,
  TabsTrigger, Text, VStack,
} from '@tallyui/components';
import { ConnectorProvider, useStockOverlaid, type ServerCapabilities } from '@tallyui/core';
import {
  catalogueEntries, CurrencyProvider, findEntryByCode, registerCommandsLogger, TaxProvider, taxProviderProps, useCurrencyFormatter,
  useOrderOutbox, useRegisterOutbox, useRegisterSession, useSale, type OutboxState, type UseOrderOutboxResult,
} from '@tallyui/pos';
import { Portal } from '@tallyui/primitives';
import { cartTabLabel } from '../lib/cart-totals';
import { removeCatalogueDatabaseWithin } from '../lib/catalogue';
import { holdClosuresForOrders, pendingSessionOrders, useClosureWaiting, useFlushOnDrain } from '../lib/closure-hold';
import { DEMO_MODE } from '../lib/demo/mode';
import { logout } from '../lib/logout';
import { openOrderStore, ordersDatabaseName, outboxStoreKey, registerCollections } from '../lib/orders-db';
import { orderTransport } from '../lib/order-transport';
import { startTenderInSession } from '../lib/pay-gate';
import { loadPriceEditAllowed } from '../lib/price-edit-setting';
import { printLines } from '../lib/print-lines';
import { loadVarianceLimitMinor } from '../lib/register-approval';
import { registerSyncNotice, useRejectedRegisterCommands } from '../lib/register-sync';
import { SaleCart } from '../lib/sale-cart';
import { SaleCustomer } from '../lib/sale-customer';
import { SaleReceipt } from '../lib/sale-receipt';
import { SaleTender } from '../lib/sale-tender';
import { defaultStore, type Session } from '../lib/session';
import { useSession } from '../lib/session-context';
import { SignInAgain } from '../lib/sign-in-again';
import { signOutLockReason } from '../lib/sign-out-lock';
import { errorDetail, orderStoreFailureMessage } from '../lib/storage-start-failure';
import { storeLabel } from '../lib/store-label';
import { boundRegisterId as mintBoundRegisterId, deviceId } from '../lib/till-ids';
import { useTypedApproval } from '../lib/typed-approval';
import { FORBIDDEN_TEXT, SESSION_ENDED_TEXT, useCatalogue } from '../lib/use-catalogue';
import { MIN_ORDER_CREATE, readCapabilities, useSaleSettings } from '../lib/use-sale-settings';
import { useWedgeScanner } from '../lib/use-wedge-scanner';
import { unsyncedNote, zReportLines } from '../lib/z-report';

// Stamped on each closure; the plugin needs a non-empty softwareVersion.
const APP_VERSION = Constants.expoConfig?.version ?? 'unknown';
// The business day a session opens on is the device's.
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
// From this window width the cart sits beside the catalogue; below it, Products and Cart are tabs.
const WIDE_MIN_WIDTH = 768;
// How long the Cart tab lights up when an add on the Products tab lands in the cart (vendurepos #70), and a cart line
// when an add lands where the cart shows.
const CART_HIGHLIGHT_MS = 600;

export default function HomeScreen() {
  const { session, signOut } = useSession();
  if (!session) return <Redirect href={DEMO_MODE ? '/demo' : '/sign-in'} />;
  return <SignedInCatalogue session={session} signOut={signOut} />;
}

function SignedInCatalogue({ session, signOut }: { session: Session; signOut(): void }) {
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const wide = useWindowDimensions().width >= WIDE_MIN_WIDTH;
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
  const [storageFailure, setStorageFailure] = useState<{ message: string; detail: string } | null>(null);
  // Here rather than in the sale, so orders keep sending while the sale shows a notice.
  const outbox = useOrderOutbox({
    storeKey: outboxStoreKey(session, saleSettings), open: (name) => openOrderStore(name, Platform.OS), transport: () => orderTransport(() => sessionRef.current),
    deviceId: registerId,
    onOpenError: (error) => setStorageFailure({ message: orderStoreFailureMessage(error), detail: errorDetail(error) }),
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
  const sessionEnded = outbox.state.authRequired || catalogue.error === SESSION_ENDED_TEXT;
  const traitContext = useMemo(() => ({ currency: session.settings.currency }), [session.settings.currency]);
  const currency = session.settings.currency;
  // The register's collections share the orders database, so they open, close and are kept with it.
  const registerStore = useMemo(() => registerCollections(outbox.orders), [outbox.orders]);
  // Register commands go to the same POST /tally/v1/commands as the orders, from the one register outbox over this
  // collection (TallyUI #357: a second would send twice). No result is applied to the session yet (TallyUI's c2b
  // anchoring), so results are only logged. A closure waits for its session's orders (lib/closure-hold.ts); the till
  // opens its next session meanwhile. The collection is set only once the orders are open, so `orders` is too.
  const registerOutbox = useRegisterOutbox({
    commands: registerStore?.commands ?? null, deviceId: registerId,
    transport: () => holdClosuresForOrders(orderTransport(() => sessionRef.current), pendingSessionOrders(outbox.orders!)),
    onResult: (command, result) => registerCommandsLogger.debug('Register command result', { key: command.key, result }),
  });
  // Once orders have gone, a held closure goes at once rather than at the end of its backoff.
  useFlushOnDrain(outbox.state.pending, () => void registerOutbox.flush());
  const closingWaiting = useClosureWaiting(registerStore?.commands ?? null, outbox.orders);
  const rejectedRegisterCommands = useRejectedRegisterCommands(registerStore?.commands ?? null);
  const registerNotice = registerSyncNotice(registerOutbox.state, rejectedRegisterCommands);
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
    varianceThreshold: loadVarianceLimitMinor(),
  });
  const [registerOpen, setRegisterOpen] = useState(false);
  // The session being counted or closed: once its closure (whose id is the session's) is written, it shows as the Z.
  const [closingSessionId, setClosingSessionId] = useState<string | null>(null);
  const { id: sessionId, status: sessionStatus } = register.session ?? {};
  useEffect(() => { if (sessionId && sessionStatus !== 'open') setClosingSessionId(sessionId); }, [sessionId, sessionStatus]);
  const closureShown = !!closingSessionId && register.lastClosure?.id === closingSessionId;
  const registerPanelShown = registerOpen && sessionStatus === 'open';
  const printZ = async () => {
    const closure = register.lastClosure;
    if (!closure) return;
    await printLines(`Z report #${closure.number}`,
      zReportLines(closure, { store: storeLabel(session), currency, timezone: TIMEZONE, printedAt: new Date().toISOString() }));
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

  const signOutLocked = signOutLockReason({ saving, savesInFlight: outbox.savesInFlight, closing: register.closing });

  // An order store that can't open would lose the next sale at tender, so replace the sale instead of showing it.
  if (storageFailure) return <StorageFailure {...storageFailure} />;

  return (
    <VStack className="flex-1 bg-background">
      {/* A printed receipt is the receipt alone: the till's chrome carries print: 'hide' (lib/sale-receipt.tsx). */}
      <Stack.Screen options={{ title: 'VendurePOS', headerTitle: ({ children }) => (
        <View dataSet={{ print: 'hide' }}><Text className="text-lg font-semibold">{children}</Text></View>
      ) }} />
      <HStack dataSet={{ print: 'hide' }} className="flex-wrap items-center justify-between border-b border-border px-4 py-2" space="sm">
        <Text testID="signed-in-store" className={`${wide ? 'flex-1' : 'w-full'} text-sm text-muted-foreground`}>Signed in to {storeLabel(session)}</Text>
        {outbox.state.pending ? (
          <Text testID="orders-waiting" className="text-sm text-muted-foreground">
            {countOrders(outbox.state.pending)} waiting to send{outbox.state.sending ? ' · sending…' : ''}
          </Text>
        ) : null}
        {closingWaiting ? (
          <Text testID="register-closing-pending" className="text-sm text-muted-foreground">
            Closing — waiting for {countOrders(closingWaiting)}
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
        <Link href="/settings" testID="settings-open" className="rounded-md bg-secondary px-4 py-2">
          <Text className="text-secondary-foreground">Settings</Text>
        </Link>
        {/* A record() not yet settled would be lost with the sale, and a close with its Z; the outbox closes its store at unmount. */}
        {signOutLocked && !pending ? (
          <Text testID="sign-out-locked" className="text-sm text-muted-foreground">{signOutLocked}</Text>
        ) : null}
        <Button testID="sign-out" variant="secondary" disabled={pending || !!signOutLocked}
          onPress={handleSignOut}>
          <Text>Sign out</Text>
        </Button>
      </HStack>
      {sessionEnded ? (
        <View testID="sign-in-again" className="border-b border-border px-4 py-2">
          <SignInAgain session={session} onSignedIn={(next) => { sessionRef.current = next; void outbox.flush(); void registerOutbox.flush(); }} />
        </View>
      ) : null}
      {notice ? (
        <HStack dataSet={{ print: 'hide' }} className="items-center border-b border-border px-4 py-2" space="sm">
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
      {registerNotice ? (
        <HStack dataSet={{ print: 'hide' }} className="items-center border-b border-border px-4 py-2" space="sm">
          <Text testID="register-sync-notice" className="flex-1 text-sm text-muted-foreground">{registerNotice}</Text>
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
                  registerReady={!!registerStore} onTender={setTenderInProgress} panelOpen={ordersOpen || registerPanelShown}
                  onClosePanels={() => { setOrdersOpen(false); setRegisterOpen(false); }}
                  registerClosing={(!!sessionStatus && sessionStatus !== 'open') || register.closing || closureShown}
                  overSheet={closureShown} />
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
      {/* Mounted only while open, so a scan that closes it closes a cash-movement sheet within it for good. */}
      {registerPanelShown ? <RegisterPanel register={register} currency={currency} open onOpenChange={setRegisterOpen} /> : null}
      {closureShown && register.lastClosure ? (
        <>
          <ClosureSheet register={register} currency={currency} onPrint={printZ} onDone={() => setClosingSessionId(null)} />
          {/* Drawn after the sheet, so above it: the store's figures may lag this Z until these orders are sent. */}
          {register.lastClosure.unsynced_count > 0 ? (
            <Portal name="closure-unsynced">
              <View className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-md border border-border bg-background px-4 py-2">
                <Text testID="closure-unsynced">{unsyncedNote(register.lastClosure.unsynced_count)}</Text>
              </View>
            </Portal>
          ) : null}
        </>
      ) : null}
    </VStack>
  );
}

function StorageFailure({ message, detail }: { message: string; detail: string }) {
  return (
    <VStack className="flex-1 items-center justify-center bg-background p-6" space="md">
      <Text testID="storage-failure" accessibilityRole="alert">{message}</Text>
      {Platform.OS === 'web' ? (
        <Button testID="storage-failure-reload" onPress={() => window.location.reload()}><Text>Reload</Text></Button>
      ) : null}
      <Text testID="storage-failure-detail" selectable className="text-sm text-muted-foreground">{detail}</Text>
    </VStack>
  );
}

function countOrders(count: number): string {
  return `${count} ${count === 1 ? 'order' : 'orders'}`;
}

/** The one outbox notice the header shows, the most pressing first; undefined when there is none. */
function outboxNotice({ authRequired, refused, backendMissing, stuck }: OutboxState): string | undefined {
  if (authRequired) return 'The store refused this sign-in. Sign in again below; orders are kept.';
  if (refused) return `The store refused the orders (${refused.reason}). They are kept; send them again once the store is fixed.`;
  if (backendMissing) return "The store's VendurePOS plugin isn't answering. Orders are kept and retried.";
  if (stuck) return `${countOrders(stuck.commandIds.length)} keep failing at the store. They are kept and retried.`;
}

function Sale({
  session, capabilities, catalogue, registerId, outbox, onSaving, register, boundRegisterId, registerReady, onTender, panelOpen, onClosePanels,
  registerClosing, overSheet,
}: {
  session: Session; capabilities?: ServerCapabilities; catalogue: ReturnType<typeof useCatalogue>; registerId: string;
  outbox: UseOrderOutboxResult; onSaving(saving: boolean): void; register: ReturnType<typeof useRegisterSession>;
  boundRegisterId: string; registerReady: boolean; onTender(inProgress: boolean): void;
  /** The Orders or the Register panel (and any cash-movement sheet in it) covers the sale. */
  panelOpen: boolean; onClosePanels(): void;
  /** The register is counting, closing or showing its Z. */
  registerClosing: boolean;
  /** The Z sheet shows: the scan notice goes over it. */
  overSheet: boolean;
}) {
  const { connector, products, lastSyncedAt, error, stockOverlayAsOf } = catalogue;
  const typedApproval = useTypedApproval();
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
    setPayError(await startTenderInSession(register, sale, method));
  }
  const format = useCurrencyFormatter();
  // Narrow only. The cashier picks the tab: an add, a scan or a tender never switches it (but for a scan that closes a
  // panel), and the Cart tab shows whatever stage the sale is at.
  const [tab, setTab] = useState<'products' | 'cart'>('products');
  // The Cart tab, or the SKU of the cart line an add just landed on.
  const [highlight, setHighlight] = useState<'tab' | { sku: string | undefined } | null>(null);
  // A scanned code no product has, or a scan while this sale is being paid or the register closed: shown on either tab
  // until the next add (a payment's notice also until the tender ends, a closing one until the register is done).
  const [scanNotice, setScanNotice] = useState<{ notFound: string } | 'finish-sale' | 'finish-closing' | null>(null);
  useEffect(() => { if (stage.kind !== 'tender') setScanNotice((notice) => notice === 'finish-sale' ? null : notice); }, [stage.kind]);
  useEffect(() => { if (!registerClosing) setScanNotice((notice) => notice === 'finish-closing' ? null : notice); }, [registerClosing]);
  const highlightTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(highlightTimer.current), []);
  const onProducts = !wide && tab === 'products';
  function add(entry: Parameters<typeof sale.add>[0], showLine = !onProducts, scanned = false) {
    // Only the cart takes new lines: a tender or a receipt is for the sale as it stands (a scan has just left them).
    if (stage.kind !== 'cart' && !scanned) return;
    sale.add(entry, connector.traits.product);
    setScanNotice(null);
    // Confirmed in place: on Products the Cart tab's count and total tick up and the tab lights up briefly; where the
    // cart shows, the line lights up.
    setHighlight(showLine ? { sku: entry.variant.sku } : 'tab');
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlight(null), CART_HIGHLIGHT_MS);
  }
  const cart = (payGate?: ReactNode) => (
    <>
      <SaleCustomer sale={sale} connector={connector} session={session} />
      <SaleCart sale={sale} canEditPrice={loadPriceEditAllowed()} onPay={(method) => void pay(method)} payGate={payGate} payError={payError}
        highlightSku={typeof highlight === 'object' ? highlight?.sku : undefined} />
    </>
  );
  // A scan outside a text field, on either tab: the catalogue search's own barcode-then-SKU lookup over the same
  // stock-overlaid entries. A scan into the search field is the field's alone (the listener leaves inputs be): one add.
  const scannable = useStockOverlaid(products) as typeof products;
  // A scan is intent to sell (Front desk, 2026-09-30; docs/scan-policy.md): it closes the Orders or Register panel (and a
  // cash-movement sheet), and an add shows its line on the Cart tab. The register counting or closing adds nothing and
  // says so. From the receipt it starts the next sale (New sale), and from a tender with no payment it goes back to the
  // cart (Back to the cart), then adds. A payment entered (cash typed, a card tender's own payment) or saving is this sale
  // being finished: the scan changes nothing and says so. An unknown code only says so, whatever the stage.
  useWedgeScanner((code) => {
    const entry = findEntryByCode(catalogueEntries(scannable, connector.traits.product), code);
    const paying = stage.kind === 'tender' && (sale.saving || sale.order.payments.length > 0);
    if (panelOpen) onClosePanels();
    if (!entry) return setScanNotice({ notFound: code });
    if (registerClosing) return setScanNotice('finish-closing');
    if (paying) return setScanNotice('finish-sale');
    if (stage.kind === 'receipt') sale.newSale();
    if (stage.kind === 'tender') sale.cancelTender();
    if (panelOpen) setTab('cart');
    add(entry, panelOpen || !onProducts, true);
  });
  const notice = scanNotice === 'finish-sale' ? (
    <Text testID="scan-finish-sale" className="text-sm text-muted-foreground">Finish this sale before scanning the next item.</Text>
  ) : scanNotice === 'finish-closing' ? (
    <Text testID="scan-finish-closing" className="text-sm text-muted-foreground">Finish closing the register before scanning.</Text>
  ) : scanNotice ? (
    // The catalogue search's own wording for a code with no product.
    <Text testID="scan-not-found" className="text-sm text-muted-foreground">{`No products match "${scanNotice.notFound}".`}</Text>
  ) : null;
  return (
    <View className={wide ? 'flex-1 flex-row' : 'flex-1'}>
      {wide ? null : (
        <Tabs value={tab} onValueChange={(value) => setTab(value === 'cart' ? 'cart' : 'products')}>
          <TabsList dataSet={{ print: 'hide' }} className="m-2 flex-row">
            <TabsTrigger testID="tab-products" value="products" className="flex-1"><Text>Products</Text></TabsTrigger>
            <TabsTrigger testID="tab-cart" value="cart" className="flex-1">
              {highlight === 'tab' ? (
                <View testID="tab-cart-highlight" pointerEvents="none" className="absolute inset-0 rounded-sm border border-primary bg-primary/10" />
              ) : null}
              <Text>{cartTabLabel(sale.order, format)}</Text>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {notice && overSheet ? (
        // Drawn after the Z sheet, so above it, and below its unsynced note: a scan is never silent.
        <Portal name="scan-notice">
          <View className="fixed left-1/2 top-20 z-50 -translate-x-1/2 rounded-md border border-border bg-background px-4 py-2">{notice}</View>
        </Portal>
      ) : notice ? <View dataSet={{ print: 'hide' }} className="border-b border-border px-4 py-2">{notice}</View> : null}
      {/* The tab not shown is hidden, never unmounted: the catalogue keeps its search and the cart its stage. */}
      <View dataSet={{ print: 'hide' }} className="flex-1" style={!wide && tab === 'cart' ? { display: 'none' } : undefined}>
        {/* A failed first pull is not loading despite having no sync timestamp. */}
        <Catalogue
          loading={!lastSyncedAt && !error}
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
            <SaleReceipt sale={sale} store={storeLabel(session)} cashier={session.email} registerId={registerId} />
          </ScrollView>
        ) : register.session ? (
          // Counting (or finishing a close) swaps the cart for the count; one drawer per till, so no picker.
          <RegisterColumn register={register} registerId={boundRegisterId} registers={[]} onPick={() => undefined} currency={currency}
            countSlot={<RegisterCount register={register} currency={currency} approve={typedApproval.approve} />} cartEmpty={!sale.order.lineItems.length}>
            {cart()}
          </RegisterColumn>
        ) : cart(registerReady
          // The cart stays usable with no session; only Pay waits for the register to open (INTEGRATION.md).
          ? <OpenRegisterCard register={register} currency={currency} className="mt-2 border border-border" />
          : <Text className="mt-2 text-sm text-muted-foreground">Opening the register…</Text>)}
      </View>
      {typedApproval.dialog}
    </View>
  );
}
