import { useEffect, useRef, useState } from 'react';
import { Redirect, Stack } from 'expo-router';
import { vendureAuth } from '@tallyui/connector-vendure';
import {
  Button, Card, CardContent, CardHeader, CardTitle, Input, InputField, Label, Text, VStack,
} from '@tallyui/components';
import { useSession } from '../lib/session-context';
import { signIn } from '../lib/sign-in';

export default function SignInScreen() {
  const { session, setSignedIn } = useSession();
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  async function submit() {
    if (pending) return;
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    setPending(true);
    try {
      const result = await signIn(values, { signal: controller.signal });
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

  return (
    <VStack className="flex-1 items-center justify-center bg-background p-6">
      <Stack.Screen options={{ title: 'Sign in' }} />
      <Card className="w-full max-w-[420px]">
        <CardHeader>
          <CardTitle>Sign in to Vendure</CardTitle>
        </CardHeader>
        <CardContent>
          <VStack space="lg">
            {vendureAuth.fields.map((field) => (
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
                    autoCapitalize={['url', 'email', 'channel_token'].includes(field.key) ? 'none' : undefined}
                    autoCorrect={['url', 'email', 'channel_token'].includes(field.key) ? false : undefined}
                    onSubmitEditing={submit}
                  />
                </Input>
              </VStack>
            ))}
            {error && (
              <Text testID="sign-in-error" accessibilityRole="alert" className="text-destructive">
                {error}
              </Text>
            )}
            <Button testID="sign-in-submit" disabled={pending} onPress={submit}>
              <Text>{pending ? 'Signing in…' : 'Sign in'}</Text>
            </Button>
          </VStack>
        </CardContent>
      </Card>
    </VStack>
  );
}
