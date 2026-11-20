import type { LogEntry, LogLevel } from '@tallyui/pos';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  clearLogEntries, filterLogEntries, formatLogLine, keepLogEntry, LOG_BUFFER_SIZE, logActorName, logCopyText,
  logEntries, markLogSeen, redactLogData, subscribeLogEntries, unreadErrorCount,
} from './log-buffer';

const entry = (patch: Partial<LogEntry> = {}): LogEntry => ({
  level: 'debug', scope: 'register-commands', message: 'Register command result', timestamp: 0, ...patch,
});
beforeEach(() => clearLogEntries());

it('counts errors kept since the log was last seen, never warnings', () => {
  markLogSeen();
  for (const level of ['info', 'warn', 'error', 'error'] as LogLevel[]) keepLogEntry(entry({ level }));
  expect(unreadErrorCount()).toBe(2);
  markLogSeen();
  expect(unreadErrorCount()).toBe(0);
  keepLogEntry(entry({ level: 'error' }));
  keepLogEntry(entry({ level: 'warn' }));
  expect(unreadErrorCount()).toBe(1);
});

it('marking the log seen notifies once, and not when nothing is new', async () => {
  markLogSeen();
  const listener = vi.fn();
  const unsubscribe = subscribeLogEntries(listener);
  keepLogEntry(entry({ level: 'error' }));
  await Promise.resolve();
  listener.mockClear();
  markLogSeen();
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(1);
  markLogSeen();
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
});

it('keeps entries newest first and only the last 500', () => {
  for (let i = 0; i < 501; i++) keepLogEntry(entry({ message: `event ${i}` }));
  const kept = logEntries();
  expect(LOG_BUFFER_SIZE).toBe(500);
  expect(kept).toHaveLength(500);
  expect(kept[0].message).toBe('event 500');
  expect(kept[499].message).toBe('event 1');
  expect(kept.some(({ message }) => message === 'event 0')).toBe(false);
  expect(kept[0].id - kept[499].id).toBe(499);
  expect(kept[0]).not.toHaveProperty('data');
});

it('keeps the same snapshot until an entry is kept', () => {
  const empty = logEntries();
  expect(logEntries()).toBe(empty);
  const original = entry({ data: { key: 'k1' } });
  keepLogEntry(original);
  const kept = logEntries();
  expect(kept).not.toBe(empty);
  expect(logEntries()).toBe(kept);
  expect(kept[0]).not.toBe(original);
  original.message = 'changed';
  original.data!.key = 'changed';
  expect(kept[0]).toMatchObject({ message: 'Register command result', data: { key: 'k1' } });
  clearLogEntries();
  expect(logEntries()).not.toBe(kept);
  expect(logEntries()).toEqual([]);
  expect(kept).toHaveLength(1);
});

it("keeps a register command result's key and outcome, never its figures", () => {
  expect(redactLogData({ key: 'k1', result: {
    id: 'c1', status: 'applied', register: { session: { id: 's', status: 'open', expected: { cash: 1000 } } },
    serverRefs: { id: 'secret' }, warnings: ['secret'], refund: { amount: 1000 },
  } })).toEqual({ key: 'k1', status: 'applied' });
  expect(redactLogData({ key: 'k1', result: {
    status: 'rejected', error: { code: 'register_session_already_open', message: 'test refusal', data: { sessionId: 's' } },
  } })).toEqual({ key: 'k1', status: 'rejected', errorCode: 'register_session_already_open', error: 'test refusal' });
  expect(redactLogData({ status: false, error: 'top', result: { status: 'rejected', error: { message: 'nested' } } }))
    .toEqual({ status: false, error: 'top' });
  expect(redactLogData({ result: ['applied'] })).toBeUndefined();
});

it('keeps error text from cause, error and a context object, and drops other data', () => {
  expect(redactLogData({ cause: new Error('boom'), ids: ['a'] })).toEqual({ cause: 'boom' });
  expect(redactLogData({ context: { registerId: 'r1', error: 'x', extra: { a: 1 } } })).toEqual({ registerId: 'r1', error: 'x' });
  expect(redactLogData({ fields: [1], taxClass: 'standard', database: 'db' })).toEqual({ taxClass: 'standard' });
  expect(redactLogData({ ids: ['a'] })).toBeUndefined();
  expect(redactLogData(undefined)).toBeUndefined();
  expect(redactLogData({ error: new Error('failed'), cause: 'why', from: 0, to: 2, status: true, payload: 'secret' }))
    .toEqual({ from: 0, to: 2, status: true, error: 'failed', cause: 'why' });
  expect(redactLogData({ registerId: 'top', error: 'top error', context: { registerId: 'nested', error: 'nested error' } }))
    .toEqual({ registerId: 'top', error: 'top error' });
  expect(redactLogData({ registerId: null, error: {}, cause: [], context: { registerId: 'nested', error: 'nested' } }))
    .toBeUndefined();
  expect(redactLogData({ orderId: {}, paymentId: [], sessionId: null, method: undefined, context: new Error('hidden') }))
    .toBeUndefined();
});

it('masks emails and bearer tokens and shortens long text', () => {
  const sensitive = 'alice@example.com bob@example.org Bearer secret bearer another';
  const masked = '[email] [email] Bearer [redacted] Bearer [redacted]';
  keepLogEntry(entry({ message: sensitive, data: { reason: sensitive, cause: new Error(sensitive), error: sensitive } }));
  expect(logEntries()[0]).toMatchObject({ message: masked, data: { reason: masked, cause: masked, error: masked } });
  expect(redactLogData({ result: { status: sensitive, error: { code: sensitive, message: sensitive } } }))
    .toEqual({ status: masked, errorCode: masked, error: masked });
  const shortened = redactLogData({ reason: 'a'.repeat(300) })!.reason;
  expect(shortened).toHaveLength(200);
  expect(shortened).toBe('a'.repeat(199) + '…');
  expect(redactLogData({ reason: 'a'.repeat(200) })!.reason).toBe('a'.repeat(200));
  expect(redactLogData({ reason: 'a'.repeat(195) + ' Bearer secret' })!.reason).toBe('a'.repeat(195) + ' Bea…');
});

it('filters All, Actions and Errors presets', () => {
  for (const level of ['debug', 'info', 'warn', 'error'] as LogLevel[]) keepLogEntry(entry({ level }));
  keepLogEntry(entry({ level: 'info', actor: { id: 'c1', name: 'Ann' } }));
  keepLogEntry(entry({ level: 'debug', actor: { id: '', name: '' } }));
  const list = logEntries();
  expect(filterLogEntries(list, 'all')).toBe(list);
  expect(filterLogEntries(list, 'errors')).toEqual([list[2]]);
  expect(filterLogEntries(list, 'actions')).toEqual([list[1]]);
  expect(list[0]).not.toHaveProperty('actor');
});

it('keeps only the actor id and name, unmasked and bounded, for display', () => {
  keepLogEntry(entry({ actor: { id: 'c1', name: 'ann@example.com', role: 'cashier' } }));
  expect(logEntries()[0].actor).toEqual({ id: 'c1', name: 'ann@example.com' });
  expect(logActorName(logEntries()[0])).toBe('ann@example.com');
  keepLogEntry(entry({ actor: { name: 'a'.repeat(300) } }));
  expect(logEntries()[0].actor?.name).toHaveLength(200);
  expect(logEntries()[0].actor?.name).toBe('a'.repeat(199) + '…');
  keepLogEntry(entry({ actor: { id: 'c1' } }));
  expect(logActorName(logEntries()[0])).toBe('c1');
  keepLogEntry(entry());
  expect(logEntries()[0]).not.toHaveProperty('actor');
  expect(logActorName(logEntries()[0])).toBeNull();
});

it('omits the actor from formatted lines and Copy/Share text', () => {
  keepLogEntry(entry({ actor: { id: 'c1', name: 'ann@example.com' } }));
  for (const text of [formatLogLine(logEntries()[0]), logCopyText(logEntries())]) {
    expect(text).not.toContain('ann@example.com');
    expect(text).not.toContain('c1');
  }
});

it('formats one line per entry, newest first, with ISO times for copying', () => {
  keepLogEntry(entry({ level: 'info', message: 'Ready' }));
  keepLogEntry(entry({ timestamp: 1000, data: { key: 'k1', result: {
    status: 'rejected', error: { code: 'register_session_already_open', message: 'test refusal' },
  } } }));
  const line = 'DEBUG [register-commands] Register command result key=k1 status=rejected errorCode=register_session_already_open error=test refusal';
  expect(formatLogLine(logEntries()[0])).toBe(line);
  expect(logCopyText(logEntries())).toBe(`1970-01-01T00:00:01.000Z ${line}\n1970-01-01T00:00:00.000Z INFO [register-commands] Ready`);
  expect(logCopyText([])).toBe('');
});

it('notifies a subscriber once per tick, after the change, and not after unsubscribing', async () => {
  await Promise.resolve();
  const listener = vi.fn(() => logEntries());
  const unsubscribe = subscribeLogEntries(listener);
  keepLogEntry(entry());
  keepLogEntry(entry());
  expect(logEntries()).toHaveLength(2);
  expect(listener).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveReturnedWith(logEntries());
  clearLogEntries();
  expect(listener).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(2);
  expect(listener).toHaveLastReturnedWith([]);
  keepLogEntry(entry());
  unsubscribe();
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(2);
});
