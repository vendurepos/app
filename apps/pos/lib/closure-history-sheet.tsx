import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { Button, Dialog, DialogContent, DialogTitle, Tabs, TabsList, TabsTrigger, Text } from '@tallyui/components';
import { formatClosureDate, recordRegisterFact, watchFresh, type Actor, type Closure, type ClosureCollection, type RegisterSession, type useRegisterSession } from '@tallyui/pos';
import {
  closureCsvFileName, closureHistoryCsv, closureHistoryRows, closureSummary, fetchChannelClosures, mergeClosures, openSessionRows, zCopyLines, type ClosureHistoryRow,
} from './closure-history';
import { printLines } from './print-lines';
import { remoteXReport, xReportOffered } from './remote-x-report';
import type { Session } from './session';
import { zReportLines } from './z-report';

// No other register's closures yet (or none loaded).
const NO_REMOTE: Awaited<ReturnType<typeof fetchChannelClosures>> = { closures: [], names: {}, registers: [], floats: {}, printable: [] };
// The table view's figure columns (Expected, Counted, Result) and its Print again column, the same widths in the head and the rows.
const CELL = 'w-32 text-right', PRINT = 'w-36';

export function ClosureList({ closures, session, registerId, storeKey, store, currency, timezone, blind, active: open, view = 'list', actor, ownSession }: {
  closures: ClosureCollection | null; session: Session | null; registerId: string;
  storeKey: string; store: string; currency: string; timezone: string; blind: boolean; active: boolean; view?: 'list' | 'table'; actor?: Actor;
  ownSession?: RegisterSession | null;
}) {
  const [filter, setFilter] = useState('all');
  const [found, setFound] = useState<Closure[]>([]);
  const [remote, setRemote] = useState(NO_REMOTE);
  const [remoteError, setRemoteError] = useState(false);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  // Another register's X report that could not print, and a counter that reads the closures again.
  const [xNotice, setXNotice] = useState<{ registerId: string; text: string | null; retry: boolean } | null>(null);
  const [reload, setReload] = useState(0);
  // Every register's closures from the server, once per open; a late answer after the dialog closed is dropped.
  useEffect(() => {
    setRemote(NO_REMOTE); setRemoteError(false);
    if (!open || !session) return;
    let cancelled = false;
    fetchChannelClosures(session, storeKey).then((answer) => { if (!cancelled) setRemote(answer); }, () => { if (!cancelled) setRemoteError(true); });
    return () => { cancelled = true; };
  }, [open, session, storeKey, reload]);
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
  // Another register's X report from a fresh read of its live session; this device's prints from the drawer card.
  const printRemoteX = async (target: { registerId: string }) => {
    setError(''); setXNotice(null);
    if (!session) return;
    const answer = await remoteXReport(session, target.registerId, { store, currency, timezone, blind, printedAt: new Date().toISOString() });
    if ('notice' in answer) { setXNotice({ registerId: target.registerId, text: answer.notice, retry: answer.retry }); if (answer.refresh) setReload((count) => count + 1); return; }
    try { await printLines('X report', answer.lines); } catch (e) { setError(e instanceof Error ? e.message : String(e)); return; }
    if (actor) recordRegisterFact({ kind: 'x-report-dispatched', sessionId: answer.sessionId, registerId: target.registerId, actor });
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
  // This till's own session is read locally (the server has it only once the outbox sends the open); left out, the server's is used.
  const own = ownSession === undefined ? undefined : ownSession && { status: ownSession.status, openedAt: ownSession.opened_at_gmt };
  const openRows = openSessionRows(remote.registers, { ownRegisterId: registerId, timezone, own });
  const openFloats = openRows.map((row) => row.registerId === registerId && ownSession ? ownSession.counted_float_minor : remote.floats[row.registerId]);
  const summary = closureSummary(merged, { open: openRows.length, openFloats, storeKey, currency, timezone, today, blind });
  const tiles = [['discrepancy', 'Discrepancy', summary.discrepancy, 'counted − expected'], ['sessions', 'Sessions', summary.sessions, summary.sessionsNote],
    ['cash-at-open', 'Cash at open', summary.cashAtOpen, 'floats'], ['cash-activity', 'Cash activity', summary.cashActivity, 'sales − refunds ± movements'],
    ['cash-at-close', 'Cash at close', summary.cashAtClose, 'counted']];
  // The closed rows by close day, in list order (newest first).
  const days = rows.reduce<{ day: string; label: string; rows: ClosureHistoryRow[] }[]>((groups, row) => {
    const last = groups[groups.length - 1];
    if (last?.day === row.day) last.rows.push(row); else groups.push({ day: row.day, label: row.dayLabel, rows: [row] });
    return groups;
  }, []);
  const table = view === 'table' ? (
    <View className="mb-4 gap-4">
      <View className="flex-row flex-wrap gap-4">
        {tiles.map(([id, label, value, note]) => (
          <View key={id} testID={`closures-tile-${id}`} className="min-w-32 flex-1 gap-1 rounded-md border border-border p-4">
            <Text className="text-sm text-muted-foreground">{label}</Text>
            <Text className="text-lg font-semibold">{value}</Text>
            <Text className="text-xs text-muted-foreground">{note}</Text>
          </View>
        ))}
      </View>
      <View className="rounded-md border border-border">
        <Tabs value={filter} onValueChange={setFilter}>
          <TabsList className="m-2 flex-row self-start">
            <TabsTrigger testID="closures-filter-all" value="all"><Text>All</Text></TabsTrigger>
            <TabsTrigger testID="closures-filter-open" value="open"><Text>Open</Text></TabsTrigger>
            <TabsTrigger testID="closures-filter-closed" value="closed"><Text>Closed</Text></TabsTrigger>
          </TabsList>
        </Tabs>
        <View className="flex-row gap-2 border-b border-border px-4 py-2">
          {['Closure', 'Expected', 'Counted', 'Result'].map((head, at) => (
            <Text key={head} className={`text-xs uppercase text-muted-foreground ${at === 0 ? 'flex-1' : CELL}`}>{head}</Text>
          ))}
          {!blind ? <View className={PRINT} /> : null}
        </View>
        {filter !== 'closed' ? openRows.map((row) => (
          <View key={row.registerId} testID={`closures-open-${row.registerId}`} className="flex-row items-center gap-2 border-b border-border px-4 py-3">
            <Text className="flex-1">{`${row.register} · ${row.status === 'open' ? 'Open' : 'Counting'} since ${row.since}`}</Text>
            {session && xReportOffered(row.registerId, { ownRegisterId: registerId, status: row.status, printable: remote.printable }) ? (
              <Button testID={`closures-open-print-x-${row.registerId}`} variant="secondary" accessibilityLabel={`Print X-report for ${row.register}`}
                onPress={() => printRemoteX(row)}><Text>Print X-report</Text></Button>
            ) : null}
          </View>
        )) : null}
        {filter !== 'closed' && xNotice?.text ? <Text testID="closures-open-notice" className="px-4 py-3">{xNotice.text}</Text> : null}
        {filter !== 'closed' && xNotice?.retry ? <Button testID="closures-open-retry" variant="secondary" className="mx-4 mb-3 self-start" onPress={() => printRemoteX(xNotice)}><Text>Retry</Text></Button> : null}
        {filter === 'open' && openRows.length === 0 ? <Text testID="closures-open-empty" className="px-4 py-3">No register is open.</Text> : null}
        {filter !== 'open' ? days.map((group) => (
          <View key={group.day} testID={`closures-day-${group.day}`}>
            <Text className="border-b border-border bg-muted px-4 py-2 text-sm font-medium">{group.label}</Text>
            {group.rows.map((row) => (
              <View key={row.id} className="flex-row items-center gap-2 border-b border-border px-4 py-3">
                <Pressable testID={`closure-history-open-${suffix(row)}`} disabled={blind} accessibilityRole="button" onPress={() => setOpenId(row.id)}
                  className="flex-1 flex-row gap-2">
                  <Text testID={`closure-history-row-${suffix(row)}`} className="flex-1">{`${row.register} · Closure #${row.number} · ${row.closedAt}`}</Text>
                  {[row.expected, row.cashAtClose, row.variance].map((cell, at) => <Text key={at} className={CELL}>{cell}</Text>)}
                </Pressable>
                {!blind ? (
                  <Button testID={`closure-history-print-${suffix(row)}`} variant="secondary" className={PRINT}
                    accessibilityLabel={`Print Z report #${row.number} again`} onPress={() => printCopy(row.id)}><Text>Print again</Text></Button>
                ) : null}
              </View>
            ))}
          </View>
        )) : null}
        {filter === 'all' && rows.length === 0 ? <Text testID="closure-history-empty" className="px-4 py-3">No closures in the last 92 days.</Text> : null}
      </View>
    </View>
  ) : null;
  return (
    <>
      {table ?? <ScrollView className="max-h-96">
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
      </ScrollView>}
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
            <ClosureList closures={closures} session={session} registerId={registerId} storeKey={storeKey} store={store} currency={currency} timezone={timezone} blind={register.blind} active={open} ownSession={register.session} />
            <Button testID="closure-history-close" onPress={() => onOpenChange(false)}><Text>Close</Text></Button>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
