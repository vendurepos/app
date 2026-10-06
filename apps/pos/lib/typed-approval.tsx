import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, DialogContent, DialogTitle, Input, InputField, Label, Text } from '@tallyui/components';
import { typedApprover } from './register-approval';

export function useTypedApproval(): { approve: () => Promise<ReturnType<typeof typedApprover>>; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const resolve = useRef<((value: ReturnType<typeof typedApprover>) => void) | null>(null);
  useEffect(() => () => { resolve.current?.(null); resolve.current = null; }, []);
  const answer = (value: ReturnType<typeof typedApprover>) => {
    resolve.current?.(value);
    resolve.current = null;
    setOpen(false);
  };
  const approve = () => new Promise<ReturnType<typeof typedApprover>>((done) => {
    resolve.current?.(null);
    resolve.current = done;
    setName('');
    setOpen(true);
  });
  const dialog = (
    <Dialog open={open} onOpenChange={(value) => { if (!value) answer(null); }}>
      <DialogContent>
        <DialogTitle>Manager approval</DialogTitle>
        <Text>{"This count is over the till's limit. Type the name of the manager who approves it. The name is recorded as typed, not verified."}</Text>
        <Label nativeID="approver-name-label">Approved by (typed name)</Label>
        <Input><InputField testID="approver-name" value={name} onChangeText={setName}
          accessibilityLabel="Approved by (typed name)" accessibilityLabelledBy="approver-name-label" /></Input>
        <Button testID="approver-confirm" disabled={!name.trim()} onPress={() => answer(typedApprover(name))}><Text>Approve</Text></Button>
        <Button testID="approver-cancel" onPress={() => answer(null)}><Text>Cancel</Text></Button>
      </DialogContent>
    </Dialog>
  );
  return { approve, dialog };
}
