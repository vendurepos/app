import { useEffect, useState, type JSX } from 'react';
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, HStack, Text, VStack } from '@tallyui/components';
import { boundRegisterLabel, CLOSE_FIRST_TEXT, fetchRegisters, type ListedRegister } from './register-choice';
import { RegisterChoiceSettings } from './register-choice-settings';
import { defaultStore, type Session } from './session';
import { boundRegisterId, ownRegisterId } from './till-ids';

/** v2's cashier sheet Store and Register rows (CHECKLIST 6.1): Store read-only; Register switches through the Settings picker. */
export function RegisterSwitchRows({ session, store, held, onSwitched }: {
  session: Session; store: string; held: boolean; onSwitched(): void;
}): JSX.Element {
  const [listed, setListed] = useState<ListedRegister[]>([]);
  const [bound, setBound] = useState(() => boundRegisterId(defaultStore()));
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => { void fetchRegisters(session).then(setListed, () => {}); }, [session]);
  const close = () => {
    setPickerOpen(false);
    setBound(boundRegisterId(defaultStore()));
    onSwitched();
  };
  return (
    <VStack testID="cashier-switch-rows" className="w-full">
      <HStack testID="cashier-store-row" className="w-full items-start justify-between">
        <Text className="text-sm text-muted-foreground">Store</Text>
        <Text testID="cashier-store-name">{store}</Text>
      </HStack>
      <HStack testID="cashier-register-row" className="w-full items-start justify-between">
        <VStack>
          <Text className="text-sm text-muted-foreground">Register</Text>
          {held ? <Text testID="cashier-register-held" className="max-w-[160px] text-xs text-muted-foreground">{CLOSE_FIRST_TEXT}</Text> : null}
        </VStack>
        <Text testID="cashier-register-name">{boundRegisterLabel(ownRegisterId(defaultStore()), listed, bound)}</Text>
        <Button testID="cashier-register-switch" variant="ghost" size="sm" disabled={held} onPress={() => setPickerOpen(true)}><Text>Switch</Text></Button>
      </HStack>
      <Dialog open={pickerOpen} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent testID="cashier-register-picker" className="max-w-md">
          <DialogHeader><DialogTitle>Switch register</DialogTitle></DialogHeader>
          <RegisterChoiceSettings session={session} />
          <Button testID="cashier-register-picker-done" onPress={close}><Text>Done</Text></Button>
        </DialogContent>
      </Dialog>
    </VStack>
  );
}
