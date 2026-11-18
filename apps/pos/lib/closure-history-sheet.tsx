import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { Button, Dialog, DialogContent, DialogTitle, Text } from '@tallyui/components';
import { formatClosureDate, watchFresh, type Closure, type ClosureCollection, type useRegisterSession } from '@tallyui/pos';
import { closureCsvFileName, closureHistoryCsv, closureHistoryRows, fetchChannelClosures, mergeClosures, zCopyLines } from './closure-history';
import { printLines } from './print-lines';
import type { Session } from './session';
import { zReportLines } from './z-report';

// No other register's closures yet (or none loaded).
const NO_REMOTE: Awaited<ReturnType<typeof fetchChannelClosures>> = { closures: [], names: {} };

export function ClosureList({ closures, session, registerId, storeKey, store, currency, timezone, blind, active: open }: {
  closures: ClosureCollection | null; session: Session | null; registerId: string;
  storeKey: string; store: string; currency: string; timezone: string; blind: boolean; active: boolean;
}) {
  const [found, setFound] = useState<Closure[]>([]);
  const [remote, setRemote] = useState(NO_REMOTE);
  const [remoteError, setRemoteError] = useState(false);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  // Every register's closures from the server, once per open; a late answer after the dialog closed is dropped.
  useEffect(() => {
    setRemote(NO_REMOTE); setRemoteError(false);
    if (!open || !session) return;
    let cancelled = false;
    fetchChannelClosures(session, storeKey).then((answer) => { if (!cancelled) setRemote(answer); }, () => { if (!cancelled) setRemoteError(true); });
    return () => { cancelled = true; };
  }, [open, session, storeKey]);
  useEffect(() => {
    setFound([]);
    if (!open || !closures || !registerId) return;
    const subscription = watchFresh(closures, { selector: { register_id: registerId } }).subscribe(setFound);
    return () => subscription.unsubscribe();
  }, [closures, registerId, open]);

  const today = formatClosureDate(new Date().toISOString(), { timezone, locale: 'en' }).date_ymd;
  const merged = mergeClosures(found, remote.closures);
  // This till's own rows keep their testIDs; another register's carry its id, as numbers repeat across registers.
  const suffix = (row: { registerId: string; number: number }) => row.registerId === registerId ? `${row.number}` : `${row.registerId}-${row.number}`;
  const rows = closureHistoryRows(merged, { ownRegisterId: registerId, names: remote.names, storeKey, currency, timezone, today, blind });
  const exportCsv = () => {
    setError('');
    try {
      const csv = closureHistoryCsv(merged, { ownRegisterId: registerId, names: remote.names, storeKey, currency, timezone, today, store });
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = closureCsvFileName(merged, { storeKey, timezone, today });
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const printCopy = async (id: string) => {
    setError('');
    const closure = merged.find((row) => row.id === id);
    if (!closure) return;
    try {
      await printLines(`Z report #${closure.number} (copy)`,
        zCopyLines(closure, { store, currency, timezone, printedAt: new Date().toISOString() }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const openRow = rows.find((row) => row.id === openId);
  const openClosure = merged.find((row) => row.id === openId);
  if (openRow && openClosure) return (
    <View testID="closure-detail" className="gap-2">
      <Text testID="closure-detail-title" className="font-semibold">{`${openRow.register} · Closure #${openRow.number}`}</Text>
      <ScrollView className="max-h-96">{zReportLines(openClosure, { store, currency, timezone, printedAt: new Date().toISOString() }).map((line, at) => <Text key={at}>{line}</Text>)}</ScrollView>
      {error ? <Text testID="closure-history-print-error" className="text-destructive">{error}</Text> : null}
      <Button testID="closure-detail-print" variant="secondary" onPress={() => printCopy(openClosure.id)}><Text>Print again</Text></Button>
      <Button testID="closure-detail-back" variant="secondary" onPress={() => setOpenId(null)}><Text>Back</Text></Button>
    </View>
  );
  return (
    <>
      <ScrollView className="max-h-96">
        {rows.map((row) => (
          <View key={row.id}>
            <Pressable testID={`closure-history-open-${suffix(row)}`} disabled={blind} accessibilityRole="button" onPress={() => setOpenId(row.id)}>
              <Text testID={`closure-history-row-${suffix(row)}`}>
                {`${row.register} · Closure #${row.number} · ${row.closedAt}${row.salesTotal ? ` · Sales ${row.salesTotal}` : ''}`
                  + `${row.cashAtOpen ? ` · Cash at open ${row.cashAtOpen}` : ''}${row.cashAtClose ? ` · Cash at close ${row.cashAtClose}` : ''}`
                  + `${row.variance ? ` · ${row.variance}` : ''}`}
              </Text>
            </Pressable>
            {!blind ? (
              <Button testID={`closure-history-print-${suffix(row)}`} variant="secondary"
                accessibilityLabel={`Print Z report #${row.number} again`} onPress={() => printCopy(row.id)}>
                <Text>Print again</Text>
              </Button>
            ) : null}
          </View>
        ))}
        {rows.length === 0 ? <Text testID="closure-history-empty">No closures in the last 92 days.</Text> : null}
      </ScrollView>
      {remoteError ? <Text testID="closure-history-remote-error">{"Other registers' closures could not be loaded."}</Text> : null}
      {error ? <Text testID="closure-history-print-error" className="text-destructive">{error}</Text> : null}
      {Platform.OS === 'web' && !blind && rows.length > 0 ? (
        <Button testID="closure-history-export" variant="secondary" onPress={exportCsv}><Text>Export CSV</Text></Button>
      ) : null}
    </>
  );
}

export function ClosureHistory({ closures, session, register, registerId, storeKey, store, currency, timezone, open, onOpenChange }: {
  closures: ClosureCollection | null; session: Session | null; register: ReturnType<typeof useRegisterSession>; registerId: string | null | undefined;
  storeKey: string; store: string; currency: string; timezone: string; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  if (!closures || !registerId || !register.lastClosure) return null;
  return (
    <>
      <Button testID="closure-history-open" variant="secondary" onPress={() => onOpenChange(true)}><Text>Closures</Text></Button>
      {open ? (
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent testID="closure-history">
            <DialogTitle>Closures</DialogTitle>
            <ClosureList closures={closures} session={session} registerId={registerId} storeKey={storeKey} store={store} currency={currency} timezone={timezone} blind={register.blind} active={open} />
            <Button testID="closure-history-close" onPress={() => onOpenChange(false)}><Text>Close</Text></Button>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
