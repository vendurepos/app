import { Redirect, Stack } from 'expo-router';
import { Button, Text, VStack } from '@tallyui/components';
import { useSession } from '../lib/session-context';

export default function HomeScreen() {
  const { session, signOut } = useSession();
  if (!session) return <Redirect href="/sign-in" />;

  return (
    <VStack className="flex-1 items-center justify-center bg-background p-6" space="lg">
      <Stack.Screen options={{ title: 'VendurePOS' }} />
      <Text className="text-3xl font-bold">VendurePOS</Text>
      <Text testID="signed-in-store">Signed in to {session.url}</Text>
      <Text className="text-muted-foreground">{session.email}</Text>
      {session.channelToken && <Text>Channel: {session.channelToken}</Text>}
      <Button testID="sign-out" variant="secondary" onPress={signOut}>
        <Text>Sign out</Text>
      </Button>
    </VStack>
  );
}
