import { Platform, View } from 'react-native';
import { Button, SettingsRow, Text } from '@tallyui/components';
import { useDeviceScanControls } from '@tallyui/pos';
import { clearScannerError, useScannerError } from './device-scanner';
import { forgetScannerProfiles } from './scanner-profiles';

export function DirectScannerSettings() {
  const { hid, serial } = useDeviceScanControls();
  const message = useScannerError();
  return <>
    <Text testID="direct-scanner" className="font-semibold">Direct connection</Text>
    <Text>Most scanners need no setup: they type into the POS like a keyboard. Connect one directly only if it is set to USB HID-POS or USB serial mode.</Text>
    {([
      { id: 'hid', label: 'USB HID-POS scanner', type: 'hid-pos', control: hid },
      { id: 'serial', label: 'USB serial scanner', type: 'usb-serial', control: serial },
    ] as const).map(({ id, label, type, control }) => control.available && <SettingsRow key={id} label={label}
      action={<View className="flex-row items-center gap-3">
        <Text className="text-sm text-muted-foreground" testID={`direct-scanner-${id}-status`}>{control.connected ? 'Connected' : 'Not connected'}</Text>
        {control.connected
          ? <Button testID={`direct-scanner-${id}-disconnect`} onPress={async () => {
            await control.disconnect(); forgetScannerProfiles([type]);
          }}><Text>Disconnect</Text></Button>
          : <Button testID={`direct-scanner-${id}-connect`} onPress={() => {
            clearScannerError(); void control.connect();
          }}><Text>Connect</Text></Button>}
      </View>} />)}
    {!hid.available && !serial.available && <Text testID="direct-scanner-unsupported">{Platform.OS === 'web'
      ? "This browser can't connect a scanner directly. Pair the scanner as a keyboard instead, or use Chrome or Edge on a computer."
      : 'Direct connection works in Chrome or Edge on a computer. Pair the scanner as a keyboard (Bluetooth or USB) instead.'}</Text>}
    {message !== null && <Text testID="direct-scanner-error">{`Couldn't connect the scanner: ${message}`}</Text>}
  </>;
}
