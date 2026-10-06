import { useState } from 'react';
import { View } from 'react-native';
import { Button, CustomerPicker, Text } from '@tallyui/components';
import type { TallyConnector } from '@tallyui/core';
import type { useSale } from '@tallyui/pos';
import { sessionContext, type Session } from './session';

export function SaleCustomer({ sale, connector, session }: {
  sale: ReturnType<typeof useSale>; connector: TallyConnector; session: Session;
}) {
  const [open, setOpen] = useState(false);
  if (!connector.searchCustomers) return null;
  const customer = sale.order.customer;
  return (
    <View className="gap-2 p-3">
      {customer ? (
        <View className="flex-row items-center justify-between gap-2">
          <Text testID="sale-customer" className="flex-1 text-sm">Customer: {customer.name}</Text>
          <Button testID="customer-remove" variant="secondary" size="sm" disabled={sale.saving} onPress={() => sale.setCustomer(null)}>
            <Text>Remove</Text>
          </Button>
        </View>
      ) : (
        <Button testID="customer-add" disabled={sale.saving} onPress={() => setOpen(!open)}>
          <Text>Add customer</Text>
        </Button>
      )}
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
