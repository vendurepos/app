import { useMemo, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { Redirect, router, Stack } from 'expo-router';
import {
  Button, Card, CardContent, CardHeader, CardTitle, CustomerPicker, Input, InputField, Label, Text, VStack,
} from '@tallyui/components';
import { loadAutoPrint, saveAutoPrint } from '../lib/auto-print-setting';
import { catalogueConnector } from '../lib/catalogue';
import { loadDefaultCustomer, saveDefaultCustomer } from '../lib/default-customer';
import { loadScannerMinLength, saveScannerMinLength } from '../lib/scanner-settings';
import { loadPriceEditAllowed, savePriceEditAllowed } from '../lib/price-edit-setting';
import { loadVarianceLimitMinor, parseVarianceLimit, saveVarianceLimitMinor } from '../lib/register-approval';
import { sessionContext, sessionKey } from '../lib/session';
import { useSession } from '../lib/session-context';

export default function SettingsScreen() {
  const { session } = useSession();
  const [text, setText] = useState(() => String(loadScannerMinLength()));
  const [saved, setSaved] = useState<boolean | null>(null);
  const [varianceText, setVarianceText] = useState(() => {
    const minor = loadVarianceLimitMinor();
    return minor === undefined ? '' : (minor / 100).toFixed(2);
  });
  const [varianceSaved, setVarianceSaved] = useState<boolean | null>(null);
  const [canEditPrice, setCanEditPrice] = useState(() => loadPriceEditAllowed());
  const [defaultCustomer, setDefaultCustomer] = useState(() => session ? loadDefaultCustomer(session) : null);
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const [autoPrint, setAutoPrint] = useState(() => loadAutoPrint());
  const connector = useMemo(() => session ? catalogueConnector(session) : null, [session ? sessionKey(session) : null]);

  if (!session) return <Redirect href="/sign-in" />;

  return (
    <>
    {/* The cards outgrow a short window; flexGrow keeps a short screen centred. */}
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ flexGrow: 1 }}>
    <VStack className="flex-1 items-center justify-center bg-background p-6" space="lg">
      <Stack.Screen options={{ title: 'Settings' }} />
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
            <Text>From 4 to 32 characters. A shorter fast burst is treated as typing.</Text>
            <Button testID="settings-save" onPress={() => setSaved(/^\d+$/.test(text) && saveScannerMinLength(Number(text)))}>
              <Text>Save</Text>
            </Button>
            {saved === true && <Text testID="settings-saved">Saved.</Text>}
            {saved === false && <Text testID="settings-error">Enter a whole number from 4 to 32.</Text>}
          </VStack>
        </CardContent>
      </Card>
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
      <Card className="w-full max-w-[420px]">
        <CardHeader><CardTitle aria-level={2}>Prices</CardTitle></CardHeader>
        <CardContent>
          <VStack space="lg">
            <Text>{"Let cashiers change a line's price in the cart."}</Text>
            <Button testID="price-edit-toggle" onPress={() => {
              savePriceEditAllowed(!canEditPrice);
              setCanEditPrice(!canEditPrice);
            }}><Text>Price changes: {canEditPrice ? 'On' : 'Off'}</Text></Button>
          </VStack>
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
      {Platform.OS === 'web' ? (
        <Card className="w-full max-w-[420px]">
          <CardHeader><CardTitle aria-level={2}>Printing</CardTitle></CardHeader>
          <CardContent>
            <VStack space="lg">
              <Text>{"Open the print dialog when a sale's receipt shows."}</Text>
              <Button testID="auto-print-toggle" onPress={() => {
                saveAutoPrint(!autoPrint);
                setAutoPrint(!autoPrint);
              }}><Text>Print after each sale: {autoPrint ? 'On' : 'Off'}</Text></Button>
            </VStack>
          </CardContent>
        </Card>
      ) : null}
      <Text testID="settings-barcode-field">Barcode custom field: {session.barcodeField ?? 'none'}. Set when signing in.</Text>
      {/* Back, never a push, because a second till can't open the order store the first one holds. */}
      <Button testID="settings-back" variant="secondary" onPress={() => router.canGoBack() ? router.back() : router.replace('/')}>
        <Text>Back to the till</Text>
      </Button>
    </VStack>
    </ScrollView>
    </>
  );
}
