import { expect, it } from 'vitest';
import { ConnectorUnauthorizedError } from '@tallyui/core';
import { ORDER_HISTORY_FAILED_TEXT, ORDER_HISTORY_FORBIDDEN_TEXT, orderHistoryNotice } from './order-history';
import { SESSION_ENDED_TEXT } from './use-catalogue';

it('reports missing Read order permission without a retry', () => {
  expect(orderHistoryNotice(new ConnectorUnauthorizedError('x', 403)))
    .toEqual({ text: ORDER_HISTORY_FORBIDDEN_TEXT, retry: false });
});

it('reports an ended session without a retry', () => {
  expect(orderHistoryNotice(new ConnectorUnauthorizedError('x', 401)))
    .toEqual({ text: SESSION_ENDED_TEXT, retry: false });
});

it('offers a retry for other history failures', () => {
  expect(orderHistoryNotice(new Error('boom'))).toEqual({ text: ORDER_HISTORY_FAILED_TEXT, retry: true });
});
