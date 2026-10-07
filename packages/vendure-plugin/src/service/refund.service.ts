import { Injectable } from '@nestjs/common';
import {
  Cancellation, FulfillmentLine, Order, OrderLine, OrderService, Payment, Refund, RequestContext, StockMovementService, TransactionalConnection, idsAreEqual,
} from '@vendure/core';
import type { ID } from '@vendure/core';
import { tallyPosRefund } from '../config/permissions';
import { TALLY_PAYMENT_METHOD_CODE, withTallyRefund } from '../config/strategies';
import { TallyCommand } from '../entities/tally-command.entity';
import type { CommandResult, OrderRefundEnvelope, OrderRefundPayload, OrderRefundResult } from '../vendored/core-commands';
import { commandFingerprint } from '../vendored/fingerprint';
import { refundPayloadErrors } from '../vendored/refund-payload-shape';
import { ORDER_REFUND_VERSIONS } from './constants';
import { ErrorResultThrown, TransientCommandError, transientKind, unwrap } from './errors';
import { CREATED_AT_SKEW_MS, OrderCreateService, clientTimeErrors, nulPath } from './order-create.service';
import { RegisterService } from './register.service';
import { refundEnvelopeStrictErrors } from './strict-shape';

const refuse = (id: string, code: string, message: string, data?: Record<string, unknown>): CommandResult =>
  ({ id, status: 'rejected', error: { code, message, ...(data ? { data } : {}) } });

/** A contract refusal rolls back the claim and every write. */
class Unstored extends Error {
  constructor(readonly result: CommandResult) {
    super(result.error!.message);
  }
}

/** ADR 0007: one till refund, with the register lock before the order lock. */
@Injectable()
export class RefundService {
  constructor(
    private connection: TransactionalConnection,
    private orderService: OrderService,
    private stock: StockMovementService,
    private registers: RegisterService,
    private orders: OrderCreateService,
  ) {}

  async apply(ctx: RequestContext, command: OrderRefundEnvelope<Record<string, unknown>>, options: { requestTimeMs?: number } = {}): Promise<CommandResult> {
    const { id, version } = command;
    const nul = nulPath(command, '');
    if (nul) return refuse(id, 'invalid_payload', `${nul}: must not contain U+0000`);
    if (!ORDER_REFUND_VERSIONS.includes(version)) {
      return refuse(id, 'unsupported_version',
        `order.refund version ${version} is not supported; this server supports ${ORDER_REFUND_VERSIONS.join(', ')}`,
        { orderRefund: Math.max(...ORDER_REFUND_VERSIONS) });
    }
    const shape = refundPayloadErrors(command.payload);
    if (shape.length) return refuse(id, 'invalid_payload', shape.join('; '));
    const payload = command.payload as unknown as OrderRefundPayload;
    const { totalMinor, shippingMinor, adjustmentMinor } = payload;
    let claimed = false;
    try {
      const existing = await this.connection.getRepository(ctx, TallyCommand).findOneBy({ id });
      if (existing) return this.registers.replayAnswer(ctx, command, existing);
      const strict = refundEnvelopeStrictErrors(command as unknown as Record<string, unknown>, version);
      if (strict.length) return refuse(id, 'invalid_payload', strict.join('; '));
      const times = clientTimeErrors([['createdAt', command.createdAt], ['payload.createdAt', payload.createdAt]],
        (options.requestTimeMs ?? Date.now()) + CREATED_AT_SKEW_MS);
      if (times.length) return refuse(id, 'invalid_payload', times.slice(0, 10).join('; '));
      if (!ctx.userHasPermissions([tallyPosRefund.Permission])) return refuse(id, 'forbidden', 'TallyPosRefund is required to refund');
      return await this.connection.withTransaction(ctx, async tx => {
        const concurrent = await this.registers.claim(tx, command);
        if (concurrent) return concurrent;
        claimed = true;
        await this.registers.lockRegister(tx, payload.registerId);
        const session = await this.registers.openSessionFor(tx, payload.sessionId, payload.registerId);
        if (!session) throw new Unstored(refuse(id, 'no_open_session',
          `Session ${payload.sessionId} is not open on register ${payload.registerId}`, { sessionId: payload.sessionId }));
        const tallyRefund = {
          clientRefundId: payload.clientRefundId, registerId: payload.registerId, sessionId: session.id,
          ...(payload.cashierRef === undefined ? {} : { cashierRef: payload.cashierRef }), destination: payload.destination,
          lines: [],
        };
        withTallyRefund(tx, tallyRefund);

        const orderId = this.orders.decodeId(payload.orderId);
        const locked = orderId === undefined ? undefined : await this.connection.getRepository(tx, Order)
          .createQueryBuilder('order').setLock('pessimistic_write').where('order.id = :id', { id: orderId }).getOne();
        const order = locked ? await this.orderService.findOne(tx, locked.id) : undefined;
        if (!order) throw new Unstored(refuse(id, 'invalid_payload', `orderId: no order ${payload.orderId} in this channel`));
        if (payload.clientOrderId !== undefined && payload.clientOrderId !== order.customFields.tallyClientOrderId) {
          throw new Unstored(refuse(id, 'invalid_payload', `clientOrderId: order ${payload.orderId} is ${order.customFields.tallyClientOrderId}`));
        }
        const earlier = await this.connection.getRepository(tx, Refund).createQueryBuilder('refund')
          .innerJoin('refund.payment', 'payment')
          .innerJoin('payment.order', 'sale')
          .innerJoin('sale.channels', 'channel')
          .where('channel.id = :channelId', { channelId: tx.channelId })
          .andWhere('refund.state != :failed', { failed: 'Failed' })
          .andWhere("CAST(refund.metadata AS jsonb) ->> 'tallyClientRefundId' = :clientRefundId", { clientRefundId: payload.clientRefundId })
          .orderBy('refund.id', 'ASC').getOne();
        if (earlier) throw new Unstored(refuse(id, 'invalid_payload',
          `clientRefundId: ${payload.clientRefundId} is already refund ${this.orders.encodeId(earlier.id)}`));
        if (!order.customFields.tallyClientOrderId || order.customFields.tallyRejected) {
          throw new Unstored(refuse(id, 'not_till_order', `Order ${payload.orderId} was not taken at a till`));
        }
        if (!['PaymentSettled', 'PartiallyShipped', 'Shipped', 'PartiallyDelivered', 'Delivered'].includes(order.state)) {
          throw new Unstored(refuse(id, 'order_state', `Order ${payload.orderId} is ${order.state} and cannot be refunded`, { state: order.state }));
        }
        const payments = await this.connection.getRepository(tx, Payment).find({
          where: { order: { id: order.id } }, relations: ['refunds', 'refunds.lines'], order: { id: 'ASC' },
        });
        const previous = payments.flatMap(payment => payment.refunds).filter(refund => refund.state !== 'Failed');
        const lines = payload.lines.map((input, index) => {
          const decoded = this.orders.decodeId(input.orderLineId);
          const line = decoded === undefined ? undefined : order.lines.find(line => idsAreEqual(line.id, decoded));
          if (!line) throw new Unstored(refuse(id, 'invalid_payload',
            `lines[${index}].orderLineId: no line ${input.orderLineId} on order ${payload.orderId}`));
          return { input, line };
        });
        const refundedOf = (line: OrderLine) => previous.flatMap(refund => refund.lines)
          .filter(refundLine => idsAreEqual(refundLine.orderLineId, line.id)).reduce((sum, refundLine) => sum + refundLine.quantity, 0);
        // ADR 0007: a line's share of its total, so a whole line is the line total and partial refunds add up to it.
        const shareOf = (line: OrderLine, quantity: number) => {
          if (line.quantity === 0) return 0;
          const before = refundedOf(line);
          return Math.round((before + quantity) * line.proratedLinePriceWithTax / line.quantity)
            - Math.round(before * line.proratedLinePriceWithTax / line.quantity);
        };
        const over = lines.map(({ input, line }) => ({
          orderLineId: input.orderLineId, quantity: input.quantity,
          refundableQuantity: line.quantity - refundedOf(line),
        })).filter(line => line.quantity > line.refundableQuantity);
        if (over.length) throw new Unstored(refuse(id, 'quantity_exceeds',
          'A refunded quantity is more than the line has left to refund', { lines: over }));
        if (!lines.length && shippingMinor === 0 && adjustmentMinor === 0) throw new Unstored(refuse(id, 'nothing_to_refund', 'Nothing to refund'));
        const refundableShipping = order.shippingWithTax - previous.reduce((sum, refund) => sum + refund.shipping, 0);
        const remainderOf = (payment: Payment) => Math.max(0, payment.amount - payment.refunds
          .filter(refund => refund.state !== 'Failed').reduce((sum, refund) => sum + refund.total, 0));
        const tenders = payments.filter(payment => payment.method === TALLY_PAYMENT_METHOD_CODE && payment.state === 'Settled');
        const moneyRemainder = tenders.reduce((sum, payment) => sum + remainderOf(payment), 0);
        const raw = lines.reduce((sum, { input, line }) => sum + shareOf(line, input.quantity), 0) + shippingMinor + adjustmentMinor;
        const server = Math.min(Math.max(raw, 0), moneyRemainder);
        if (shippingMinor > refundableShipping || raw !== server || server !== totalMinor) {
          throw new Unstored(refuse(id, 'amount_mismatch', `Refund total ${totalMinor} does not match the server's ${server}`,
            { expectedMinor: totalMinor, serverMinor: server }));
        }
        if (server === 0) throw new Unstored(refuse(id, 'nothing_to_refund', 'Nothing to refund'));

        const refunds: OrderRefundResult['refunds'] = [];
        const byMethod: Record<string, number> = {};
        let left = server;
        for (const payment of tenders) {
          const share = Math.min(left, remainderOf(payment));
          if (share === 0) continue;
          withTallyRefund(tx, { ...tallyRefund,
            lines: refunds.length ? [] : lines.map(({ input, line }) => ({ orderLineId: String(line.id), quantity: input.quantity })),
          });
          const refund = unwrap(await this.orderService.refundOrder(tx, {
            paymentId: payment.id, amount: share, reason: payload.reason,
            lines: refunds.length ? [] : lines.map(({ input, line }) => ({ orderLineId: line.id, quantity: input.quantity })),
            shipping: refunds.length ? 0 : shippingMinor, adjustment: 0,
          }));
          refunds.push({ id: this.orders.encodeId(refund.id), paymentId: this.orders.encodeId(payment.id), totalMinor: refund.total, state: refund.state });
          const method = refund.metadata.tallyMethod;
          byMethod[method] = (byMethod[method] ?? 0) + refund.total;
          left -= share;
          if (left === 0) break;
        }
        const restock: Array<{ orderLineId: ID; quantity: number }> = [];
        for (const { input, line } of lines) {
          if (!input.restock) continue;
          const fulfilled = await this.connection.getRepository(tx, FulfillmentLine).find({ where: { orderLineId: line.id } });
          const cancelled = await this.connection.getRepository(tx, Cancellation).find({ where: { orderLine: { id: line.id } } });
          const quantity = Math.min(input.quantity, fulfilled.reduce((sum, item) => sum + item.quantity, 0)
            - cancelled.reduce((sum, item) => sum + item.quantity, 0));
          if (quantity > 0) restock.push({ orderLineId: line.id, quantity });
        }
        if (restock.length) await this.stock.createCancellationsForOrderLines(tx, restock);
        const result: CommandResult = { id, status: 'applied', refund: { totalMinor: server, byMethod, refunds } };
        await this.connection.getRepository(tx, TallyCommand).update(id, { status: result.status, result: { ...result } });
        return result;
      });
    } catch (error) {
      if (error instanceof Unstored) return error.result;
      if (error instanceof ErrorResultThrown) {
        const { errorCode, message } = error.result;
        const result = refuse(id, 'platform_error', `${errorCode}: ${message}`, { platformCode: errorCode, platformMessage: message });
        try {
          return await this.connection.withTransaction(ctx, async tx => {
            const repository = this.connection.getRepository(tx, TallyCommand);
            const runner = repository.manager.queryRunner!;
            const table = repository.metadata.tablePath.split('.').map(part => runner.connection.driver.escape(part)).join('.');
            const rows = await runner.query(`INSERT INTO ${table} ("id", "channelId", "fingerprint", "status", "result")
              VALUES ($1, $2, $3, 'rejected', $4) ON CONFLICT (id) DO NOTHING RETURNING id`,
            [id, String(tx.channelId), commandFingerprint(command as never), JSON.stringify(result)]);
            return rows.length ? result : this.registers.replayAnswer(tx, command, await repository.findOneByOrFail({ id }));
          });
        } catch (storeError) {
          error = storeError;
        }
      }
      const kind = transientKind(error);
      throw new TransientCommandError(id, kind === 'lock' && claimed ? 'timeout' : kind ?? 'unclassified', error);
    }
  }
}
