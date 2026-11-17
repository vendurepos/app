import { Redirect, router, Stack } from 'expo-router';
import { SettingsPanel } from '../components/settings-panel';
import { useSession } from '../lib/session-context';

/** /settings as a deep link; the till opens the same panel beside its rail (app/index.tsx). */
export default function SettingsScreen() {
  const { session } = useSession();
  if (!session) return <Redirect href="/sign-in" />;
  return (
    <>
      <Stack.Screen options={{ title: 'Settings' }} />
      {/* Back, never a push, because a second till can't open the order store the first one holds. */}
      <SettingsPanel session={session} onClose={() => router.canGoBack() ? router.back() : router.replace('/')} />
    </>
  );
}
