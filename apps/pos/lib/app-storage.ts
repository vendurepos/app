import type { RxStorage } from 'rxdb';
import { createStorage } from './storage';

let storage: RxStorage<any, any> | undefined;

/** One storage per page life (ADR-061): the catalogue and order databases share its one worker. */
export function appStorage(): RxStorage<any, any> {
  return storage ??= createStorage();
}
