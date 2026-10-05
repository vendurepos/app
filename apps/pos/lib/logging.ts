import {
  consoleSink, type Logger, saleLogger, outboxLogger, posOrdersLogger,
  taxLogger, registerCommandsLogger, registerFactsLogger,
} from '@tallyui/pos';

/** TallyUI's POS loggers whose warnings and errors this app keeps (#82 item 5). */
export const POS_LOGGERS: readonly Logger[] = [
  saleLogger, outboxLogger, posOrdersLogger, taxLogger, registerCommandsLogger, registerFactsLogger,
];
export const LOG_SINK_ID = 'vendurepos-console';

/** Adds the console sink (warn and error only) to every POS logger; safe to call more than once. */
export function installLogSinks(): void {
  // Debug and info are left out because they can carry whole command results.
  for (const logger of POS_LOGGERS) {
    logger.addSink(consoleSink({ id: LOG_SINK_ID, levels: ['warn', 'error'] }));
  }
}
