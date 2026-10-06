import { createHttpCommandTransport } from '@tallyui/pos';
import { sessionContext, type Session } from './session';
import { MIN_ORDER_CREATE } from './use-sale-settings';

/** Pass a getter so a re-authenticated till sends with its new token: the outboxes build their transport once per open. */
export const orderTransport = (session: Session | (() => Session)) => {
  const current = typeof session === 'function' ? session : () => session;
  const transport = createHttpCommandTransport({ baseUrl: current().url, getHeaders: () => sessionContext(current()).headers });
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
