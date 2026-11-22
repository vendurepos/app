import { useRef, useState, type JSX } from 'react';
import { Platform } from 'react-native';
import { Button, HStack, Input, InputField, Label, Text, ToggleGroup, ToggleGroupItem, VStack } from '@tallyui/components';
import { mintUuid, networkSinkFor, PAPER_COLUMNS, type PrinterProfile, type ReceiptPaper } from '@tallyui/pos';
import {
  DEFAULT_PRINTER_PORT, loadPrinterProfiles, PRINTER_CONNECTIONS, PRINTER_VENDORS, printerPaper, printerSummary,
  removePrinterProfile, savePrinterProfile, type SavedPrinterConnection, type SavedPrinterVendor,
} from './printer-profiles';
import { printedOn, printTestTo } from './receipt-printer';

/** Settings › Printing: the printers set up on this device (TallyUI's PrinterProfile, kept in the device store), with a Test print for an Epson or Star network printer. */
export function PrinterSettings(): JSX.Element {
  const [printers, setPrinters] = useState(() => loadPrinterProfiles());
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PrinterProfile | null>(null);
  const [name, setName] = useState('');
  const [connection, setConnection] = useState<SavedPrinterConnection>('network');
  const [vendor, setVendor] = useState<SavedPrinterVendor>('epson');
  // Each printer's Test print: busy while it runs, then its status line.
  const [tests, setTests] = useState<Record<string, { busy: boolean; text?: string }>>({});
  const testing = useRef(new Set<string>());
  const [address, setAddress] = useState('');
  const [port, setPort] = useState(String(DEFAULT_PRINTER_PORT));
  const [paper, setPaper] = useState<ReceiptPaper>('80mm');
  function openForm(profile?: PrinterProfile) {
    setEditing(profile ?? null);
    setName(profile?.name ?? '');
    setConnection((profile?.connectionType as SavedPrinterConnection) ?? 'network');
    setVendor(profile ? profile.vendor ?? 'generic' : 'epson');
    setAddress(profile?.address ?? '');
    setPort(String(profile?.port ?? DEFAULT_PRINTER_PORT));
    setPaper(profile ? printerPaper(profile) : '80mm');
    setFormOpen(true);
  }
  async function testPrint(profile: PrinterProfile) {
    // `busy` disables the button only from the next render: a double tap lands before it.
    if (testing.current.has(profile.id)) return;
    testing.current.add(profile.id);
    setTests((all) => ({ ...all, [profile.id]: { busy: true } }));
    const failure = await printTestTo(profile);
    testing.current.delete(profile.id);
    setTests((all) => ({ ...all, [profile.id]: { busy: false, text: failure ?? printedOn(profile.name) } }));
  }
  function save() {
    const portNumber = Number(port);
    const id = editing?.id ?? mintUuid();
    savePrinterProfile({
      ...editing,
      id,
      name: name.trim(),
      connectionType: connection,
      vendor: connection === 'network' ? vendor : undefined,
      address: address.trim() || undefined,
      port: connection === 'network'
        ? (Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535 ? portNumber : DEFAULT_PRINTER_PORT) : undefined,
      columns: PAPER_COLUMNS[paper],
    });
    setPrinters(loadPrinterProfiles());
    // A test page's line is about the printer as it was; an edit clears it.
    setTests(({ [id]: _, ...rest }) => rest);
    setFormOpen(false);
  }
  return <>
    <Label>Printers</Label>
    <Text>Printers set up on this device.</Text>
    {printers.length === 0 && <Text testID="printers-empty">No printers set up. Receipts print through the print dialog.</Text>}
    {printers.map((profile) => <VStack key={profile.id} testID="printer-row" space="sm">
      <Text testID="printer-name-text">{profile.name}</Text>
      <Text testID="printer-summary">{printerSummary(profile)}</Text>
      <HStack space="sm">
        <Button testID="printer-edit" variant="outline" onPress={() => openForm(profile)}><Text>Edit</Text></Button>
        <Button testID="printer-remove" variant="outline" onPress={() => {
          removePrinterProfile(profile.id);
          setPrinters(loadPrinterProfiles());
        }}><Text>Remove</Text></Button>
        {/* Native has no print path yet, as with the receipts' Print button. */}
        {Platform.OS === 'web' && networkSinkFor(profile) !== null &&
          <Button testID="printer-test" variant="outline" disabled={tests[profile.id]?.busy === true}
            onPress={() => void testPrint(profile)}><Text>Test print</Text></Button>}
      </HStack>
      {tests[profile.id]?.text !== undefined && <Text testID="printer-test-status">{tests[profile.id].text}</Text>}
    </VStack>)}
    {!formOpen ? <Button testID="printer-add" onPress={() => openForm()}><Text>Add printer</Text></Button> :
      <VStack testID="printer-form" space="sm">
        <Label nativeID="printer-name-label">Name</Label>
        <Input><InputField testID="printer-name" accessibilityLabelledBy="printer-name-label"
          maxLength={40} value={name} onChangeText={setName} /></Input>
        <Text>Connection</Text>
        <ToggleGroup testID="printer-connection" type="single" accessibilityLabel="Connection" value={connection}
          onValueChange={(value) => { if (value !== '') setConnection(value as SavedPrinterConnection); }}>
          {PRINTER_CONNECTIONS.map((item) => <ToggleGroupItem key={item.value} value={item.value}
            testID={`printer-connection-${item.value}`} accessibilityLabel={item.label}
            className={connection === item.value ? 'bg-secondary' : undefined}><Text>{item.label}</Text></ToggleGroupItem>)}
        </ToggleGroup>
        {connection === 'network' && <>
          <Text>Printer make</Text>
          <ToggleGroup testID="printer-vendor" type="single" accessibilityLabel="Printer make" value={vendor}
            onValueChange={(value) => { if (value !== '') setVendor(value as SavedPrinterVendor); }}>
            {PRINTER_VENDORS.map((item) => <ToggleGroupItem key={item.value} value={item.value}
              testID={`printer-vendor-${item.value}`} accessibilityLabel={item.label}
              className={vendor === item.value ? 'bg-secondary' : undefined}><Text>{item.label}</Text></ToggleGroupItem>)}
          </ToggleGroup>
        </>}
        <Label nativeID="printer-address-label">{connection === 'network' ? 'IP address' : connection === 'bluetooth' ? 'Bluetooth address' : 'USB path'}</Label>
        <Input><InputField testID="printer-address" accessibilityLabelledBy="printer-address-label"
          autoCapitalize="none" autoCorrect={false} value={address} onChangeText={setAddress} /></Input>
        {connection === 'network' && <>
          <Label nativeID="printer-port-label">Port</Label>
          <Input><InputField testID="printer-port" accessibilityLabelledBy="printer-port-label"
            keyboardType="number-pad" value={port} onChangeText={setPort} /></Input>
        </>}
        <Text>Paper width</Text>
        <ToggleGroup testID="printer-paper" type="single" accessibilityLabel="Paper width" value={paper}
          onValueChange={(value) => { if (value !== '') setPaper(value as ReceiptPaper); }}>
          {(['58mm', '80mm'] as const).map((item) => <ToggleGroupItem key={item} value={item}
            testID={`printer-paper-${item}`} accessibilityLabel={item === '58mm' ? '58 mm' : '80 mm'}
            className={paper === item ? 'bg-secondary' : undefined}><Text>{item === '58mm' ? '58 mm' : '80 mm'}</Text></ToggleGroupItem>)}
        </ToggleGroup>
        <Button testID="printer-save" disabled={name.trim() === ''} onPress={save}><Text>Save</Text></Button>
        <Button testID="printer-cancel" variant="outline" onPress={() => setFormOpen(false)}><Text>Cancel</Text></Button>
        {connection === 'network' && vendor === 'generic' && <Text testID="printer-vendor-help">
          Receipts go to Epson and Star network printers directly. Other printers print through the print dialog.</Text>}
      </VStack>}
    <Text>Receipts print on the first Epson or Star network printer in this list. Without one, they print through the print dialog.</Text>
  </>;
}
