import { useLayoutEffect } from 'react';
import type { useSale } from '@tallyui/pos';

type Live = ReturnType<typeof useSale>;
export type LiveSale = Pick<Live, 'registerView'>;
export type LiveSaleRef = { current: LiveSale | null };

/** What the register counts of the sale on screen; nothing when no sale is mounted. */
export function liveSaleView(ref: LiveSaleRef): ReturnType<LiveSale['registerView']> {
  return ref.current?.registerView() ?? { takenLegs: [], saving: false, cashRoundings: [] };
}

/** Publishes the mounted sale to the register, and withdraws it at unmount. */
export function usePublishLiveSale(ref: LiveSaleRef, sale: LiveSale): void {
  useLayoutEffect(() => {
    ref.current = sale;
    return () => {
      // Only its own sale: on a remount the old sale's cleanup must not withdraw the new one.
      if (ref.current === sale) ref.current = null;
    };
  });
}
