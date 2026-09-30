import { createHttpCommandTransport } from '@tallyui/pos';
import { sessionContext, type Session } from './session';
import { MIN_ORDER_CREATE } from './use-sale-settings';

/** useOrderOutbox's transport: POST /tally/v1/commands on the session's store, with its Vendure auth headers. */
export const orderTransport = (session: Session) => {
  const transport = createHttpCommandTransport({ baseUrl: session.url, getHeaders: () => sessionContext(session).headers });
  return {
    async send(batch: Parameters<typeof transport.send>[0]) {
      const outcome = await transport.send(batch);
      if (outcome.kind !== 'results') return outcome;
      return { ...outcome, results: outcome.results.map((result) => {
        const error = result.error;
        const data = error?.data;
        if (result.status !== 'rejected' || error?.code !== 'unsupported_version' ||
          typeof data?.orderCreate !== 'number' || data.orderCreate >= MIN_ORDER_CREATE) return result;
        // order-outbox.ts prefers error.data.orderCreate; below v4 would bypass the net-discount rule.
        const safeData = { ...data };
        delete safeData.orderCreate;
        return { ...result, error: { ...error, data: safeData } };
      }) };
    },
  };
};
