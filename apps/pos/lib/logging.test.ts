import { afterEach, expect, it, vi } from 'vitest';
import { outboxLogger, saleLogger } from '@tallyui/pos';
import { installLogSinks, POS_LOGGERS } from './logging';

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
