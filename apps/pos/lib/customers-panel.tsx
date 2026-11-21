import { useState, type JSX } from 'react';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import {
  Avatar, type OrderHistoryRow, avatarInitials, Button, HStack, IconButton, SearchInput, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Text, VStack,
} from '@tallyui/components';
import { DEFAULT_CUSTOMER_SORT, nextCustomerSort, useCustomerList, type CustomerRow, type CustomerSort, type CustomerSortField } from './customer-list';
import { useCustomerAccess } from './customer-edit';
import { CustomerSheet } from './customer-sheet';
import { RefreshIcon } from './nav-icons';
import type { Session } from './session';

// Column widths for the wide table, header and cells alike: the avatar column fits its circle, and the email column is
// twice as wide so an address does not wrap mid-word at 1280 (v2's table).
const COLUMN_CLASS = ['w-16 flex-none', undefined, undefined, 'flex-[2]', undefined, undefined, 'w-20 flex-none'];

export function CustomersPanel({ session, timezone, onOpenOrder }: { session: Session; timezone: string; onOpenOrder?: (row: OrderHistoryRow) => void }): JSX.Element {
  const wide = useWindowDimensions().width >= 640;
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<CustomerSort>(DEFAULT_CUSTOMER_SORT);
  const access = useCustomerAccess(session);
  const [sheet, setSheet] = useState<{ row: CustomerRow | null } | null>(null);
  const { customers, totalItems, notice, loading, loadMore, reload } = useCustomerList(session, true, search, sort);
  const dateFormat = new Intl.DateTimeFormat(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: timezone === 'device' ? undefined : timezone,
  });
  return (
    <VStack testID="customers-panel" className="flex-1">
      <HStack dataSet={{ print: 'hide' }} className="items-center border-b border-border px-4 py-2">
        <View className="min-w-[200px] flex-1">
          <SearchInput testID="customers-search" value={search} onChangeText={setSearch} placeholder="Name, email or phone" />
        </View>
        {access.create && <Button testID="customers-add" variant="secondary" size="sm" className="ml-2" onPress={() => setSheet({ row: null })}><Text>Add customer</Text></Button>}
      </HStack>
      {notice ? <HStack dataSet={{ print: 'hide' }} className="items-center border-b border-border px-4 py-2" space="sm">
        <Text testID="customers-notice" className="flex-1 text-sm text-muted-foreground">{notice.text}</Text>
        {notice.retry ? <Button testID="customers-retry" variant="secondary" size="sm" disabled={loading} onPress={reload}>
          <Text>Try again</Text>
        </Button> : null}
      </HStack> : null}
      <ScrollView className="flex-1">
        <Table>
          {wide ? <TableHeader><TableRow>
            {([{ label: '' }, { label: 'First name', field: 'firstName' }, { label: 'Last name', field: 'lastName' }, { label: 'Email', field: 'emailAddress' },
              { label: 'Billing address' }, { label: 'Date created', field: 'createdAt' }, ...(access.update ? [{ label: '' }] : [])] as { label: string; field?: CustomerSortField }[]).map(({ label, field }, index) => (
              <TableHead key={index} className={COLUMN_CLASS[index]} aria-sort={field ? (sort.field === field ? (sort.dir === 'ASC' ? 'ascending' : 'descending') : 'none') : undefined}>
                {field ? <Pressable accessibilityRole="button" accessibilityLabel={'Sort by ' + label} testID={'customers-sort-' + field} onPress={() => setSort(current => nextCustomerSort(current, field))}>
                  <Text>{label}{sort.field === field ? (sort.dir === 'ASC' ? ' ▲' : ' ▼') : ''}</Text>
                </Pressable> : <Text>{label}</Text>}</TableHead>
            ))}
          </TableRow></TableHeader> : null}
          <TableBody>
            {customers.map(row => {
              const name = `${row.firstName} ${row.lastName}`.trim() || row.email;
              const edit = access.update && <Button testID={`customers-edit-${row.id}`} variant="ghost" size="sm" accessibilityLabel={`Edit ${name}`} onPress={() => setSheet({ row })}><Text>Edit</Text></Button>;
              const avatar = <Avatar className="h-9 w-9" tone="primary" fallback={avatarInitials(`${row.firstName} ${row.lastName}`.trim() || row.email)} />;
              // A demo saved before customers had dates has none until Reset demo; formatting an invalid date throws.
              const missingDate = !row.createdAt || Number.isNaN(Date.parse(row.createdAt));
              return <View key={row.id} testID={`customers-row-${row.id}`}><TableRow>
                {wide ? <>
                  <TableCell className={COLUMN_CLASS[0]}>{avatar}</TableCell>
                  <TableCell><Text>{row.firstName}</Text></TableCell>
                  <TableCell><Text>{row.lastName}</Text></TableCell>
                  <TableCell className={COLUMN_CLASS[3]}><Text>{row.email}</Text></TableCell>
                  <TableCell>{row.billingAddress.length > 0
                    ? <VStack space="none">{row.billingAddress.map((line, index) => <Text key={index}>{line}</Text>)}</VStack>
                    : <Text className="text-muted-foreground">—</Text>}</TableCell>
                  <TableCell><Text className={missingDate ? 'text-muted-foreground' : undefined}>
                    {missingDate ? '—' : dateFormat.format(new Date(row.createdAt))}
                  </Text></TableCell>
                  {access.update && <TableCell className={COLUMN_CLASS[6]}>{edit}</TableCell>}
                </> : <TableCell><HStack space="sm">
                  {avatar}
                  <VStack>
                    <Text className="font-medium">{row.firstName} {row.lastName}</Text>
                    <Text className="text-sm text-muted-foreground">{row.email}</Text>
                    {edit}
                  </VStack>
                </HStack></TableCell>}
              </TableRow></View>;
            })}
          </TableBody>
        </Table>
        {loading && customers.length === 0 ? <Text testID="customers-loading" className="p-4">Loading customers…</Text> : null}
        {!loading && customers.length === 0 && !notice ? <Text testID="customers-empty" className="p-4 text-muted-foreground">
          {search.trim() ? 'No customers match this search.' : 'No customers on the store yet.'}
        </Text> : null}
        {customers.length > 0 ? <HStack className="items-center justify-between px-4 py-3">
          <HStack className="items-center gap-1">
            <Text testID="customers-count">{`Showing ${customers.length} of ${totalItems} customers`}</Text>
            <IconButton testID="customers-refresh" variant="ghost" size="sm" accessibilityLabel="Refresh customers" disabled={loading} onPress={reload}>
              <RefreshIcon size={16} />
            </IconButton>
          </HStack>
          {customers.length < totalItems ? <Button testID="customers-more" variant="secondary" size="sm" disabled={loading} onPress={loadMore}>
            <Text>Show more</Text>
          </Button> : null}
        </HStack> : null}
      </ScrollView>
      <CustomerSheet session={session} row={sheet?.row ?? null} open={sheet !== null} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); reload(); }} onOpenOrder={onOpenOrder} />
    </VStack>
  );
}
