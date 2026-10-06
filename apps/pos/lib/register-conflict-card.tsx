// A temporary, plain stop-gap that TallyUI's conflict sheet replaces; medusapos has the same card.
import { useState } from 'react';
import { Button, Text, VStack, HStack } from '@tallyui/components';
import type { useRegisterSession } from '@tallyui/pos';
import { canTakeOver, registerConflictText } from './register-conflict';

export function RegisterConflictCard({ register, registerContract, onChoseAnother, className }: {
  register: ReturnType<typeof useRegisterSession>; registerContract: number | undefined; onChoseAnother(): void; className?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function takeOver() {
    setPending(true);
    setError(null);
    try {
      await register.actions.takeOver();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  async function chooseAnother() {
    setPending(true);
    setError(null);
    try {
      await register.actions.chooseAnotherRegister();
      onChoseAnother();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <VStack testID="register-conflict" className={className} space="sm">
      <Text>{registerConflictText(register.conflict)}</Text>
      <HStack space="sm">
        {canTakeOver(registerContract) ? (
          <Button testID="register-take-over" disabled={pending || register.conflict?.takingOver} onPress={() => void takeOver()}>
            <Text>Take over</Text>
          </Button>
        ) : null}
        <Button testID="register-choose-another" variant="secondary" disabled={pending} onPress={() => void chooseAnother()}>
          <Text>Choose another register</Text>
        </Button>
      </HStack>
      {error ? <Text testID="register-conflict-error" accessibilityRole="alert" className="text-destructive">{error}</Text> : null}
    </VStack>
  );
}
