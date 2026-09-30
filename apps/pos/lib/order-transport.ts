import { createHttpCommandTransport } from '@tallyui/pos';
import { sessionContext, type Session } from './session';

/** useOrderOutbox's transport: POST /tally/v1/commands on the session's store, with its Vendure auth headers. */
export const orderTransport = (session: Session) =>
  createHttpCommandTransport({ baseUrl: session.url, getHeaders: () => sessionContext(session).headers });
