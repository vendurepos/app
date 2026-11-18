import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { vendureAuth } from '@tallyui/connector-vendure';
import {
  Button, Card, CardContent, CardHeader, CardTitle, CustomerDisplayPairing, CustomerDisplayScreen, Input, InputField, Label,
  Text, VStack,
} from '@tallyui/components';
import { createDisplayClient, useDisplayClient, type DisplayClient } from '@tallyui/pos';
import { customerDisplayLogger } from './customer-display';
import { createDisplaySignalling } from './display-signalling';
import { DISPLAY_ADVERTISEMENT, displayTokenStore, forgetDisplayStore, loadDisplayStore, submitDisplayStore } from './display-store';
import { defaultStore } from './session';

// The sign-in screen's own store field (connector-vendure), so the display asks for the store in the same words.
const URL_FIELD = vendureAuth.fieldSets.password.find((field) => field.key === 'url')!;

/** The store field: `?store=` only prefills it, and Continue validates it as sign-in does. */
function StoreForm({ onSaved }: { onSaved(url: string): void }) {
  const { store } = useLocalSearchParams();
  const [value, setValue] = useState(typeof store === 'string' ? store : '');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const result = submitDisplayStore(value, defaultStore());
    if (result.ok) onSaved(result.url);
    else setError(result.error);
  };
  return (
    <VStack className="flex-1 items-center justify-center bg-background p-6">
      <Card className="w-full max-w-[420px]">
        <CardHeader>
          <CardTitle aria-level={2}>Customer display</CardTitle>
        </CardHeader>
        <CardContent>
          <VStack space="lg">
            <VStack space="sm">
              <Label nativeID="display-store-url-label">{URL_FIELD.label}</Label>
              <Input>
                <InputField
                  testID="display-store-url" accessibilityLabel={URL_FIELD.label} accessibilityLabelledBy="display-store-url-label"
                  placeholder={URL_FIELD.placeholder} value={value} onChangeText={setValue} keyboardType="url"
                  autoCapitalize="none" autoCorrect={false} onSubmitEditing={submit}
                />
              </Input>
            </VStack>
            {error && <Text testID="display-store-error" accessibilityRole="alert" className="text-destructive">{error}</Text>}
            <Button testID="display-store-continue" onPress={submit}><Text>Continue</Text></Button>
          </VStack>
        </CardContent>
      </Card>
    </VStack>
  );
}

/** The display client for one store; a new store closes the old client and starts a new one. */
function useStoreDisplayClient(storeUrl: string): DisplayClient | null {
  const [client, setClient] = useState<DisplayClient | null>(null);
  useEffect(() => {
    const created = createDisplayClient({
      signalling: createDisplaySignalling(),
      context: { baseUrl: storeUrl },
      tokens: displayTokenStore(defaultStore()),
      advertisement: DISPLAY_ADVERTISEMENT,
      onError: (error) => customerDisplayLogger.warn('A customer display call failed', { error }),
    });
    setClient(created);
    return () => {
      created.close();
      setClient(null);
    };
  }, [storeUrl]);
  return client;
}

/** Pairing until the till confirms, then only what the till sends; a forgotten display is back at pairing. */
function StoreDisplay({ storeUrl, onChangeStore }: { storeUrl: string; onChangeStore(): void }) {
  const client = useStoreDisplayClient(storeUrl);
  const { phase, state } = useDisplayClient(client);
  if (phase.phase === 'paired') return <CustomerDisplayScreen state={state} />;
  return (
    <View className="flex-1 bg-background">
      <CustomerDisplayPairing
        client={{ phase, state }} onClaim={(code, name) => void client?.claim(code, name)} onCancel={() => client?.cancel()}
      />
      {phase.phase === 'enter-code' && (
        <Button testID="display-change-store" variant="link" className="mb-6 self-center" onPress={onChangeStore}>
          <Text>Change store</Text>
        </Button>
      )}
    </View>
  );
}

/** The customer display (P9.8c-2b): no session, only the store it pairs with and the display's own token. */
export function DisplayPage() {
  const [storeUrl, setStoreUrl] = useState(() => loadDisplayStore(defaultStore()));
  const changeStore = () => { forgetDisplayStore(defaultStore()); setStoreUrl(null); };
  if (storeUrl === null) return <StoreForm onSaved={setStoreUrl} />;
  return <StoreDisplay storeUrl={storeUrl} onChangeStore={changeStore} />;
}
