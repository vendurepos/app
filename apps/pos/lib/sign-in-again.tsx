import { useState } from 'react';
import { Button, Input, InputField, Text, VStack } from '@tallyui/components';
import type { Session } from './session';
import { useSession } from './session-context';
import { signIn } from './sign-in';

export function SignInAgain({ session, onSignedIn }: { session: Session; onSignedIn(session: Session): void }) {
  const { setSignedIn } = useSession();
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    const result = await signIn({
      url: session.url, email: session.email, password,
      channel_token: session.channelToken, barcode_field: session.barcodeField,
    });
    setPending(false);
    if (result.ok) {
      setSignedIn(result.session);
      onSignedIn(result.session);
    } else {
      setError(result.error);
    }
  }

  return (
    <VStack space="sm">
      <Text>Your session on the store ended. Enter your password to keep selling; the cart stays.</Text>
      <Input>
        <InputField testID="sign-in-again-password" accessibilityLabel="Password" secureTextEntry
          value={password} onChangeText={setPassword} />
      </Input>
      {error ? <Text testID="sign-in-again-error" accessibilityRole="alert" className="text-destructive">{error}</Text> : null}
      <Button testID="sign-in-again-submit" disabled={pending || !password} onPress={() => void submit()}>
        <Text>Sign in again</Text>
      </Button>
    </VStack>
  );
}
