import { useEffect, useRef, useState, type JSX } from 'react';
import { Pressable, View } from 'react-native';
import { Card, CardContent, CardHeader, CardTitle, Text, VStack } from '@tallyui/components';
import { fetchRegisters, pickRefusal, registerChoices, type ListedRegister } from './register-choice';
import { defaultStore, type Session } from './session';
import { bindRegister, boundRegisterId, ownRegisterId } from './till-ids';

/** Settings › General: v2's "Which register is this device at?" (CHECKLIST 6.6). */
export function RegisterChoiceSettings({ session, tillUpdatesPending }: { session: Session; tillUpdatesPending?: number }): JSX.Element {
  const [own] = useState(() => ownRegisterId(defaultStore()));
  const [bound, setBound] = useState(() => boundRegisterId(defaultStore()));
  const [listed, setListed] = useState<ListedRegister[]>([]);
  const [failed, setFailed] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const read = useRef(() => {});
  useEffect(() => {
    let live = true;
    read.current = () => void fetchRegisters(session).then(
      (registers) => { if (live) { setListed(registers); setFailed(false); } },
      () => { if (live) setFailed(true); },
    );
    read.current();
    return () => { live = false; };
  }, [session]);
  // The till's own open or close may still be on its way when Settings mounts: read again each time one reaches the store.
  const previousPending = useRef(tillUpdatesPending);
  useEffect(() => {
    if ((tillUpdatesPending ?? 0) < (previousPending.current ?? 0)) read.current();
    previousPending.current = tillUpdatesPending;
  }, [tillUpdatesPending]);
  return (
    <Card className="w-full max-w-[420px]">
      <CardHeader><CardTitle aria-level={2}>Register</CardTitle></CardHeader>
      <CardContent>
        <VStack space="sm">
          <Text>Which register is this device at?</Text>
          <View testID="register-choices" accessibilityRole="radiogroup" aria-label="Which register is this device at?">
          {registerChoices(own, listed, new Date()).map((choice) => {
            const testID = choice.id === own ? 'register-choice-own' : `register-choice-${choice.id}`;
            return (
              <Pressable key={choice.id} testID={testID} accessibilityRole="radio" aria-checked={choice.id === bound}
                className={`rounded-md px-3 py-2${choice.id === bound ? ' bg-muted' : ''}`}
                onPress={() => {
                  const refused = pickRefusal(choice.id, bound);
                  setRefusal(refused);
                  if (refused) return;
                  bindRegister(defaultStore(), choice.id);
                  setBound(choice.id);
                }}>
                <Text className="text-sm text-foreground">{choice.label}</Text>
                {choice.status ? <Text testID={`${testID}-status`} className="text-sm text-muted-foreground">{choice.status}</Text> : null}
              </Pressable>
            );
          })}
          </View>
          {refusal ? <Text testID="register-choice-refused">{refusal}</Text> : null}
          {failed ? <Text testID="register-choices-error" className="text-sm text-muted-foreground">Other registers show when the store can be reached.</Text> : null}
        </VStack>
      </CardContent>
    </Card>
  );
}
