import type { OutboxState } from '@tallyui/pos';
import { describe, expect, it } from 'vitest';
import { accessRefused } from './access-refused';
import { POS_ACCESS_REFUSED_TEXT } from './sign-in';
import { SESSION_ENDED_TEXT } from './use-catalogue';

const state = (patch: Partial<OutboxState> = {}): OutboxState => ({ pending: 0, sending: false, ...patch });

describe('accessRefused', () => {
  it('recognises the catalogue sign-in words without outboxes', () => {
    expect(accessRefused(POS_ACCESS_REFUSED_TEXT)).toBe(true);
  });

  it('recognises a refused 403 in either outbox', () => {
    const refused = state({ refused: { status: 403, reason: 'Forbidden' } });
    expect(accessRefused(null, refused, state())).toBe(true);
    expect(accessRefused(null, state(), refused)).toBe(true);
  });

  it('does not treat other refusals, ended sessions or clean states as access refused', () => {
    expect(accessRefused(null, state({ refused: { status: 422, reason: 'test' } }))).toBe(false);
    expect(accessRefused(null, state({ authRequired: true }))).toBe(false);
    expect(accessRefused(SESSION_ENDED_TEXT)).toBe(false);
    expect(accessRefused(null, state(), state())).toBe(false);
  });
});
