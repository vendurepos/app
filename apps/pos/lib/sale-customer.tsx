import { useState } from 'react';
import { View } from 'react-native';
import { Avatar, avatarInitials, Button, CustomerPicker, HStack, IconButton, Text, XIcon } from '@tallyui/components';
import type { TallyConnector } from '@tallyui/core';
import type { useSale } from '@tallyui/pos';
import { sessionContext, type Session } from './session';

export function SaleCustomer({ sale, connector, session }: {
  sale: ReturnType<typeof useSale>; connector: TallyConnector; session: Session;
}) {
  const [open, setOpen] = useState(false);
  if (!connector.searchCustomers) return null;
  const customer = sale.order.customer;
  const label = customer ? customer.name : 'Guest';
  return (
    <View className="gap-2 p-3">
      {/* v2's cart header: a quiet "Customer" label, then a chip with the customer (or Guest) that opens the picker. */}
      <HStack testID="customer-row" className="items-center gap-2">
        <Text className="text-sm text-muted-foreground">Customer</Text>
        <Button testID="customer-chip" variant="outline" size="sm" className="pl-1" accessibilityLabel="Choose customer"
          disabled={sale.saving} onPress={() => setOpen(!open)}>
          <Avatar size="sm" tone="primary" className="h-6 w-6" fallback={avatarInitials(label)} />
          <Text testID={customer ? 'sale-customer' : undefined}>{label}</Text>
        </Button>
        {customer ? (
          <IconButton testID="customer-remove" variant="ghost" size="sm" accessibilityLabel="Remove customer" disabled={sale.saving}
            onPress={() => sale.setCustomer(null)}>
            <XIcon size={16} />
          </IconButton>
        ) : null}
      </HStack>
      {open ? (
        <View testID="customer-picker" className="rounded-md border border-border p-3">
          <CustomerPicker
            search={(q) => connector.searchCustomers!(sessionContext(session), q, { limit: 20 })}
            create={connector.createCustomer ? (input) => connector.createCustomer!(sessionContext(session), input) : undefined}
            selected={customer ? { id: customer.id, name: customer.name, email: customer.email } : null}
            onSelect={(c) => {
              sale.setCustomer(c ? { id: c.id, name: c.name, email: c.email } : null);
              setOpen(false);
            }}
            onError={(e) => console.warn('Customer lookup failed', e)}
            online={typeof navigator === 'undefined' || navigator.onLine !== false}
          />
        </View>
      ) : null}
    </View>
  );
}
