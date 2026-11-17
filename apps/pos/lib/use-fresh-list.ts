import { useEffect, useState } from 'react';
import type { RxCollection } from 'rxdb';
import { watchFresh } from '@tallyui/pos';

/** Every document of a collection, kept fresh (watchFresh); [] while there is no collection. */
export function useFreshList<T>(collection: RxCollection<T> | null): T[] {
  const [list, setList] = useState<T[]>([]);
  useEffect(() => {
    setList([]);
    if (!collection) return;
    const subscription = watchFresh(collection, { selector: {} }).subscribe(setList);
    return () => subscription.unsubscribe();
  }, [collection]);
  return list;
}
