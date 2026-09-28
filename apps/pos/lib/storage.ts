import { getRxStorageSQLiteWasm } from '@tallyui/storage-sqlite/web';
import type { RxStorage } from 'rxdb';

// The build:web script builds this worker into public/ before the Expo export.
export const SQLITE_WORKER_URL = '/tallyui-sqlite-worker.js';

export function createStorage(): RxStorage<any, any> {
  return getRxStorageSQLiteWasm({ workerInput: SQLITE_WORKER_URL });
}
