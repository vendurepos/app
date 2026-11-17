import type { JSX } from 'react';
import { ScrollView, View } from 'react-native';
import { Button, Dialog, DialogClose, DialogContent, DialogTitle, IconButton, Text, VStack, XIcon } from '@tallyui/components';
import { BellIcon } from './nav-icons';
import type { TillNotice } from './notices';

/** v2's Notifications sheet (CHECKLIST 11.1), a right-hand side sheet as TallyUI's RegisterPanel presentation="side"; its notices come from lib/notices.ts. */
export function NotificationsSheet({ open, onOpenChange, notices }: {
  open: boolean; onOpenChange(open: boolean): void; notices: TillNotice[];
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent testID="notifications-sheet" side="right" dataSet={{ print: 'hide' }} className="max-w-sm flex-col">
        <View className="flex-row items-center justify-between gap-2">
          <DialogTitle>Notifications</DialogTitle>
          <DialogClose asChild><IconButton variant="ghost" size="sm" testID="notifications-dismiss" accessibilityLabel="Close notifications"><XIcon size={16} /></IconButton></DialogClose>
        </View>
        <ScrollView className="flex-1" contentContainerClassName="gap-3">
          {notices.length === 0 ? (
            <VStack testID="notifications-empty" className="items-center py-6" space="sm">
              <BellIcon size={24} />
              <Text className="font-medium">No notifications</Text>
              <Text className="text-center text-sm text-muted-foreground">Plugin updates and notices about VendurePOS arrive here.</Text>
            </VStack>
          ) : notices.map(notice => (
            <VStack key={notice.id} testID={`notification-${notice.id}`} className="gap-1 border-b border-border pb-3">
              <Text className="font-medium">{notice.title}</Text>
              <Text className="text-sm text-muted-foreground">{notice.body}</Text>
            </VStack>
          ))}
        </ScrollView>
        <View className="items-end border-t border-border pt-4">
          <Button testID="notifications-close" variant="outline" onPress={() => onOpenChange(false)}><Text>Close</Text></Button>
        </View>
      </DialogContent>
    </Dialog>
  );
}
