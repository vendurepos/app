// First: the demo build's simulated store must answer before the session loads or anything fetches.
import '../lib/demo/install';
import { installLogSinks } from '../lib/logging';
import '../global.css';
import { PortalHost } from '@tallyui/primitives';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { DemoBanner } from '../lib/demo/demo-banner';
import { DEMO_MODE } from '../lib/demo/mode';
import { printInLightScheme } from '../lib/print-light';
import { SessionProvider } from '../lib/session-context';
import { useStackColors } from '../lib/theme-colors';

// The money-path loggers write nowhere until a sink is installed.
installLogSinks();

export default function RootLayout() {
  const stackColors = useStackColors();
  useEffect(printInLightScheme, []);

  return (
    <SessionProvider>
      <StatusBar style="auto" />
      {DEMO_MODE ? <DemoBanner /> : null}
      <Stack screenOptions={stackColors} />
      {/* The one root host, after navigation: the register's panel, sheets and dialogs draw above every screen. */}
      <PortalHost />
    </SessionProvider>
  );
}
