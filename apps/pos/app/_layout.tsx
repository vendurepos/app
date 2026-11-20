// First: the demo build's simulated store must answer before the session loads or anything fetches.
import '../lib/demo/install';
import { installLogSinks } from '../lib/logging';
import '../global.css';
import { FontProvider, ScaleProvider } from '@tallyui/components';
import { PortalHost } from '@tallyui/primitives';
import { ScanHubProvider } from '@tallyui/pos';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { ScopedVariables, useUniwind } from 'uniwind';
import { loadAppFonts } from '../lib/app-fonts';
import { useStoredFont } from '../lib/font-setting';
import { printInLightScheme } from '../lib/print-light';
import { useStoredScale } from '../lib/scale-setting';
import { SessionProvider } from '../lib/session-context';
import { statusBarStyle } from '../lib/status-bar-style';
import { useStackColors } from '../lib/theme-colors';
import { applyTheme, loadTheme } from '../lib/theme-setting';
import { liveScannerSettings, reportScannerError } from '../lib/device-scanner';
import { scannerProfileStore } from '../lib/scanner-profiles';

const scannerProfiles = scannerProfileStore();
const scannerSettings = liveScannerSettings();

// The money-path loggers write nowhere until a sink is installed.
installLogSinks();
// Apply this device's stored appearance before any screen renders.
const startTheme = loadTheme();
if (startTheme !== 'system') applyTheme(startTheme);

export default function RootLayout() {
  const font = useStoredFont();
  const scale = useStoredScale();
  const stackColors = useStackColors();
  const { theme } = useUniwind();
  useEffect(printInLightScheme, []);

  return (
    // The web uses TallyUI's root mirror.
    <ScaleProvider scale={scale} scope={Platform.OS === 'web' ? undefined : ScopedVariables}>
      <FontProvider font={font} loadFonts={loadAppFonts}>
        <SessionProvider>
          <ScanHubProvider profiles={scannerProfiles} settings={scannerSettings} onError={reportScannerError}>
            <StatusBar style={statusBarStyle(theme)} />
            <Stack screenOptions={stackColors} />
            {/* The one root host, after navigation: the register's panel, sheets and dialogs draw above every screen. */}
            <PortalHost />
          </ScanHubProvider>
        </SessionProvider>
      </FontProvider>
    </ScaleProvider>
  );
}
