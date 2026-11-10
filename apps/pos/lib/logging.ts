import {
  callbackSink, consoleSink, type Logger, saleLogger, outboxLogger, posOrdersLogger,
  taxLogger, registerCommandsLogger, registerFactsLogger, registerSessionsLogger,
} from '@tallyui/pos';
import { keepLogEntry } from './log-buffer';

/** TallyUI's POS loggers whose warnings and errors this app keeps (#82 item 5). */
export const POS_LOGGERS: readonly Logger[] = [
  saleLogger, outboxLogger, posOrdersLogger, taxLogger, registerCommandsLogger, registerFactsLogger, registerSessionsLogger,
];
const LOG_SINK_ID = 'vendurepos-console';
const LOG_BUFFER_SINK_ID = 'vendurepos-log-buffer';

/** Adds the console sink (warn and error) and the sync log's (every level, redacted: `lib/log-buffer.ts`) to every POS
 *  logger; safe to call more than once. */
export function installLogSinks(): void {
  // The console gets warn and error only, because debug and info can carry whole command results; the sync log keeps
  // every level, redacted to ids, outcomes and error text (`lib/log-buffer.ts`).
  for (const logger of POS_LOGGERS) {
    logger.addSink(consoleSink({ id: LOG_SINK_ID, levels: ['warn', 'error'] }));
    logger.addSink(callbackSink({ id: LOG_BUFFER_SINK_ID, levels: ['debug', 'info', 'warn', 'error'], callback: keepLogEntry }));
  }
}
