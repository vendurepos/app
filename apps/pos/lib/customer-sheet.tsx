import { useEffect, useRef, useState, type JSX } from 'react';
import { Pressable, ScrollView, TextInput } from 'react-native';
import { Button, CustomerForm, CustomerOrderHistory, Dialog, DialogContent, DialogHeader, DialogTitle, HStack, Text, VStack } from '@tallyui/components';
import type { AddressEditorValue, OrderHistoryRow } from '@tallyui/components';
import { formatMoney, type Customer } from '@tallyui/core';
import { addressEditorValue, addressPatch, CUSTOMER_ADDRESS_VENDURE_TEXT, CUSTOMER_OFFLINE_TEXT, customerFormValues, customerPatch, saveCustomer, useCustomerAddresses } from './customer-edit';
import { CUSTOMER_GROUPS_LABEL, CUSTOMER_GROUPS_HINT, customerGroupsText, type CustomerRow } from './customer-list';
import { CUSTOMER_ACCOUNT_LABEL, useCustomerAccount } from './customer-account';
import { useCustomerFields } from './customer-fields';
import { CUSTOMER_ADDRESS_REMOVE_UNSAVED_TEXT, removableAddresses, removeConfirmText, removeCustomerAddress, savedAddressName, savedAddressRole, useSavedAddresses } from './customer-address-remove';
import { addCustomerNote, useCustomerNotes } from './customer-notes';
import { useCustomerOrders } from './customer-orders';
import { STAFF_NOTE_LABEL } from './order-notes';
import { sessionContext, type Session } from './session';

function useOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return online;
}
export function CustomerSheet({ session, row, open, onClose, onSaved, onOpenOrder, canRemoveAddress = false, onAddressRemoved }: {
  session: Session; row: CustomerRow | null; open: boolean; onClose(): void; onSaved(customer: Customer): void;
  onOpenOrder?: (row: OrderHistoryRow) => void; canRemoveAddress?: boolean; onAddressRemoved?: () => void;
}): JSX.Element {
  const [values, setValues] = useState(() => customerFormValues(row));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const counter = useRef(0);
  const noteCounter = useRef(0); // Bumped when the sheet closes or reopens, so a late add answer lands nowhere.
  const online = useOnline();
  const groupsText = customerGroupsText(row);
  const { notes, reload } = useCustomerNotes(session, open && row ? row.id : null);
  const account = useCustomerAccount(session, open && row ? row.id : null);
  const fields = useCustomerFields(session, open && row ? row.id : null);
  const orders = useCustomerOrders(session, open && row ? row.id : null);
  const [addressVersion, setAddressVersion] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const removeCounter = useRef(0);
  const source = useCustomerAddresses(session, open, row?.id ?? null, addressVersion);
  const saved = useSavedAddresses(session, open && row && canRemoveAddress ? row.id : null, addressVersion);
  const removable = saved ? removableAddresses(saved) : [];
  const [addressValue, setAddressValue] = useState<AddressEditorValue>({});
  useEffect(() => { setAddressValue(source.stored ? addressEditorValue(source.stored) : {}); }, [source.stored]);
  const addressChange = source.stored ? addressPatch(source.stored, addressValue) : {};
  const changeAddresses = (next: AddressEditorValue) => {
    // TallyUI's billing-row Remove on the saved default billing address opens our confirm, as our own Remove does, instead of an edit Save refuses.
    const billing = removable.find(a => a.billing);
    if (canRemoveAddress && billing && next.billing === undefined && addressValue.billing !== undefined) { setConfirming(billing.id); setRemoveError(null); return; }
    setAddressValue(next); setError(null); setConfirming(null);
  };
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (open) { setValues(customerFormValues(row)); setError(null); setSaving(false); setNote(''); setNoteError(null); setAdding(false);
      setConfirming(null); setRemoving(false); setRemoveError(null); }
    return () => { counter.current += 1; noteCounter.current += 1; removeCounter.current += 1; };
  }, [open, row]);
  const addNote = async () => {
    if (!row) return;
    const request = ++noteCounter.current;
    setAdding(true);
    try {
      const result = await addCustomerNote(sessionContext(session), row.id, note);
      if (request !== noteCounter.current) return;
      if ('ok' in result) { setNote(''); reload(); } else setNoteError(result.error);
    } finally { if (request === noteCounter.current) setAdding(false); }
  };
  const remove = async () => {
    if (confirming === null) return;
    const request = ++removeCounter.current;
    setRemoving(true);
    try {
      const result = await removeCustomerAddress(sessionContext(session), confirming);
      if (request !== removeCounter.current) return;
      setConfirming(null);
      if ('ok' in result) { setAddressVersion(version => version + 1); onAddressRemoved?.(); } else setRemoveError(result.error);
    } finally { if (request === removeCounter.current) setRemoving(false); }
  };
  const close = () => { if (saving || removing) return; counter.current += 1; onClose(); };
  const name = row ? `${row.firstName} ${row.lastName}`.trim() || row.email : '';
  const addressUnsaved = Object.keys(addressChange).length > 0;
  const save = async () => {
    const request = ++counter.current;
    setSaving(true);
    try {
      const result = await saveCustomer(sessionContext(session), row, values, source.stored ? { stored: source.stored, edited: addressValue } : undefined);
      if (request !== counter.current) return;
      if ('customer' in result) onSaved(result.customer);
      else setError(result.error);
    } finally { if (request === counter.current) setSaving(false); }
  };
  return <Dialog open={open} onOpenChange={next => { if (!next) close(); }}>
    <DialogContent testID="customer-sheet" dataSet={{ print: 'hide' }}
      className="right-0 left-auto top-0 h-full max-w-md flex-col translate-x-0 translate-y-0 rounded-none border-0 border-l">
      <DialogHeader className="text-left">
        <DialogTitle>{row ? `Edit ${name}` : 'New customer'}</DialogTitle>
      </DialogHeader>
      {/* The body scrolls so the Save and Close footer stays on screen when the address editor makes the sheet taller than the window. */}
      <ScrollView testID="customer-sheet-body" className="flex-1" contentContainerClassName="gap-4">
      <CustomerForm values={values} onChangeField={(field, value) => { setValues(current => ({ ...current, [field]: value })); setError(null); }} showAddress={false}
        addresses={source.stored ? addressValue : undefined} onChangeAddresses={changeAddresses} countries={source.countries} />
      {source.inVendure && <Text testID="customer-sheet-address-vendure" className="px-4 text-sm text-muted-foreground">{CUSTOMER_ADDRESS_VENDURE_TEXT}</Text>}
      {row !== null && canRemoveAddress && removable.length > 0 && <VStack testID="customer-sheet-saved-addresses" className="gap-1 px-4">
        {removable.map(a => <VStack key={a.id} className="gap-1">
          <HStack testID={`customer-sheet-address-${a.id}`} className="items-center justify-between">
            <Text className="flex-1 text-sm">{`${savedAddressRole(a)}: ${savedAddressName(a)}`}</Text>
            <Button testID={`customer-sheet-address-remove-${a.id}`} variant="secondary" size="sm" accessibilityLabel={`Remove ${savedAddressName(a)}`}
              disabled={!online || saving || removing || confirming !== null || addressUnsaved} onPress={() => { setConfirming(a.id); setRemoveError(null); }}>
              <Text>Remove</Text>
            </Button>
          </HStack>
          {confirming === a.id && <VStack testID="customer-sheet-address-confirm" className="gap-2 rounded-md border border-border p-3">
            {removeConfirmText(a, saved ?? [], name).map(line => <Text key={line} className="text-sm">{line}</Text>)}
            <HStack space="sm">
              <Button testID="customer-sheet-address-confirm-remove" variant="destructive" size="sm" disabled={!online || removing || saving || addressUnsaved} onPress={remove}><Text>Remove address</Text></Button>
              <Button testID="customer-sheet-address-confirm-keep" variant="outline" size="sm" disabled={removing} onPress={() => setConfirming(null)}><Text>Keep</Text></Button>
            </HStack>
          </VStack>}
        </VStack>)}
        {addressUnsaved && <Text testID="customer-sheet-address-unsaved" className="text-xs text-muted-foreground">{CUSTOMER_ADDRESS_REMOVE_UNSAVED_TEXT}</Text>}
        {removeError && <Text testID="customer-sheet-address-error" accessibilityRole="alert" className="text-sm text-destructive">{removeError}</Text>}
      </VStack>}
      {groupsText !== null && <HStack testID="customer-sheet-groups" className="items-center justify-between px-4">
        <Text className="w-20 text-sm text-muted-foreground">{CUSTOMER_GROUPS_LABEL}</Text>
        <Text testID="customer-sheet-groups-value" className="flex-1 px-3 text-sm">{groupsText}</Text>
        <Text className="text-xs text-muted-foreground">{CUSTOMER_GROUPS_HINT}</Text>
      </HStack>}
      {row !== null && account !== null && <HStack testID="customer-sheet-account" className="items-center justify-between px-4">
        <Text className="w-20 text-sm text-muted-foreground">{CUSTOMER_ACCOUNT_LABEL}</Text>
        <Text testID="customer-sheet-account-value" className="flex-1 px-3 text-sm">{account}</Text>
        <Text className="text-xs text-muted-foreground">{CUSTOMER_GROUPS_HINT}</Text>
      </HStack>}
      {row !== null && fields !== null && fields.length > 0 && <VStack testID="customer-sheet-fields" className="gap-1">
        {fields.map(field => <HStack key={field.name} testID={`customer-sheet-field-${field.name}`} className="items-center justify-between px-4">
          <Text className="w-20 text-sm text-muted-foreground">{field.label}</Text>
          <Text testID={`customer-sheet-field-${field.name}-value`} className="flex-1 px-3 text-sm">{field.value}</Text>
          <Text className="text-xs text-muted-foreground">{CUSTOMER_GROUPS_HINT}</Text>
        </HStack>)}
      </VStack>}
      {row !== null && <VStack testID="customer-sheet-notes" className="gap-1 px-4">
        {notes.map(item => <Text key={item.id} testID={`customer-sheet-note-${item.id}`} className="text-sm">{`${STAFF_NOTE_LABEL}: ${item.text}`}</Text>)}
        <HStack space="sm" className="items-center">
          <TextInput testID="customer-sheet-note-input" accessibilityLabel="Staff note" placeholder="Add a staff note" value={note}
            onChangeText={text => { setNote(text); setNoteError(null); }} className="flex-1 rounded-md border border-input px-3 py-2 text-sm" />
          <Button testID="customer-sheet-note-add" variant="secondary" size="sm" disabled={adding || !online || !note.trim()} onPress={addNote}>
            <Text>Add note</Text>
          </Button>
        </HStack>
        {noteError && <Text testID="customer-sheet-note-error" accessibilityRole="alert" className="text-sm text-destructive">{noteError}</Text>}
      </VStack>}
      {row !== null && <CustomerOrderHistory testID="customer-sheet-orders" className="flex-none" orders={orders.orders ?? []}
        emptyState={orders.notice ? <Text testID="customer-sheet-orders-notice" className="px-3 text-sm text-muted-foreground">{orders.notice.text}</Text>
          : orders.orders && <Text testID="customer-sheet-orders-empty" className="px-3 text-sm text-muted-foreground">No orders yet</Text>}
        renderItem={(order: OrderHistoryRow) => <Pressable testID={`customer-sheet-order-${order.id}`} accessibilityRole="button"
          accessibilityLabel={`Order ${order.reference}`} onPress={() => onOpenOrder?.(order)}><HStack space="sm" className="items-center justify-between">
          {[order.reference, new Date(order.placedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }), order.stateLabel,
            formatMoney({ amount: order.totalMinor, currency: order.currency })].map((text, index) => <Text key={index} className="text-sm">{text}</Text>)}
        </HStack></Pressable>} />}
      {!online && <Text testID="customer-sheet-offline">{CUSTOMER_OFFLINE_TEXT}</Text>}
      </ScrollView>
      {error && <Text testID="customer-sheet-error" accessibilityRole="alert" className="text-sm text-destructive">{error}</Text>}
      <HStack space="sm" className="mt-auto justify-between">
        <Button testID="customer-sheet-save" disabled={saving || removing || !online || confirming !== null || (row !== null && Object.keys(customerPatch(row, values)).length + Object.keys(addressChange).length === 0)} onPress={save}>
          <Text>Save</Text>
        </Button>
        <Button testID="customer-sheet-close" variant="outline" disabled={saving || removing} onPress={close}><Text>Close</Text></Button>
      </HStack>
    </DialogContent>
  </Dialog>;
}
