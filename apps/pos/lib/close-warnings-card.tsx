import type { JSX } from 'react';
import { Card, Text, VStack } from '@tallyui/components';
import type { closeWarningLines } from './close-warnings';

/** The count's warning card (AUDIT §4): what the close leaves behind, above RegisterCount. Nothing when nothing is left. */
export function CloseWarningsCard({ lines }: { lines: ReturnType<typeof closeWarningLines> }): JSX.Element | null {
  if (lines.length === 0) return null;
  return <Card testID="close-warnings" className="mt-2 w-full border border-border p-3">
    <VStack space="xs">
      <Text className="font-semibold">Before you close</Text>
      {lines.map((line) => <Text key={line.code} testID={`close-warning-${line.code}`} className="text-sm">{line.text}</Text>)}
      <Text className="text-sm text-muted-foreground">Go back to selling to finish them, or count and close anyway.</Text>
    </VStack>
  </Card>;
}
