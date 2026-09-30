import '../global.css';
import { PortalHost } from '@tallyui/primitives';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SessionProvider } from '../lib/session-context';

export default function RootLayout() {
  return (
    <SessionProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#fff' },
          headerTitleStyle: { fontWeight: '600' },
        }}
      />
      {/* The one root host, after navigation: the register's panel, sheets and dialogs draw above every screen. */}
      <PortalHost />
    </SessionProvider>
  );
}
