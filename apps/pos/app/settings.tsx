import { useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { Redirect, router, Stack } from 'expo-router';
import {
  Button, Card, CardContent, CardHeader, CardTitle, CustomerPicker, Input, InputField, Label, SettingsLayout, SettingsRow, Switch, Text, ToggleGroup, ToggleGroupItem, VStack,
} from '@tallyui/components';
import { loadAutoPrint, saveAutoPrint } from '../lib/auto-print-setting';
import { loadDefaultCustomer, saveDefaultCustomer } from '../lib/default-customer';
import { loadOpenOrdersPosition, saveOpenOrdersPosition } from '../lib/open-orders-position-setting';
import { loadScannerMinLength, saveScannerMinLength, SCANNER_MIN_LENGTH_RANGE } from '../lib/scanner-settings';
import { ScannerExtraSettings } from '../lib/scanner-extra-settings';
import { loadPriceEditAllowed, savePriceEditAllowed } from '../lib/price-edit-setting';
import { formatQuickDiscounts, loadQuickDiscounts, parseQuickDiscounts, saveQuickDiscounts } from '../lib/quick-discounts-setting';
import { formatVarianceLimit, loadVarianceLimitMinor, parseVarianceLimit, saveVarianceLimitMinor } from '../lib/register-approval';
import { sessionContext } from '../lib/session';
import { useSession } from '../lib/session-context';
import { settingsSections, type SettingsSectionId } from '../lib/settings-sections';
import { SyncLogCard } from '../lib/sync-log-card';
import { TaxSettings } from '../lib/tax-settings-card';
import { ThemeSettings } from '../lib/theme-settings';
import { TileSizeSettings } from '../lib/tile-size-settings';
import { useCatalogueConnector } from '../lib/use-catalogue';

export default function SettingsScreen() {
  const { session } = useSession();
  const [text, setText] = useState(() => String(loadScannerMinLength()));
  const [saved, setSaved] = useState<boolean | null>(null);
  const [varianceText, setVarianceText] = useState(() => formatVarianceLimit(loadVarianceLimitMinor()));
  const [varianceSaved, setVarianceSaved] = useState<boolean | null>(null);
  const [quickText, setQuickText] = useState(() => formatQuickDiscounts(loadQuickDiscounts()));
  const [quickSaved, setQuickSaved] = useState<boolean | null>(null);
  const [canEditPrice, setCanEditPrice] = useState(() => loadPriceEditAllowed());
  const [defaultCustomer, setDefaultCustomer] = useState(() => session ? loadDefaultCustomer(session) : null);
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const [autoPrint, setAutoPrint] = useState(() => loadAutoPrint());
  const [openOrdersPosition, setOpenOrdersPosition] = useState(() => loadOpenOrdersPosition());
  const connector = useCatalogueConnector(session);
  const [section, setSection] = useState<SettingsSectionId>('general');
  const sections = settingsSections({ printing: Platform.OS === 'web' });

  if (!session) return <Redirect href="/sign-in" />;

  return (
    <>
    <Stack.Screen options={{ title: 'Settings' }} />
    <SettingsLayout navSlot={
      <View className="gap-1 p-2">
        {sections.map(({ id, label }) => {
          const selected = section === id;
          return (
            <Pressable key={id} testID={`settings-section-${id}`} accessibilityRole="tab"
              aria-selected={selected} className={`rounded-md px-3 py-2${selected ? ' bg-muted' : ''}`}
              onPress={() => setSection(id)}>
              <Text className={`text-sm text-foreground${selected ? ' font-medium' : ''}`}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    } contentSlot={
    <ScrollView className="flex-1 bg-background"
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
          </VStack>
        </CardContent>
      </Card>
      )}
      {section === 'general' && <>
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
      <TileSizeSettings />
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
            <SettingsRow label="Print after each sale" description="Open the print dialog when a sale's receipt shows."
              action={<Switch testID="auto-print-toggle" accessibilityLabel="Print after each sale" checked={autoPrint}
                onCheckedChange={(on) => { saveAutoPrint(on); setAutoPrint(on); }} />} />
          </CardContent>
        </Card>
      ) : null}
      {section === 'theme' && <ThemeSettings />}
      {section === 'sync-log' && <SyncLogCard />}
      {/* Back, never a push, because a second till can't open the order store the first one holds. */}
      <Button testID="settings-back" variant="secondary" onPress={() => router.canGoBack() ? router.back() : router.replace('/')}>
        <Text>Back to the till</Text>
      </Button>
    </VStack>
    </ScrollView>
    } />
    </>
  );
}
