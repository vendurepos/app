// First: the demo build's simulated store must answer before the session loads or anything fetches.
import '../lib/demo/install';
import { installLogSinks } from '../lib/logging';
import '../global.css';
import { ScaleProvider } from '@tallyui/components';
import { PortalHost } from '@tallyui/primitives';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { ScopedVariables } from 'uniwind';
import { DemoBanner } from '../lib/demo/demo-banner';
import { DEMO_MODE } from '../lib/demo/mode';
import { printInLightScheme } from '../lib/print-light';
import { useStoredScale } from '../lib/scale-setting';
import { SessionProvider } from '../lib/session-context';
import { useStackColors } from '../lib/theme-colors';
import { applyTheme, loadTheme } from '../lib/theme-setting';

// The money-path loggers write nowhere until a sink is installed.
installLogSinks();
// Apply this device's stored appearance before any screen renders.
const startTheme = loadTheme();
if (startTheme !== 'system') applyTheme(startTheme);

export default function RootLayout() {
  const scale = useStoredScale();
  const stackColors = useStackColors();
  useEffect(printInLightScheme, []);

  return (
    // The web uses TallyUI's root mirror.
    <ScaleProvider scale={scale} scope={Platform.OS === 'web' ? undefined : ScopedVariables}>
      <SessionProvider>
        <StatusBar style="auto" />
        {DEMO_MODE ? <DemoBanner /> : null}
        <Stack screenOptions={stackColors} />
        {/* The one root host, after navigation: the register's panel, sheets and dialogs draw above every screen. */}
        <PortalHost />
      </SessionProvider>
    </ScaleProvider>
  );
}
