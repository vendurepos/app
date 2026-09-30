import type { OutboxState } from '@tallyui/pos';
import { describe, expect, it } from 'vitest';
import { registerSyncNotice } from './register-sync';

const state = (patch: Partial<OutboxState> = {}): OutboxState => ({ pending: 2, sending: false, ...patch });
// A stuck state whose commands' latest reasons are `reasons`, as the register outbox reports it after 15 minutes.
const stuck = (...reasons: string[]): OutboxState['stuck'] => ({
  commandIds: reasons.map((_, index) => `c${index}`), since: 0, reason: reasons.at(-1)!,
  orders: reasons.map((reason, index) => ({ commandId: `c${index}`, since: 0, reason })),
});

describe('registerSyncNotice', () => {
  it('shows nothing while till updates are only pending, sending or retrying', () => {
    expect(registerSyncNotice(state(), 0)).toBeUndefined();
    expect(registerSyncNotice(state({ sending: true, lastRetryReason: 'status_503', nextAttemptAt: 1 }), 0)).toBeUndefined();
  });

  it('shows nothing for a closure held behind its orders, even once the outbox counts it stuck', () => {
    expect(registerSyncNotice(state({ lastRetryReason: 'orders_pending' }), 0)).toBeUndefined();
    expect(registerSyncNotice(state({ lastRetryReason: 'orders_pending', stuck: stuck('orders_pending', 'orders_pending') }), 0))
      .toBeUndefined();
  });

  it('shows a stuck till update that keeps failing at the store, beside a held one', () => {
    expect(registerSyncNotice(state({ stuck: stuck('status_503') }), 0)).toBe(
      "Till updates aren't reaching the online store. Keep selling: they're saved on this till and will send by themselves.");
    expect(registerSyncNotice(state({ stuck: stuck('orders_pending', 'no_progress') }), 0)).toMatch(/^Till updates aren't reaching/);
  });

  it('shows a refused send', () => {
    expect(registerSyncNotice(state({ refused: { status: 422, reason: 'test' } }), 0)).toBe('2 till updates waiting to sync · The '
      + 'online store refused the last send. This till will try again with the next till update, or when the app is reopened.');
  });

  it('shows a sign-in the store refused, first', () => {
    expect(registerSyncNotice(state({ authRequired: true, refused: { status: 422, reason: 'test' }, stuck: stuck('status_503') }), 1))
      .toBe("Till updates aren't sending: this till needs to sign in to the online store again.");
  });

  it('shows till updates the store rejected, which the outbox state never carries', () => {
    expect(registerSyncNotice(state(), 1)).toBe('1 till update needs attention · The online store refused it, and later till updates '
      + "wait behind it. Ask the store owner to look at the till's sync log.");
    expect(registerSyncNotice(state({ refused: { status: 422, reason: 'test' } }), 2)).toMatch(/^2 till updates need attention · .* them,/);
  });
});
