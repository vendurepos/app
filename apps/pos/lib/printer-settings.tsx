import { useState, type JSX } from 'react';
import { Button, HStack, Input, InputField, Label, Text, ToggleGroup, ToggleGroupItem, VStack } from '@tallyui/components';
import { mintUuid, PAPER_COLUMNS, type PrinterProfile, type ReceiptPaper } from '@tallyui/pos';
import {
  DEFAULT_PRINTER_PORT, loadPrinterProfiles, PRINTER_CONNECTIONS, printerPaper, printerSummary,
  removePrinterProfile, savePrinterProfile, type SavedPrinterConnection,
} from './printer-profiles';

export function PrinterSettings(): JSX.Element {
  const [printers, setPrinters] = useState(() => loadPrinterProfiles());
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PrinterProfile | null>(null);
  const [name, setName] = useState('');
  const [connection, setConnection] = useState<SavedPrinterConnection>('network');
  const [address, setAddress] = useState('');
  const [port, setPort] = useState(String(DEFAULT_PRINTER_PORT));
  const [paper, setPaper] = useState<ReceiptPaper>('80mm');
  function openForm(profile?: PrinterProfile) {
    setEditing(profile ?? null);
    setName(profile?.name ?? '');
    setConnection((profile?.connectionType as SavedPrinterConnection) ?? 'network');
    setAddress(profile?.address ?? '');
    setPort(String(profile?.port ?? DEFAULT_PRINTER_PORT));
    setPaper(profile ? printerPaper(profile) : '80mm');
    setFormOpen(true);
  }
  function save() {
    const portNumber = Number(port);
    savePrinterProfile({
      ...editing,
      id: editing?.id ?? mintUuid(),
      name: name.trim(),
      connectionType: connection,
      address: address.trim() || undefined,
      port: connection === 'network'
        ? (Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535 ? portNumber : DEFAULT_PRINTER_PORT) : undefined,
      columns: PAPER_COLUMNS[paper],
    });
    setPrinters(loadPrinterProfiles());
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
      </HStack>
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
      </VStack>}
    <Text>Receipts still print through the print dialog. Sending a receipt straight to a printer comes later.</Text>
  </>;
}
