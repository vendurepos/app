import { matchesPresetFilters, presetFilters, type LogEntry, type LogLevel, type LogPreset } from '@tallyui/pos';

/** How many entries the till keeps in memory, newest first. */
export const LOG_BUFFER_SIZE = 500;
export type KeptLogData = Record<string, string | number | boolean>;
export interface KeptLogEntry { id: number; level: LogLevel; scope: string; message: string; data?: KeptLogData; timestamp: number; actor?: { id?: string; name?: string } }
export type LogFilter = LogPreset;

// The only data keys kept as they are: ids and short values, never figures or customer details.
const KEPT_KEYS = ['orderId', 'commandId', 'storedCommandId', 'recordedCommandId', 'paymentId', 'sessionId', 'registerId', 'key', 'type', 'taxClass', 'from', 'to', 'stage', 'reason', 'method', 'status'];
// The longest kept text, in characters, after scrubbing.
const MAX_TEXT = 200;

const scrub = (s: string): string => s.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');

function text(s: string): string {
  const clean = scrub(s);
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** An allow-list: ids, outcomes and error text from `data` (and its `context`), and a refused order's code and message,
 * since the refusal sentence points the owner at this log; everything else is dropped. */
export function redactLogData(data: Record<string, unknown> | undefined): KeptLogData | undefined {
  if (!data) return undefined;
  // A top-level key wins over the same key in `context`.
  const source = { ...(isPlainObject(data.context) ? data.context : {}), ...data };
  const kept: KeptLogData = {};
  for (const key of KEPT_KEYS) {
    const value = source[key];
    if (typeof value === 'string') kept[key] = text(value);
    else if (typeof value === 'number' || typeof value === 'boolean') kept[key] = value;
  }
  for (const key of ['error', 'cause']) {
    const value = source[key];
    if (value instanceof Error) kept[key] = text(value.message);
    else if (typeof value === 'string') kept[key] = text(value);
  }
  // A register command result keeps its outcome only: never its register figures, server refs, warnings or refund.
  if (isPlainObject(source.result)) {
    const { status, error } = source.result;
    if (kept.status === undefined && typeof status === 'string') kept.status = text(status);
    if (isPlainObject(error)) {
      if (typeof error.code === 'string') kept.errorCode = text(error.code);
      if (kept.error === undefined && typeof error.message === 'string') kept.error = text(error.message);
    }
  }
  // The outbox's refusal ({ orderId, code, message }) keeps its code and message: the till's refusal sentence sends the
  // owner to this log. All three are needed, so a bare `code` (a display pairing code) is never kept.
  const { orderId, code, message } = source;
  if (typeof orderId === 'string' && typeof code === 'string' && typeof message === 'string') {
    kept.errorCode = text(code);
    if (kept.error === undefined) kept.error = text(message);
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

let entries: readonly KeptLogEntry[] = [];
let nextId = 0;
let seenThrough = 0;
const listeners = new Set<() => void>();
let notifyQueued = false;

// Listeners hear once per microtask, never inside keepLogEntry: a logger may be called while React renders.
function notify(): void {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const listener of listeners) listener();
  });
}

/** The sync log's sink callback: keeps a redacted copy of the entry, never the entry itself. */
export function keepLogEntry(entry: LogEntry): void {
  const data = redactLogData(entry.data);
  // The actor is this till's own signed-in cashier: shown on this till only, never scrubbed or in Copy/Share text.
  const actor: NonNullable<KeptLogEntry['actor']> = {};
  for (const key of ['id', 'name'] as const) {
    const value = entry.actor?.[key];
    if (typeof value === 'string' && value) actor[key] = value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
  }
  const kept: KeptLogEntry = { id: ++nextId, level: entry.level, scope: entry.scope, message: scrub(entry.message),
    ...(data ? { data } : {}), ...(Object.keys(actor).length > 0 ? { actor } : {}), timestamp: entry.timestamp };
  entries = [kept, ...entries.slice(0, LOG_BUFFER_SIZE - 1)];
  notify();
}

/** Newest first; the same array until the next keep or clear. */
export function logEntries(): readonly KeptLogEntry[] { return entries; }

/** The rail's Store health badge counts kept errors the cashier has not seen. */
export function unreadErrorCount(): number {
  return entries.filter(({ level, id }) => level === 'error' && id > seenThrough).length;
}

/** Mark the newest entry seen while the sync log is on screen. */
export function markLogSeen(): void {
  const newestId = entries[0]?.id;
  if (newestId === undefined || newestId <= seenThrough) return;
  seenThrough = newestId;
  notify();
}

export function subscribeLogEntries(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function clearLogEntries(): void {
  entries = [];
  notify();
}

export function filterLogEntries(list: readonly KeptLogEntry[], filter: LogFilter): readonly KeptLogEntry[] {
  return filter === 'all' ? list : list.filter((entry) => matchesPresetFilters(entry, presetFilters(filter, true)));
}

export function logActorName(entry: KeptLogEntry): string | null { return entry.actor?.name || entry.actor?.id || null; }

export function formatLogLine(entry: KeptLogEntry): string {
  const data = Object.entries(entry.data ?? {}).map(([key, value]) => ` ${key}=${value}`).join('');
  return `${entry.level.toUpperCase()} [${entry.scope}] ${entry.message}${data}`;
}

export function logCopyText(list: readonly KeptLogEntry[]): string {
  return list.map((entry) => `${new Date(entry.timestamp).toISOString()} ${formatLogLine(entry)}`).join('\n');
}
