import { Link, Redirect, Stack } from 'expo-router';
import Head from 'expo-router/head';
import { Button, Card, CardContent, CardHeader, CardTitle, HStack, Text, VStack } from '@tallyui/components';
import { DEMO_CHANNEL_TOKEN, DEMO_CREDENTIALS, DEMO_STORE_NAME, DEMO_STORE_ORIGIN } from '../lib/demo/fetch';
import { DEMO_MODE } from '../lib/demo/mode';
import { useSession } from '../lib/session-context';
import { useSignIn } from '../lib/use-sign-in';

export default function DemoScreen() {
  const { session } = useSession();
  const { pending, error, submit } = useSignIn();
  if (!DEMO_MODE) return <Redirect href="/sign-in" />;
  if (session) return <Redirect href="/" />;

  return (
    <VStack className="flex-1 items-center justify-center bg-background p-6">
      <Stack.Screen options={{ title: 'Demo' }} />
      <Head><title>VendurePOS demo: try the point of sale for Vendure</title></Head>
      <Card className="w-full max-w-[420px]">
        <CardHeader>
          <CardTitle accessibilityRole="header" aria-level={2}>{DEMO_STORE_NAME}</CardTitle>
        </CardHeader>
        <CardContent>
          <VStack space="lg">
            <Text>A public demo store. Everything stays in this browser, and Reset demo starts it over.</Text>
            <VStack testID="demo-try" space="sm">
              <Text className="font-semibold">What to try</Text>
              <Text className="text-sm">• Sell the mug for cash, then find the order under Orders.</Text>
              <Text className="text-sm">• Change a line's price from the cart.</Text>
              <Text className="text-sm">• Park a sale, sell another, then resume the parked one.</Text>
              <Text className="text-sm">• Add a customer to a sale; they print on the receipt.</Text>
              <Text className="text-sm">• Open the Register, count the drawer and close the day.</Text>
            </VStack>
            {error && (
              <Text testID="demo-error" accessibilityRole="alert" className="text-destructive">{error}</Text>
            )}
            <Button testID="demo-enter" disabled={pending} onPress={() => void submit({
              url: DEMO_STORE_ORIGIN, ...DEMO_CREDENTIALS, channel_token: DEMO_CHANNEL_TOKEN,
            })}>
              <Text>{pending ? 'Entering…' : 'Enter the demo'}</Text>
            </Button>
            <VStack testID="demo-credentials" space="sm">
              <Text selectable className="text-sm text-muted-foreground">Store URL {DEMO_STORE_ORIGIN}</Text>
              <Text selectable className="text-sm text-muted-foreground">Email {DEMO_CREDENTIALS.email}</Text>
              <Text selectable className="text-sm text-muted-foreground">Password {DEMO_CREDENTIALS.password}</Text>
            </VStack>
            <HStack space="md">
              <Link href="https://vendurepos.com" target="_blank" rel="noopener" testID="demo-link-site" className="text-sm text-primary">VendurePOS</Link>
              <Link href="https://github.com/vendurepos/app/blob/main/docs/QUICKSTART.md" target="_blank" rel="noopener" testID="demo-link-quickstart" className="text-sm text-primary">Quick start for your store</Link>
            </HStack>
          </VStack>
        </CardContent>
      </Card>
    </VStack>
  );
}
