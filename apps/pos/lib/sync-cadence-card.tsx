import { useState, type JSX } from 'react';
import { Pressable, View } from 'react-native';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, InputField, Label, Text, VStack } from '@tallyui/components';
import { defaultStore } from './session';
import { CADENCE_LIMITS, CADENCE_PRESETS, STANDARD_PAGE_RECORDS, STANDARD_SYNC_CADENCE, cadenceSummary, loadSyncCadence, saveSyncCadence, type CadenceChoice } from './sync-cadence';

export function SyncCadenceCard(): JSX.Element {
  const [cadence, setCadence] = useState(() => loadSyncCadence());
  const [choice, setChoice] = useState<CadenceChoice>(cadence.choice);
  const [seconds, setSeconds] = useState(String(cadence.checkIntervalMs / 1000));
  const [records, setRecords] = useState(String(cadence.pullBatchSize ?? STANDARD_PAGE_RECORDS));
  const [error, setError] = useState(false);
  return (
    <Card testID="sync-cadence">
      <CardHeader>
        <CardTitle>Sync cadence</CardTitle>
        <CardDescription>How often this till checks the store for changes, and how many records each check may bring. Kept on this device. A new page size applies the next time the till starts.</CardDescription>
      </CardHeader>
      <CardContent><VStack space="sm">
        <View testID="sync-cadence-choices" accessibilityRole="radiogroup" aria-label="Sync cadence">
          {(['standard', 'eco', 'balanced', 'realtime', 'custom'] as const).map(value => (
            <Pressable key={value} testID={`sync-cadence-${value}`} accessibilityRole="radio" aria-checked={choice === value}
              className={`rounded-md px-3 py-2${choice === value ? ' bg-muted' : ''}`}
              onPress={() => {
                const next = value === 'custom' ? cadence : saveSyncCadence(defaultStore(), value);
                setCadence(next);
                setChoice(value);
                setSeconds(String(next.checkIntervalMs / 1000));
                setRecords(String(next.pullBatchSize ?? STANDARD_PAGE_RECORDS));
                setError(false);
              }}>
              <Text className="text-sm text-foreground">{{ standard: 'Standard (default)', eco: 'Eco', balanced: 'Balanced', realtime: 'Realtime', custom: 'Custom' }[value]}</Text>
              {value !== 'custom' ? <Text testID={`sync-cadence-${value}-summary`} className="text-sm text-muted-foreground">
                {cadenceSummary(value === 'standard' ? STANDARD_SYNC_CADENCE : { choice: value, ...CADENCE_PRESETS[value] })}
              </Text> : null}
            </Pressable>
          ))}
        </View>
        {choice === 'custom' ? <>
          <Label nativeID="sync-cadence-seconds-label">Check every (seconds)</Label>
          <Input><InputField testID="sync-cadence-custom-seconds" accessibilityLabelledBy="sync-cadence-seconds-label"
            keyboardType="number-pad" value={seconds} onChangeText={setSeconds} /></Input>
          <Label nativeID="sync-cadence-records-label">Records a check</Label>
          <Input><InputField testID="sync-cadence-custom-records" accessibilityLabelledBy="sync-cadence-records-label"
            keyboardType="number-pad" value={records} onChangeText={setRecords} /></Input>
          <Button testID="sync-cadence-custom-save" className="self-start" onPress={() => {
            const interval = Number(seconds), batchSize = Number(records);
            if (!Number.isFinite(interval) || !Number.isFinite(batchSize)) { setError(true); return; }
            const next = saveSyncCadence(defaultStore(), { checkIntervalMs: interval * 1000, pullBatchSize: batchSize });
            setCadence(next);
            setChoice(next.choice);
            setSeconds(String(next.checkIntervalMs / 1000));
            setRecords(String(next.pullBatchSize ?? STANDARD_PAGE_RECORDS));
            setError(false);
          }}><Text>Save</Text></Button>
          {error ? <Text testID="sync-cadence-custom-error">Enter whole numbers.</Text> : null}
          <Text testID="sync-cadence-custom-summary" className="text-sm text-muted-foreground">
            {cadence.choice === 'custom' ? cadenceSummary(cadence) : `Between ${CADENCE_LIMITS.checkIntervalMs.min / 1000} s and ${CADENCE_LIMITS.checkIntervalMs.max / 60000} min, ${CADENCE_LIMITS.pullBatchSize.min} to ${CADENCE_LIMITS.pullBatchSize.max} records.`}
          </Text>
        </> : null}
      </VStack></CardContent>
    </Card>
  );
}
