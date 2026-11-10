import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Button, Dialog, DialogContent, DialogTitle, Text } from '@tallyui/components';
import { formatClosureDate, watchFresh, type Closure, type ClosureCollection, type useRegisterSession } from '@tallyui/pos';
import { closureHistoryRows, zCopyLines } from './closure-history';
import { printLines } from './print-lines';

export function ClosureHistory({ closures, register, registerId, storeKey, store, currency, timezone, open, onOpenChange }: {
  closures: ClosureCollection | null; register: ReturnType<typeof useRegisterSession>; registerId: string | null | undefined;
  storeKey: string; store: string; currency: string; timezone: string; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const [found, setFound] = useState<Closure[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    setFound([]);
    if (!open || !closures || !registerId) return;
    const subscription = watchFresh(closures, { selector: { register_id: registerId } }).subscribe(setFound);
    return () => subscription.unsubscribe();
  }, [closures, registerId, open]);
  if (!closures || !registerId || !register.lastClosure) return null;

  const rows = closureHistoryRows(found, {
    registerId, storeKey, currency, timezone,
    today: formatClosureDate(new Date().toISOString(), { timezone, locale: 'en' }).date_ymd, blind: register.blind,
  });
  const printCopy = async (id: string) => {
    setError('');
    const closure = found.find((row) => row.id === id);
    if (!closure) return;
    try {
      await printLines(`Z report #${closure.number} (copy)`,
        zCopyLines(closure, { store, currency, timezone, printedAt: new Date().toISOString() }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <Button testID="closure-history-open" variant="secondary" onPress={() => onOpenChange(true)}><Text>Closures</Text></Button>
      {open ? (
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent testID="closure-history">
            <DialogTitle>Closures</DialogTitle>
            <ScrollView className="max-h-96">
              {rows.map((row) => (
                <View key={row.id}>
                  <Text testID={`closure-history-row-${row.number}`}>
                    {`Closure #${row.number} · ${row.closedAt}${row.salesTotal ? ` · Sales ${row.salesTotal}` : ''}${row.variance ? ` · ${row.variance}` : ''}`}
                  </Text>
                  {!register.blind ? (
                    <Button testID={`closure-history-print-${row.number}`} variant="secondary"
                      accessibilityLabel={`Print Z report #${row.number} again`} onPress={() => printCopy(row.id)}>
                      <Text>Print again</Text>
                    </Button>
                  ) : null}
                </View>
              ))}
              {rows.length === 0 ? <Text testID="closure-history-empty">No closures on this till in the last 92 days.</Text> : null}
            </ScrollView>
            {error ? <Text testID="closure-history-print-error" className="text-destructive">{error}</Text> : null}
            <Button testID="closure-history-close" onPress={() => onOpenChange(false)}><Text>Close</Text></Button>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
