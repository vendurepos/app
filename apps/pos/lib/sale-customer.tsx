import { useState } from 'react';
import { View } from 'react-native';
import { AddressEditor, Avatar, avatarInitials, Button, CustomerPicker, HStack, IconButton, Text, VStack, XIcon, type AddressEditorValue } from '@tallyui/components';
import type { TallyConnector } from '@tallyui/core';
import { ADDRESS_CHANGE_REFUSED, UNTAXED_ADDRESS_ORDER_CREATE_VERSION, type useSale } from '@tallyui/pos';
import { addressEditorValue } from './customer-edit';
import { isWalkIn } from './customer-list';
import { ADDRESS_ZONE_BLOCK_TEXT, saleAddresses, useSaleCountries, type TaxZone } from './sale-address';
import { sessionContext, type Session } from './session';
import { SlidersIcon } from './nav-icons';

export function SaleCustomer({ sale, connector, session, onSettings, orderCreate, taxZone }: {
  sale: ReturnType<typeof useSale>; connector: TallyConnector; session: Session;
  onSettings?: () => void;
  /** The store's order.create cap: the address pin shows from v11, which carries it to the store. */
  orderCreate?: number;
  /** /info's taxZone: while it is unknown the store could refuse a hand-added address after payment, so there is no Add or Edit. */
  taxZone?: TaxZone;
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
        {onSettings ? <>
          <View className="flex-1" />
          <IconButton testID="cart-settings-open" variant="ghost" size="sm" accessibilityLabel="Cart settings" onPress={onSettings}>
            <SlidersIcon size={18} />
          </IconButton>
        </> : null}
      </HStack>
      {/* A guest sale gets no pin: TallyUI keeps addresses on a picked customer only. */}
      {customer && (orderCreate ?? 0) >= UNTAXED_ADDRESS_ORDER_CREATE_VERSION
        ? <SaleAddress key={`${sale.order.id}|${customer.id}`} sale={sale} session={session} zoneKnown={!!taxZone} /> : null}
      {open ? (
        <View testID="customer-picker" className="rounded-md border border-border p-3">
          <CustomerPicker
            showAvatar
            withGuest
            search={(q) => connector.searchCustomers!(sessionContext(session), q, { limit: 20 }).then(results => results.filter(c => !isWalkIn(c)))}
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

/** The sale's address pin: shipping, else billing, with Edit and Remove in the cart; text only at any other stage. */
function SaleAddress({ sale, session, zoneKnown }: { sale: ReturnType<typeof useSale>; session: Session; zoneKnown: boolean }) {
  const { billing, shipping } = sale.order.customer ?? {};
  const shown = shipping ?? billing, editable = sale.stage.kind === 'cart' && !sale.saving;
  // Without the store's countries there is no Add or Edit: a free-text country would be refused after payment.
  const countries = useSaleCountries(session, editable);
  const [editing, setEditing] = useState<{ value: AddressEditorValue; error?: string } | null>(null);
  const save = (value: AddressEditorValue) => {
    const addresses = saleAddresses(value);
    if ('error' in addresses) return setEditing({ value, error: addresses.error });
    setEditing(sale.setAddresses(addresses.billing, addresses.shipping) ? null : { value, error: ADDRESS_CHANGE_REFUSED });
  };
  const canEdit = editable && zoneKnown && !!countries && !editing;
  if (!shown && !canEdit && !editing) return null;
  return (
    <VStack className="gap-2">
      <HStack className="items-center gap-2">
        {shown ? <Text testID="sale-address" numberOfLines={1} className="flex-1 text-sm text-muted-foreground">{[shown.address1, shown.city, shown.country].filter(Boolean).join(', ')}</Text> : null}
        {canEdit ? <Button testID={shown ? 'sale-address-edit' : 'sale-address-add'} variant="outline" size="sm"
          onPress={() => setEditing({ value: addressEditorValue({ billing, shipping }) })}><Text>{shown ? 'Edit' : 'Add address'}</Text></Button> : null}
        {shown && editable ? <Button testID="sale-address-remove" variant="ghost" size="sm"
          onPress={() => { sale.setAddresses(undefined, undefined); setEditing(null); }}><Text>Remove</Text></Button> : null}
      </HStack>
      {editing && editable ? (
        <View className="gap-2 rounded-md border border-border p-3">
          <AddressEditor testID="sale-address-editor" value={editing.value} onChange={(value) => setEditing({ value })} countries={countries} />
          {editing.error ? <Text testID="sale-address-error" accessibilityRole="alert" className="text-sm text-destructive">{editing.error}</Text> : null}
          <HStack space="sm">
            <Button testID="sale-address-save" size="sm" onPress={() => save(editing.value)}><Text>Save</Text></Button>
            <Button testID="sale-address-cancel" variant="outline" size="sm" onPress={() => setEditing(null)}><Text>Cancel</Text></Button>
          </HStack>
        </View>
      ) : null}
    </VStack>
  );
}

/** Checkout's place while the address is outside the till's tax zone on a store that taxes by address: not dismissible. */
export function AddressZoneGate({ sale }: { sale: ReturnType<typeof useSale> }) {
  return (
    <VStack className="gap-2 rounded-md border border-destructive bg-destructive/10 p-3">
      <Text testID="address-block" className="text-sm">{ADDRESS_ZONE_BLOCK_TEXT}</Text>
      <Button testID="address-block-remove" variant="secondary" size="sm" disabled={sale.saving}
        onPress={() => sale.setAddresses(undefined, undefined)}><Text>Remove address</Text></Button>
    </VStack>
  );
}
