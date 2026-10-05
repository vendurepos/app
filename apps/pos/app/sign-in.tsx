import { useEffect, useRef, useState } from 'react';
import { Redirect, Stack } from 'expo-router';
import { vendureAuth } from '@tallyui/connector-vendure';
import type { AuthField } from '@tallyui/core';
import {
  Button, Card, CardContent, CardHeader, CardTitle, Input, InputField, Label, Text, VStack,
} from '@tallyui/components';
import { DEMO_CHANNEL_TOKEN, DEMO_CREDENTIALS, DEMO_STORE_ORIGIN } from '../lib/demo/fetch';
import { DEMO_MODE } from '../lib/demo/mode';
import { useSession } from '../lib/session-context';
import { signIn } from '../lib/sign-in';

// The app's own setting (MVP §1.2), not the connector's.
const BARCODE_FIELD: AuthField = {
  key: 'barcode_field', label: 'Barcode field (optional)', placeholder: 'barcode', type: 'text',
};

// The demo build signs in to its simulated store (lib/demo/install.ts) with no typing.
const DEMO_VALUES: Record<string, string | undefined> = {
  url: DEMO_STORE_ORIGIN, ...DEMO_CREDENTIALS, channel_token: DEMO_CHANNEL_TOKEN,
};

export default function SignInScreen() {
  const { session, setSignedIn } = useSession();
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);
  // Once, on the first render; a demo sign-in that fails shows its error and Try again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (DEMO_MODE && !session) void submit(DEMO_VALUES); }, []);

  async function submit(submitted: Record<string, string | undefined> = values) {
    if (pending) return;
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    setPending(true);
    try {
      const result = await signIn(submitted, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.ok) {
        setSignedIn(result.session);
      } else {
        setError(result.error);
      }
    } catch (error) {
      if ((error as { name?: unknown })?.name !== 'AbortError') throw error;
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  if (session) return <Redirect href="/" />;

  if (DEMO_MODE) return (
    <VStack className="flex-1 items-center justify-center bg-background p-6">
      <Stack.Screen options={{ title: 'Demo' }} />
      <Card className="w-full max-w-[420px]">
        <CardContent>
          <VStack space="lg">
            {error ? (
              <>
                <Text testID="sign-in-error" accessibilityRole="alert" className="text-destructive">{error}</Text>
                <Button testID="sign-in-submit" disabled={pending} onPress={() => void submit(DEMO_VALUES)}>
                  <Text>Try again</Text>
                </Button>
              </>
            ) : <Text>Starting the demo…</Text>}
          </VStack>
        </CardContent>
      </Card>
    </VStack>
  );

  return (
    <VStack className="flex-1 items-center justify-center bg-background p-6">
      <Stack.Screen options={{ title: 'Sign in' }} />
      <Card className="w-full max-w-[420px]">
        <CardHeader>
          <CardTitle>Sign in to Vendure</CardTitle>
        </CardHeader>
        <CardContent>
          <VStack space="lg">
            {[...vendureAuth.fields, BARCODE_FIELD].map((field) => (
              <VStack key={field.key} space="sm">
                <Label nativeID={`sign-in-${field.key}-label`}>{field.label}</Label>
                <Input>
                  <InputField
                    testID={`sign-in-${field.key}`}
                    accessibilityLabel={field.label}
                    accessibilityLabelledBy={`sign-in-${field.key}-label`}
                    placeholder={field.placeholder}
                    value={values[field.key] ?? ''}
                    onChangeText={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
                    secureTextEntry={field.type === 'password'}
                    keyboardType={field.type === 'url' ? 'url' : field.key === 'email' ? 'email-address' : 'default'}
                    autoComplete={field.key === 'email' ? 'email' : undefined}
                    autoCapitalize={['url', 'email', 'channel_token', 'barcode_field'].includes(field.key) ? 'none' : undefined}
                    autoCorrect={['url', 'email', 'channel_token', 'barcode_field'].includes(field.key) ? false : undefined}
                    onSubmitEditing={() => void submit()}
                  />
                </Input>
              </VStack>
            ))}
            {error && (
              <Text testID="sign-in-error" accessibilityRole="alert" className="text-destructive">
                {error}
              </Text>
            )}
            <Button testID="sign-in-submit" disabled={pending} onPress={() => void submit()}>
              <Text>{pending ? 'Signing in…' : 'Sign in'}</Text>
            </Button>
          </VStack>
        </CardContent>
      </Card>
    </VStack>
  );
}
