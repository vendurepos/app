import { isRxdbRemoteVersionMismatch } from '@tallyui/core';
import { isStorageHeldError, isStorageUnavailableError, isStorageWorkerStartError } from '@tallyui/storage-sqlite/web';

export const ORDER_STORE_FAILED = "The till's order storage didn't open. Reload this page. If it happens again, report the details shown.";

/** The wording for a local storage start failure, by cause (#82 item 3); undefined for any other error. */
export function storageStartMessage(error: unknown): string | undefined {
  if (isStorageUnavailableError(error)) return "This browser window can't keep VendurePOS's data, as in a private window. Open VendurePOS in a normal window.";
  if (isStorageHeldError(error)) return 'VendurePOS is open in another tab. Close it, then reload this page.';
  if (isRxdbRemoteVersionMismatch(error)) return 'VendurePOS was updated while this page was open. Reload this page.';
  if (isStorageWorkerStartError(error)) return "Local storage didn't start. Reload this page.";
  return undefined;
}

/** For a failed order-store open: the cause's wording, or ORDER_STORE_FAILED for an error with no storage cause. */
export function orderStoreFailureMessage(error: unknown): string {
  return storageStartMessage(error) ?? ORDER_STORE_FAILED;
}

/** The error's own text, for the cashier to report: its message when it has one, else String(error). */
export function errorDetail(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : String(error);
}
