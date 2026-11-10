export interface Flushable { flush(): Promise<void> }

/** Sync now: starts the catalogue refresh, then sends every outbox; resolves once every send has settled and never rejects. */
export async function syncNow(outboxes: readonly Flushable[], refresh: () => unknown): Promise<void> {
  refresh();
  await Promise.allSettled(outboxes.map((outbox) => outbox.flush()));
}
