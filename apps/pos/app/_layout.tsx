// First: the demo build's simulated store must answer before the session loads or anything fetches.
import '../lib/demo/install';
import { installLogSinks } from '../lib/logging';
import '../global.css';
import { PortalHost } from '@tallyui/primitives';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { DemoBanner } from '../lib/demo/demo-banner';
import { DEMO_MODE } from '../lib/demo/mode';
import { SessionProvider } from '../lib/session-context';

// The money-path loggers write nowhere until a sink is installed.
installLogSinks();

export default function RootLayout() {
  return (
    <SessionProvider>
      <StatusBar style="dark" />
      {DEMO_MODE ? <DemoBanner /> : null}
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
