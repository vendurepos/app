import { useState } from 'react';
import { Link, Redirect, Stack } from 'expo-router';
import { vendureAuth } from '@tallyui/connector-vendure';
import type { AuthField } from '@tallyui/core';
import {
  Button, Card, CardContent, CardHeader, CardTitle, Input, InputField, Label, Text, VStack,
} from '@tallyui/components';
import { DEMO_MODE } from '../lib/demo/mode';
import { useSession } from '../lib/session-context';
import { useSignIn } from '../lib/use-sign-in';

// The app's own setting (MVP §1.2), not the connector's.
const BARCODE_FIELD: AuthField = {
  key: 'barcode_field', label: 'Barcode field (optional)', placeholder: 'barcode', type: 'text',
};

export default function SignInScreen() {
  const { session } = useSession();
  const [values, setValues] = useState<Record<string, string>>({});
  const { pending, error, submit } = useSignIn();

  if (session) return <Redirect href="/" />;

  return (
    <VStack className="flex-1 items-center justify-center bg-background p-6">
      <Stack.Screen options={{ title: 'Sign in' }} />
      <Card className="w-full max-w-[420px]">
        <CardHeader>
          <CardTitle aria-level={2}>Sign in to Vendure</CardTitle>
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
                    onSubmitEditing={() => void submit(values)}
                  />
                </Input>
              </VStack>
            ))}
            {error && (
              <Text testID="sign-in-error" accessibilityRole="alert" className="text-destructive">
                {error}
              </Text>
            )}
            <Button testID="sign-in-submit" disabled={pending} onPress={() => void submit(values)}>
              <Text>{pending ? 'Signing in…' : 'Sign in'}</Text>
            </Button>
            {DEMO_MODE && (
              <Link href="/demo" testID="sign-in-try-demo"><Text className="text-sm text-primary">Try the demo</Text></Link>
            )}
          </VStack>
        </CardContent>
      </Card>
    </VStack>
  );
}
