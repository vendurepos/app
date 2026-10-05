import { describe, expect, it } from 'vitest';
import { errorDetail, ORDER_STORE_FAILED, orderStoreFailureMessage, storageStartMessage } from './storage-start-failure';

describe('storage start failures', () => {
  it('a StorageUnavailableError, by name or by message, gets the private-window wording, not the other-tab one', () => {
    const error = new Error('no OPFS');
    error.name = 'StorageUnavailableError';
    const message = "This browser window can't keep VendurePOS's data, as in a private window. Open VendurePOS in a normal window.";
    expect(storageStartMessage(error)).toBe(message);
    expect(storageStartMessage(new Error('could not create instance … StorageUnavailableError: no OPFS'))).toBe(message);
  });

  it('the held start error gets the other-tab wording', () => {
    expect(storageStartMessage(new Error('StorageWorkerStartError: another tab holds the database')))
      .toBe('VendurePOS is open in another tab. Close it, then reload this page.');
  });

  it('RM1 gets the reload wording', () => {
    expect(storageStartMessage({ code: 'RM1', rxdb: true, message: 'RM1' }))
      .toBe('VendurePOS was updated while this page was open. Reload this page.');
  });

  it('any other start failure gets the generic storage wording', () => {
    expect(storageStartMessage(new Error('StorageWorkerStartError: boom')))
      .toBe("Local storage didn't start. Reload this page.");
  });

  it('an unrelated error has no storage wording, and the order store falls back to ORDER_STORE_FAILED', () => {
    const error = new Error('Failed to fetch');
    expect(storageStartMessage(error)).toBeUndefined();
    expect(orderStoreFailureMessage(error)).toBe(ORDER_STORE_FAILED);
    expect(errorDetail(error)).toBe('Failed to fetch');
  });

  it('errorDetail falls back to String() for a non-Error', () => {
    expect(errorDetail('boom')).toBe('boom');
    expect(errorDetail({ code: 'RM1' })).toBe(String({ code: 'RM1' }));
  });
});
