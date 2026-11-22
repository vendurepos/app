import type { TenderState } from '@tallyui/pos';

/** Cash typed into the tender's entry (not the pre-typed balance or a cleared entry): docs/scan-policy.md's "a tender with cash typed". */
export function tenderTyped(state: TenderState): boolean {
  return state.entryDirty && state.entryMinor > 0;
}
