import { afterEach, expect, it, vi } from 'vitest';
import { outboxLogger, registerSessionsLogger, saleLogger, type LogLevel } from '@tallyui/pos';
import { installLogSinks, POS_LOGGERS } from './logging';
import { clearLogEntries, logEntries } from './log-buffer';

afterEach(() => vi.restoreAllMocks());

it("each POS logger's warnings and errors reach the console once installed", () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  installLogSinks();
  for (const logger of POS_LOGGERS) {
    logger.warn('w', { a: 1 });
    logger.error('e');
  }
  expect(warn).toHaveBeenCalledTimes(POS_LOGGERS.length);
  expect(warn).toHaveBeenNthCalledWith(1, '[sale]', 'w', { a: 1 });
  expect(error).toHaveBeenCalledTimes(POS_LOGGERS.length);
});

it('debug and info are not written', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  installLogSinks();
  saleLogger.debug('d');
  saleLogger.info('i');
  expect(log).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

it('installing twice writes each entry once', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  installLogSinks();
  installLogSinks();
  outboxLogger.error('x');
  expect(error).toHaveBeenCalledTimes(1);
});

it('every level of every POS logger reaches the sync log once, however often installed', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  clearLogEntries();
  installLogSinks();
  installLogSinks();
  expect(POS_LOGGERS).toContain(registerSessionsLogger);
  for (const level of ['debug', 'info', 'warn', 'error'] as LogLevel[]) {
    clearLogEntries();
    for (const logger of POS_LOGGERS) logger[level]('event');
    expect(logEntries()).toHaveLength(POS_LOGGERS.length);
    expect(logEntries().every((entry) => entry.level === level)).toBe(true);
    expect(new Set(logEntries().map(({ scope }) => scope)).size).toBe(POS_LOGGERS.length);
  }
});
