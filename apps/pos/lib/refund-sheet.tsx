import { useEffect, useRef, useState, type JSX } from 'react';
import { Button, HStack, Input, InputField, Label, Switch, Text, VStack } from '@tallyui/components';
import { vendureRefundable, type VendureOrder } from '@tallyui/connector-vendure';
import { formatMoney, type OrderRefundEnvelope, type ServerCapabilities } from '@tallyui/core';
import { mintUuid, type PosRefundCollection, type RegisterSession } from '@tallyui/pos';
import { orderTransport } from './order-transport';
import { tillIdentity, type Session } from './session';
import { SignInAgain } from './sign-in-again';
import { buildRefundEnvelope, pendingRefund, refundMessage, refundTotalMinor, sendTillRefund, type RefundMessage } from './till-refund';

export const REFUND_NEEDS_REGISTER_TEXT = 'Open the register to refund this order.';
export const REFUND_FAILED_TEXT = "Can't send this refund. Check the quantities and try again.";

/** A whole number from 0 to max, empty meaning 0 (Number('') is 0); null when it is anything else. */
function parseQuantity(text: string, max: number): number | null {
  const trimmed = text.trim();
  return /^\d*$/.test(trimmed) && Number(trimmed) <= max ? Number(trimmed) : null;
}

/** The till's refund of an order's items to their original payment, in OrderSheet's footer. */
export function RefundSheet({ order, session, refunds, registerSession, deviceId, capabilities, onRefunded }: {
  order: VendureOrder; session: Session; refunds: PosRefundCollection | null;
  registerSession: RegisterSession | null; deviceId: string; capabilities: ServerCapabilities | undefined;
  onRefunded(): void;
}): JSX.Element | null {
  const [formOpen, setFormOpen] = useState(false);
  const [quantityText, setQuantityText] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<RefundMessage | null>(null);
  // The envelope "Send again" resends; while it is set the form and the start button stay hidden.
  const [resend, setResend] = useState<OrderRefundEnvelope | null>(null);
  // One refund per opened form: every tap of Refund sends these ids, so a repeat is the same refund, never a second.
  const [ids, setIds] = useState<{ id: string; clientRefundId: string } | null>(null);
  const mintIds = () => setIds({ id: mintUuid(), clientRefundId: mintUuid() });
  // Set before the first await, so a second tap before React re-renders (and disables the button) sends nothing.
  const inFlight = useRef(false);

  useEffect(() => {
    setFormOpen(false);
    setMessage(null);
    setResend(null);
    if (!refunds) return;
    let cancelled = false;
    void pendingRefund(refunds, order.id).then((record) => {
      if (cancelled || !record) return;
      setMessage(refundMessage({ kind: 'pending', record }, order.currencyCode));
      setResend(record.envelope);
    }, () => {
      if (!cancelled) setMessage({ text: REFUND_FAILED_TEXT, sendAgain: false, signInAgain: false, done: false });
    });
    return () => { cancelled = true; };
  }, [refunds, order.id, order.currencyCode]);

  if ((capabilities?.orderRefund ?? 0) < 1 || !refunds || !order.customFields?.tallyClientOrderId) return null;

  const money = (amount: number) => formatMoney({ amount, currency: order.currencyCode }) ?? '';
  const names = new Map(order.lines.map((line) => [line.id, line.customFields?.tallyCustomName || line.productVariant.name]));
  const lines = vendureRefundable(order).lines.filter((line) => line.refundableQuantity > 0)
    .map((line) => ({ ...line, name: names.get(line.orderLineId) ?? '' }));
  const parsed = lines.map((line) => parseQuantity(quantityText[line.orderLineId] ?? '', line.refundableQuantity));
  const valid = parsed.every((quantity) => quantity !== null) && parsed.some((quantity) => (quantity ?? 0) > 0);
  const quantities: Record<string, number> = Object.fromEntries(lines.map((line, index) => [line.orderLineId, parsed[index] ?? 0]));

  // The plugin re-checks quantities, amount, session and permission: a wrong envelope is refused, never paid out.
  async function send(build: () => OrderRefundEnvelope) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    try {
      const envelope = build();
      const attempt = await sendTillRefund(refunds!, orderTransport(session), envelope);
      const next = refundMessage(attempt, order.currencyCode);
      setMessage(next);
      // The store refused that id, so the cashier's next try is a new refund.
      if (attempt.kind === 'answered' && attempt.outcome.kind === 'rejected') mintIds();
      // "Send again" is always the same envelope: the pending record's own, or the one just sent. Never a new id.
      setResend(next.sendAgain ? (attempt.kind === 'pending' ? attempt.record.envelope : envelope) : null);
      if (next.done) {
        setFormOpen(false);
        setQuantityText({});
        setReason('');
        setRestock(true);
        onRefunded();
      }
    } catch {
      setMessage({ text: REFUND_FAILED_TEXT, sendAgain: false, signInAgain: false, done: false });
      mintIds();
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  const submit = () => void send(() => {
    if (!registerSession) throw new Error('No register session');
    return buildRefundEnvelope(order, { quantities, reason, restock }, {
      sessionId: registerSession.id, registerId: registerSession.register_id, deviceId, cashierRef: tillIdentity(session),
    }, ids ?? undefined);
  });

  return (
    <VStack testID="refund-sheet" className="gap-2 border-t border-border p-4">
      {message ? <Text testID="refund-message">{message.text}</Text> : null}
      {message?.signInAgain ? <SignInAgain session={session} onSignedIn={() => {}} /> : null}
      {resend ? (
        <Button testID="refund-send-again" disabled={sending} onPress={() => void send(() => resend)}>
          <Text>Send again</Text>
        </Button>
      ) : null}
      {!resend && !formOpen && lines.length > 0 ? (
        registerSession?.status !== 'open' ? (
          <Text testID="refund-needs-register" className="text-sm text-muted-foreground">{REFUND_NEEDS_REGISTER_TEXT}</Text>
        ) : (
          <Button testID="refund-start" disabled={sending} onPress={() => { setMessage(null); mintIds(); setFormOpen(true); }}><Text>Refund items</Text></Button>
        )
      ) : null}
      {!resend && formOpen ? (
        <VStack testID="refund-form" className="gap-2">
          {lines.map((line) => (
            <VStack key={line.orderLineId} className="gap-1">
              <Text>{line.name}</Text>
              <Text className="text-sm text-muted-foreground">{`${line.refundableQuantity} left to refund`}</Text>
              <Input><InputField testID={`refund-qty-${line.orderLineId}`} accessibilityLabel={`Refund quantity for ${line.name}`}
                keyboardType="number-pad" value={quantityText[line.orderLineId] ?? ''}
                onChangeText={(text) => setQuantityText((current) => ({ ...current, [line.orderLineId]: text }))} /></Input>
            </VStack>
          ))}
          <HStack className="items-center gap-2">
            <Switch testID="refund-restock" checked={restock} onCheckedChange={setRestock} accessibilityLabel="Put the items back in stock" />
            <Label>Put the items back in stock</Label>
          </HStack>
          <Label nativeID="refund-reason-label">Reason</Label>
          <Input><InputField testID="refund-reason" value={reason} onChangeText={setReason}
            accessibilityLabel="Reason" accessibilityLabelledBy="refund-reason-label" /></Input>
          <Text testID="refund-total">{valid ? `Refund ${money(refundTotalMinor(order, quantities))}` : 'Pick the items to refund.'}</Text>
          <HStack className="gap-2">
            <Button testID="refund-submit" disabled={!valid || !reason.trim() || sending} onPress={submit}><Text>Refund</Text></Button>
            <Button testID="refund-cancel" variant="secondary" disabled={sending} onPress={() => setFormOpen(false)}><Text>Cancel</Text></Button>
          </HStack>
        </VStack>
      ) : null}
    </VStack>
  );
}
