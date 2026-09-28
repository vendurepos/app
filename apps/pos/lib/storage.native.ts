import type { RxStorage } from 'rxdb';

export function createStorage(): RxStorage<any, any> {
  throw new Error('Native storage is not available yet: @tallyui/storage-sqlite 2.0.0 does not accept an expo-sqlite 16 database handle.');
}
