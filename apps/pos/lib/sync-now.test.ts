import { expect, it, vi } from 'vitest';
import { syncNow } from './sync-now';

it('refreshes the catalogue once and flushes each outbox once', async () => {
  const refresh = vi.fn();
  const outboxes = [{ flush: vi.fn(async () => {}) }, { flush: vi.fn(async () => {}) }];
  await syncNow(outboxes, refresh);
  expect(refresh).toHaveBeenCalledTimes(1);
  for (const outbox of outboxes) {
    expect(outbox.flush).toHaveBeenCalledTimes(1);
    expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(outbox.flush.mock.invocationCallOrder[0]);
  }
});

it('resolves only once every outbox has settled', async () => {
  let resolve!: () => void;
  const pending = new Promise<void>((done) => { resolve = done; });
  const outboxes = [{ flush: vi.fn(() => pending) }, { flush: vi.fn(async () => {}) }];
  const settled = vi.fn();
  const result = syncNow(outboxes, vi.fn()).then(settled);
  await Promise.resolve();
  expect(outboxes[0].flush).toHaveBeenCalledTimes(1);
  expect(outboxes[1].flush).toHaveBeenCalledTimes(1);
  expect(settled).not.toHaveBeenCalled();
  resolve();
  await result;
  expect(settled).toHaveBeenCalledTimes(1);
});

it('resolves when an outbox send rejects', async () => {
  const outboxes = [
    { flush: vi.fn(async () => { throw new Error('Send refused'); }) },
    { flush: vi.fn(async () => {}) },
  ];
  await expect(syncNow(outboxes, vi.fn())).resolves.toBeUndefined();
  for (const outbox of outboxes) expect(outbox.flush).toHaveBeenCalledTimes(1);
});
