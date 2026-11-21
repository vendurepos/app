import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import {
  Button, Card, CardContent, CardHeader, CardTitle, CustomerDisplaySettings, CustomerPicker, Dialog, DialogContent, DialogDescription, DialogTitle, HStack, Input, InputField, Label, SettingsLayout, SettingsRow, Switch, Text, ToggleGroup, ToggleGroupItem, VStack,
} from '@tallyui/components';
import { useTillDisplays, useTillPairing } from '@tallyui/pos';
import { minorUnitDigits } from '@tallyui/core';
import { loadAutoPrint, saveAutoPrint } from '../lib/auto-print-setting';
import { loadAutoShowReceipt, saveAutoShowReceipt } from '../lib/auto-show-receipt-setting';
import { CartSideSettings } from '../lib/cart-side-settings';
import { resetCartSettings } from '../lib/cart-settings-reset';
import type { TillCustomerDisplay } from '../lib/customer-display';
import { displayPageUrl } from '../lib/display-url';
import { loadDefaultCustomer, saveDefaultCustomer } from '../lib/default-customer';
import { loadOpenOrdersPosition, saveOpenOrdersPosition } from '../lib/open-orders-position-setting';
import { loadScannerMinLength, saveScannerMinLength, SCANNER_MIN_LENGTH_RANGE } from '../lib/scanner-settings';
import { ScannerExtraSettings } from '../lib/scanner-extra-settings';
import { loadPriceEditAllowed, savePriceEditAllowed } from '../lib/price-edit-setting';
import { PrinterSettings } from '../lib/printer-settings';
import { formatQuickDiscounts, loadQuickDiscounts, parseQuickDiscounts, saveQuickDiscounts } from '../lib/quick-discounts-setting';
import { formatVarianceLimit, loadVarianceLimitMinor, parseVarianceLimit, saveVarianceLimitMinor } from '../lib/register-approval';
import { RegisterChoiceSettings } from '../lib/register-choice-settings';
import { loadCloseBy, parseCloseBy, saveCloseBy } from '../lib/register-close-by';
import { formatOpeningFloat, loadOpeningFloatMinor, parseOpeningFloat, saveOpeningFloatMinor } from '../lib/register-float';
import { defaultStore, sessionContext, type Session } from '../lib/session';
import { settingsSections, type SettingsSectionId } from '../lib/settings-sections';
import { SyncLogCard } from '../lib/sync-log-card';
import { TaxSettings } from '../lib/tax-settings-card';
import { ThemeSettings } from '../lib/theme-settings';
import { boundRegisterId } from '../lib/till-ids';
import { TileSizeSettings } from '../lib/tile-size-settings';
import { useCatalogueConnector } from '../lib/use-catalogue';

/** Help under the display page URL: the second screen opens that page, then shows the code the till confirms. */
export const DISPLAY_URL_HELP = 'Open this page on the second screen, then enter the pairing code it shows.';

/** Web only: the display page's URL for this store, to copy or open (native has no hosted origin). */
function DisplayUrlRow({ storeUrl }: { storeUrl: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const url = displayPageUrl(window.location.origin, storeUrl);
  return (
    <Card testID="display-url-row" className="w-full max-w-[420px]">
      <CardContent className="pt-6">
        <VStack space="sm">
          <Text className="font-medium">Display page URL</Text>
          <Text testID="display-url" selectable className="text-sm">{url}</Text>
          <HStack space="sm">
            {typeof navigator !== 'undefined' && !!navigator.clipboard && (
              <Button testID="display-url-copy" size="sm" variant="secondary"
                onPress={() => navigator.clipboard.writeText(url).then(() => setCopied(true), () => setCopied(false))}><Text>Copy URL</Text></Button>
            )}
            <Button testID="display-url-open" size="sm" variant="secondary"
              onPress={() => { window.open(url, '_blank', 'noopener'); }}><Text>Open in browser</Text></Button>
          </HStack>
          {copied === true && <Text testID="display-url-copied">Copied.</Text>}
          {copied === false && <Text testID="display-url-copy-error">{"Couldn't copy the URL."}</Text>}
          <Text className="text-sm text-muted-foreground">{DISPLAY_URL_HELP}</Text>
        </VStack>
      </CardContent>
    </Card>
  );
}

/** Settings › Customer display over the till's handles; leaving it cancels a pairing, so no code stays showing. */
function CustomerDisplaySection({ handles, storeUrl }: { handles: TillCustomerDisplay; storeUrl: string }) {
  const { pairing, service } = handles;
  useEffect(() => () => pairing.cancel(), [pairing]);
  return (
    <>
      {Platform.OS === 'web' && <DisplayUrlRow storeUrl={storeUrl} />}
      <CustomerDisplaySettings className="w-full max-w-[420px]" pairing={useTillPairing(pairing)} displays={useTillDisplays(service)}
        onStartPairing={() => void pairing.start()} onConfirm={(id) => void pairing.confirm(id)} onDecline={(id) => void pairing.decline(id)}
        onCancelPairing={() => pairing.cancel()} onForget={(id) => void pairing.forget(id)} />
    </>
  );
}

export type SettingsCardId = 'cart' | 'products';
/** Settings' sections and cards: a covering panel of the till (CHECKLIST 9.1, the rail stays beside it), and the /settings route. */
export function SettingsPanel({ session, onClose, tillUpdatesPending, customerDisplay, initialSection, initialCard }: {
  session: Session; onClose(): void; tillUpdatesPending?: number; customerDisplay?: TillCustomerDisplay | null;
  initialSection?: SettingsSectionId;
  initialCard?: SettingsCardId;
}) {
  const scroll = useRef<ScrollView>(null);
  const pendingCard = useRef<SettingsCardId | null>(initialCard ?? null);
  const [text, setText] = useState(() => String(loadScannerMinLength()));
  const [saved, setSaved] = useState<boolean | null>(null);
  const [varianceText, setVarianceText] = useState(() => formatVarianceLimit(loadVarianceLimitMinor()));
  const [varianceSaved, setVarianceSaved] = useState<boolean | null>(null);
  const [closeByText, setCloseByText] = useState(() => loadCloseBy(boundRegisterId(defaultStore())) ?? '');
  const [closeBySaved, setCloseBySaved] = useState<boolean | null>(null);
  const digits = minorUnitDigits(session.settings.currency);
  const [openingFloatText, setOpeningFloatText] = useState(() => formatOpeningFloat(loadOpeningFloatMinor(boundRegisterId(defaultStore())), digits));
  const [openingFloatSaved, setOpeningFloatSaved] = useState<boolean | null>(null);
  const [quickText, setQuickText] = useState(() => formatQuickDiscounts(loadQuickDiscounts()));
  const [quickSaved, setQuickSaved] = useState<boolean | null>(null);
  const [canEditPrice, setCanEditPrice] = useState(() => loadPriceEditAllowed());
  const [defaultCustomer, setDefaultCustomer] = useState(() => loadDefaultCustomer(session));
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const [autoPrint, setAutoPrint] = useState(() => loadAutoPrint());
  const [autoShowReceipt, setAutoShowReceipt] = useState(() => loadAutoShowReceipt());
  const [openOrdersPosition, setOpenOrdersPosition] = useState(() => loadOpenOrdersPosition());
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [cartKey, setCartKey] = useState(0);
  const connector = useCatalogueConnector(session);
  const sections = settingsSections({ printing: Platform.OS === 'web', customerDisplay: !!customerDisplay });
  // Opens on the section asked for (Store health's View log asks for the sync log) when this till lists it.
  const [section, setSection] = useState<SettingsSectionId>(() =>
    initialSection && sections.some(({ id }) => id === initialSection) ? initialSection : 'general');
  // The store stopped advertising a display (or the session changed) while its section showed.
  useEffect(() => { if (!customerDisplay && section === 'customer-display') setSection('general'); }, [customerDisplay, section]);

  return (
    <SettingsLayout navSlot={
      <View className="gap-1 p-2">
        {sections.map(({ id, label }) => {
          const selected = section === id;
          return (
            <Pressable key={id} testID={`settings-section-${id}`} accessibilityRole="tab"
              aria-selected={selected} className={`rounded-md px-3 py-2${selected ? ' bg-muted' : ''}`}
              onPress={() => { pendingCard.current = null; setSection(id); }}>
              <Text className={`text-sm text-foreground${selected ? ' font-medium' : ''}`}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    } contentSlot={
    <ScrollView className="flex-1 bg-background"
      ref={scroll}
      onStartShouldSetResponderCapture={() => { pendingCard.current = null; return false; }}
      // The chosen section's cards; the sections are v2's Settings tabs (parity 9.1).
      contentContainerStyle={{ flexGrow: 1 }}>
    <VStack className="flex-1 items-center bg-background p-6" space="lg">
      {section === 'barcode' && <>
      <Card className="w-full max-w-[420px]">
        <CardHeader>
          <CardTitle aria-level={2}>Scanner</CardTitle>
        </CardHeader>
        <CardContent>
          <VStack space="lg">
            <Label nativeID="scanner-min-length-label">Shortest barcode the scanner reads</Label>
            <Input>
              <InputField
                testID="scanner-min-length"
                accessibilityLabel="Shortest barcode the scanner reads"
                accessibilityLabelledBy="scanner-min-length-label"
                keyboardType="number-pad"
                value={text}
                onChangeText={setText}
              />
            </Input>
            <Text>{`From ${SCANNER_MIN_LENGTH_RANGE.min} to ${SCANNER_MIN_LENGTH_RANGE.max} characters. A shorter fast burst is treated as typing.`}</Text>
            <Button testID="settings-save" onPress={() => setSaved(/^\d+$/.test(text) && saveScannerMinLength(Number(text)))}>
              <Text>Save</Text>
            </Button>
            {saved === true && <Text testID="settings-saved">Saved.</Text>}
            {saved === false && <Text testID="settings-error">{`Enter a whole number from ${SCANNER_MIN_LENGTH_RANGE.min} to ${SCANNER_MIN_LENGTH_RANGE.max}.`}</Text>}
            <ScannerExtraSettings />
          </VStack>
        </CardContent>
      </Card>
      <Text testID="settings-barcode-field">Barcode custom field: {session.barcodeField ?? 'none'}. Set when signing in.</Text>
      </>}
      {section === 'register' && (
      <Card className="w-full max-w-[420px]">
        <CardHeader><CardTitle aria-level={2}>Register</CardTitle></CardHeader>
        <CardContent>
          <VStack space="lg">
            <Label nativeID="variance-limit-label">{"Count difference that needs a manager's approval"}</Label>
            <Input><InputField testID="variance-limit" keyboardType="decimal-pad" value={varianceText} onChangeText={setVarianceText}
              accessibilityLabel="Count difference that needs a manager's approval" accessibilityLabelledBy="variance-limit-label" /></Input>
            <Text>{"Leave empty for no approval. The approver's name is typed, not verified."}</Text>
            <Button testID="variance-save" onPress={() => {
              const result = parseVarianceLimit(varianceText);
              if (result.ok) saveVarianceLimitMinor(result.minor);
              setVarianceSaved(result.ok);
            }}><Text>Save</Text></Button>
            {varianceSaved === true && <Text testID="variance-saved">Saved.</Text>}
            {varianceSaved === false && <Text testID="variance-error">Enter an amount such as 5.00, or leave it empty.</Text>}
            <Label nativeID="close-by-label">Close by</Label>
            <Input><InputField testID="close-by-time" placeholder="21:30" value={closeByText} onChangeText={setCloseByText}
              accessibilityLabel="Close by" accessibilityLabelledBy="close-by-label" /></Input>
            <Text>This device offers Close register after this time, once the cart is empty (24-hour, such as 21:30). Each device keeps its own. Leave empty for none.</Text>
            <Button testID="close-by-save" onPress={() => {
              const result = parseCloseBy(closeByText);
              if (result.ok) {
                saveCloseBy(boundRegisterId(defaultStore()), result.time);
                setCloseByText(result.time ?? '');
              }
              setCloseBySaved(result.ok);
            }}><Text>Save</Text></Button>
            {closeBySaved === true && <Text testID="close-by-saved">Saved.</Text>}
            {closeBySaved === false && <Text testID="close-by-error">Enter a time such as 21:30, or leave it empty.</Text>}
            <Label nativeID="opening-float-label">Opening float</Label>
            <Input><InputField testID="opening-float" keyboardType="decimal-pad" placeholder={formatOpeningFloat(10000, digits)} value={openingFloatText} onChangeText={setOpeningFloatText}
              accessibilityLabel="Opening float" accessibilityLabelledBy="opening-float-label" /></Input>
            <Text>Open register starts from this amount and offers it as a chip. Each device keeps its own. Leave empty for none.</Text>
            <Button testID="opening-float-save" onPress={() => {
              const result = parseOpeningFloat(openingFloatText, digits);
              if (result.ok) {
                saveOpeningFloatMinor(boundRegisterId(defaultStore()), result.minor);
                setOpeningFloatText(formatOpeningFloat(result.minor, digits));
              }
              setOpeningFloatSaved(result.ok);
            }}><Text>Save</Text></Button>
            {openingFloatSaved === true && <Text testID="opening-float-saved">Saved.</Text>}
            {openingFloatSaved === false && <Text testID="opening-float-error">Enter an amount such as 100.00, or leave it empty.</Text>}
          </VStack>
        </CardContent>
      </Card>
      )}
      {section === 'general' && <>
      <RegisterChoiceSettings session={session} tillUpdatesPending={tillUpdatesPending} />
      <Card className="w-full max-w-[420px]">
        <CardHeader><CardTitle aria-level={2}>Prices</CardTitle></CardHeader>
        <CardContent>
          <SettingsRow label="Price changes" description="Let cashiers change a line's price in the cart."
            action={<Switch testID="price-edit-toggle" accessibilityLabel="Price changes" checked={canEditPrice}
              onCheckedChange={(on) => { savePriceEditAllowed(on); setCanEditPrice(on); }} />} />
          <VStack space="sm" className="mt-4">
            <Label nativeID="quick-discounts-label">Quick discounts (%)</Label>
            <Input><InputField testID="quick-discounts" value={quickText} onChangeText={setQuickText}
              accessibilityLabel="Quick discounts (%)" accessibilityLabelledBy="quick-discounts-label" /></Input>
            <Text className="text-sm text-muted-foreground">{"Offered on a line's price keypad, such as 5, 10, 15. Leave empty for none."}</Text>
            <Button testID="quick-discounts-save" onPress={() => {
              const result = parseQuickDiscounts(quickText);
              if (result.ok) { saveQuickDiscounts(result.values); setQuickText(formatQuickDiscounts(result.values)); }
              setQuickSaved(result.ok);
            }}><Text>Save</Text></Button>
            {quickSaved === true && <Text testID="quick-discounts-saved">Saved.</Text>}
            {quickSaved === false && <Text testID="quick-discounts-error">Enter up to 6 whole percents from 1 to 100, such as 5, 10, 15.</Text>}
          </VStack>
        </CardContent>
      </Card>
      <View testID="settings-products-card" className="w-full items-center"
        onLayout={(event) => { if (pendingCard.current === 'products') scroll.current?.scrollTo({ y: event.nativeEvent.layout.y, animated: false }); }}>
        <TileSizeSettings />
      </View>
      <View testID="settings-cart-card" className="w-full items-center"
        onLayout={(event) => { if (pendingCard.current === 'cart') scroll.current?.scrollTo({ y: event.nativeEvent.layout.y, animated: false }); }}>
        <CartSideSettings key={cartKey} />
      </View>
      <Card className="w-full max-w-[420px]">
        <CardHeader><CardTitle aria-level={2}>Open orders</CardTitle></CardHeader>
        <CardContent>
          <ToggleGroup type="single" accessibilityLabel="Open orders position" testID="open-orders-position" value={openOrdersPosition}
            onValueChange={(value) => { if (value === 'top' || value === 'bottom') { saveOpenOrdersPosition(value); setOpenOrdersPosition(value); } }}>
            {(['top', 'bottom'] as const).map((item) => (
              <ToggleGroupItem key={item} value={item} testID={`open-orders-${item}`} className={item === openOrdersPosition ? 'flex-1 bg-secondary' : 'flex-1'}>
                <Text>{item === 'top' ? 'Top' : 'Bottom'}</Text>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </CardContent>
      </Card>
      <Button testID="cart-settings-restore" variant="outline" onPress={() => setRestoreOpen(true)}><Text>Restore default cart settings</Text></Button>
      <Dialog open={restoreOpen} onOpenChange={setRestoreOpen}>
        <DialogContent testID="cart-settings-restore-confirm" className="max-w-md">
          <DialogTitle>Restore the default cart settings?</DialogTitle>
          <DialogDescription>{"On this device, the cart's side, sort, columns and open orders, the quick discounts, and Printing's show and print after each sale go back to their defaults."}</DialogDescription>
          <HStack space="sm" className="justify-end">
            <Button testID="cart-settings-restore-cancel" variant="outline" onPress={() => setRestoreOpen(false)}><Text>Cancel</Text></Button>
            <Button testID="cart-settings-restore-yes" variant="destructive" onPress={() => {
              resetCartSettings();
              setOpenOrdersPosition(loadOpenOrdersPosition());
              setQuickText(formatQuickDiscounts(loadQuickDiscounts()));
              setQuickSaved(null);
              setAutoShowReceipt(loadAutoShowReceipt());
              setAutoPrint(loadAutoPrint());
              setCartKey(k => k + 1);
              setRestoreOpen(false);
            }}><Text>Restore</Text></Button>
          </HStack>
        </DialogContent>
      </Dialog>
      {connector?.searchCustomers ? (
        <Card className="w-full max-w-[420px]">
          <CardHeader><CardTitle aria-level={2}>Customers</CardTitle></CardHeader>
          <CardContent>
            <VStack space="lg">
              <Text testID="default-customer">Default customer: {defaultCustomer ? `${defaultCustomer.name}${defaultCustomer.email ? ` (${defaultCustomer.email})` : ''}` : 'none (guest sales)'}</Text>
              <Text>Each new sale starts with this customer. Remove it from a sale for a guest sale.</Text>
              {pickingCustomer ? (
                <View testID="default-customer-picker">
                  <CustomerPicker
                    search={(q) => connector.searchCustomers!(sessionContext(session), q, { limit: 20 })}
                    selected={null}
                    onSelect={(customer) => {
                      if (customer !== null) {
                        const selected = { id: customer.id, name: customer.name, email: customer.email };
                        saveDefaultCustomer(session, selected);
                        setDefaultCustomer(selected);
                      }
                      setPickingCustomer(false);
                    }}
                    onError={(e) => console.warn('Customer lookup failed', e)}
                    online={typeof navigator === 'undefined' || navigator.onLine !== false}
                  />
                </View>
              ) : (
                <Button testID="default-customer-choose" onPress={() => setPickingCustomer(true)}><Text>Choose a default customer</Text></Button>
              )}
              {defaultCustomer ? (
                <Button testID="default-customer-clear" variant="secondary" onPress={() => {
                  saveDefaultCustomer(session, null);
                  setDefaultCustomer(null);
                }}><Text>No default customer</Text></Button>
              ) : null}
            </VStack>
          </CardContent>
        </Card>
      ) : null}
      </>}
      {section === 'tax' && <TaxSettings settings={session.settings} />}
      {section === 'printing' ? (
        <Card className="w-full max-w-[420px]">
          <CardHeader><CardTitle aria-level={2}>Printing</CardTitle></CardHeader>
          <CardContent>
            <VStack space="lg">
              <PrinterSettings />
              <SettingsRow label="Show receipt after each sale" description="When off, a finished sale goes straight to a new one."
                action={<Switch testID="auto-show-receipt-toggle" accessibilityLabel="Show receipt after each sale" checked={autoShowReceipt}
                  onCheckedChange={(on) => { saveAutoShowReceipt(on); setAutoShowReceipt(on); }} />} />
              <SettingsRow label="Print after each sale" description="Open the print dialog when a sale's receipt shows."
                action={<Switch testID="auto-print-toggle" accessibilityLabel="Print after each sale" checked={autoPrint}
                  onCheckedChange={(on) => { saveAutoPrint(on); setAutoPrint(on); }} />} />
            </VStack>
          </CardContent>
        </Card>
      ) : null}
      {section === 'customer-display' && customerDisplay ? <CustomerDisplaySection handles={customerDisplay} storeUrl={session.url} /> : null}
      {section === 'theme' && <ThemeSettings />}
      {section === 'sync-log' && <SyncLogCard />}
      {/* The till's panel closes; the /settings route goes back (app/settings.tsx). */}
      <Button testID="settings-back" variant="secondary" onPress={onClose}>
        <Text>Back to the till</Text>
      </Button>
    </VStack>
    </ScrollView>
    } />
  );
}
