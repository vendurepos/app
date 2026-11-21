import { useEffect, useRef, useState, type JSX } from 'react';
import { TextInput } from 'react-native';
import { Button, CustomerForm, Dialog, DialogContent, DialogHeader, DialogTitle, HStack, Text, VStack } from '@tallyui/components';
import type { Customer } from '@tallyui/core';
import { CUSTOMER_OFFLINE_TEXT, customerFormValues, customerPatch, saveCustomer } from './customer-edit';
import { CUSTOMER_GROUPS_LABEL, CUSTOMER_GROUPS_HINT, customerGroupsText, type CustomerRow } from './customer-list';
import { CUSTOMER_ACCOUNT_LABEL, useCustomerAccount } from './customer-account';
import { addCustomerNote, useCustomerNotes } from './customer-notes';
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
export function CustomerSheet({ session, row, open, onClose, onSaved }: {
  session: Session; row: CustomerRow | null; open: boolean; onClose(): void; onSaved(customer: Customer): void;
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
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (open) { setValues(customerFormValues(row)); setError(null); setSaving(false); setNote(''); setNoteError(null); setAdding(false); }
    return () => { counter.current += 1; noteCounter.current += 1; };
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
  const close = () => { if (saving) return; counter.current += 1; onClose(); };
  const save = async () => {
    const request = ++counter.current;
    setSaving(true);
    try {
      const result = await saveCustomer(sessionContext(session), row, values);
      if (request !== counter.current) return;
      if ('customer' in result) onSaved(result.customer);
      else setError(result.error);
    } finally { if (request === counter.current) setSaving(false); }
  };
  return <Dialog open={open} onOpenChange={next => { if (!next) close(); }}>
    <DialogContent testID="customer-sheet" dataSet={{ print: 'hide' }}
      className="right-0 left-auto top-0 h-full max-w-md translate-x-0 translate-y-0 rounded-none border-0 border-l">
      <DialogHeader className="text-left">
        <DialogTitle>{row ? `Edit ${`${row.firstName} ${row.lastName}`.trim() || row.email}` : 'New customer'}</DialogTitle>
      </DialogHeader>
      <CustomerForm values={values} onChangeField={(field, value) => { setValues(current => ({ ...current, [field]: value })); setError(null); }} showAddress={false} />
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
      {!online && <Text testID="customer-sheet-offline">{CUSTOMER_OFFLINE_TEXT}</Text>}
      {error && <Text testID="customer-sheet-error" accessibilityRole="alert" className="text-sm text-destructive">{error}</Text>}
      <HStack space="sm" className="mt-auto justify-between">
        <Button testID="customer-sheet-save" disabled={saving || !online || (row !== null && Object.keys(customerPatch(row, values)).length === 0)} onPress={save}>
          <Text>Save</Text>
        </Button>
        <Button testID="customer-sheet-close" variant="outline" disabled={saving} onPress={close}><Text>Close</Text></Button>
      </HStack>
    </DialogContent>
  </Dialog>;
}
