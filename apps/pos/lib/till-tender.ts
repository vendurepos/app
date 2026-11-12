import { useCallback, useState } from 'react';
import { initialTenderState, initTenderState, tenderReducer, type TenderAction, type TenderState, type useSale } from '@tallyui/pos';

/** Cash typed into the tender's entry (not the pre-typed balance or a cleared entry): docs/scan-policy.md's "a tender with cash typed". */
export function tenderTyped(state: TenderState): boolean {
  return state.entryDirty && state.entryMinor > 0;
}

/** The till hosts the tender reducer so the scanner can read it, seeded during render each time a tender begins. */
export function useTillTender(sale: ReturnType<typeof useSale>): { state: TenderState; dispatch: (action: TenderAction) => void } {
  const [state, setState] = useState(initialTenderState);
  const [previousStage, setPreviousStage] = useState<typeof sale.stage.kind>();
  const dispatch = useCallback((action: TenderAction) => setState((state) => tenderReducer(state, action)), []);
  if (previousStage !== sale.stage.kind) {
    setPreviousStage(sale.stage.kind);
    if (sale.stage.kind === 'tender') {
      setState(initTenderState({ methodId: sale.stage.method, balanceMinor: sale.order.balanceDueMinor }));
    }
  }
  return { state, dispatch };
}
