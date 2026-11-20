import { useEffect, useRef, useState, type JSX } from 'react';
import { Button, CustomerForm, Dialog, DialogContent, DialogHeader, DialogTitle, HStack, Text } from '@tallyui/components';
import type { Customer } from '@tallyui/core';
import { CUSTOMER_OFFLINE_TEXT, customerFormValues, customerPatch, saveCustomer } from './customer-edit';
import type { CustomerRow } from './customer-list';
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
  const online = useOnline();
  useEffect(() => {
    if (open) { setValues(customerFormValues(row)); setError(null); setSaving(false); }
    return () => { counter.current += 1; };
  }, [open, row]);
  const close = () => { counter.current += 1; onClose(); };
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
      {!online && <Text testID="customer-sheet-offline">{CUSTOMER_OFFLINE_TEXT}</Text>}
      {error && <Text testID="customer-sheet-error" accessibilityRole="alert" className="text-sm text-destructive">{error}</Text>}
      <HStack space="sm" className="mt-auto justify-between">
        <Button testID="customer-sheet-save" disabled={saving || !online || (row !== null && Object.keys(customerPatch(row, values)).length === 0)} onPress={save}>
          <Text>Save</Text>
        </Button>
        <Button testID="customer-sheet-close" variant="outline" onPress={close}><Text>Close</Text></Button>
      </HStack>
    </DialogContent>
  </Dialog>;
}
