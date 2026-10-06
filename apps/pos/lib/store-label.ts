import { DEMO_STORE_NAME } from './demo/fetch';
import { DEMO_MODE } from './demo/mode';
import type { Session } from './session';

/** The store's name on the till's header, receipt and Z report: the demo store's name in the demo build, else the store URL. */
export function storeLabel(session: Pick<Session, 'url'>, demo: boolean = DEMO_MODE): string {
  return demo ? DEMO_STORE_NAME : session.url;
}
