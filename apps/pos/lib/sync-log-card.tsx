import { useState, useSyncExternalStore, type JSX } from 'react';
import { Platform, ScrollView, Share, View } from 'react-native';
import { Button, Card, CardContent, CardHeader, CardTitle, HStack, Text, VStack } from '@tallyui/components';
import { filterLogEntries, formatLogLine, logCopyText, logEntries, subscribeLogEntries, type LogFilter } from './log-buffer';

export function SyncLogCard(): JSX.Element {
  const entries = useSyncExternalStore(subscribeLogEntries, logEntries, logEntries);
  const [filter, setFilter] = useState<LogFilter>('all');
  const [copied, setCopied] = useState<boolean | null>(null);
  const shown = filterLogEntries(entries, filter);
  return (
    <Card className="w-full max-w-[420px]">
      <CardHeader><CardTitle aria-level={2}>Sync log</CardTitle></CardHeader>
      <CardContent>
        <VStack space="lg">
          <Text>{"This till's last 500 sync events since the app opened, newest first."}</Text>
          <HStack space="sm">
            <Button size="sm" testID="sync-log-filter-all" variant={filter === 'all' ? 'default' : 'secondary'}
              onPress={() => { setFilter('all'); setCopied(null); }}><Text>All</Text></Button>
            <Button size="sm" testID="sync-log-filter-problems" variant={filter === 'problems' ? 'default' : 'secondary'}
              onPress={() => { setFilter('problems'); setCopied(null); }}><Text>Warnings and errors</Text></Button>
          </HStack>
          {(Platform.OS !== 'web' || (typeof navigator !== 'undefined' && !!navigator.clipboard)) && (
            <Button testID="sync-log-copy" variant="secondary" onPress={() => {
              const text = logCopyText(shown);
              if (Platform.OS === 'web') {
                navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false));
              } else {
                void Share.share({ message: text });
              }
            }}><Text>{Platform.OS === 'web' ? 'Copy' : 'Share'}</Text></Button>
          )}
          {copied === true && <Text testID="sync-log-copied">Copied.</Text>}
          {copied === false && <Text testID="sync-log-copy-error">{"Couldn't copy the log."}</Text>}
          <View testID="sync-log">
            <ScrollView nestedScrollEnabled style={{ maxHeight: 360 }}>
              {shown.map((entry) => (
                <Text key={entry.id} testID="sync-log-entry" selectable
                  className={`text-xs ${entry.level === 'error' ? 'text-destructive' : entry.level === 'warn' ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {`${new Date(entry.timestamp).toLocaleTimeString()} ${formatLogLine(entry)}`}
                </Text>
              ))}
              {shown.length === 0 && <Text testID="sync-log-empty">{filter === 'all' ? 'Nothing logged yet.' : 'No warnings or errors.'}</Text>}
            </ScrollView>
          </View>
        </VStack>
      </CardContent>
    </Card>
  );
}
