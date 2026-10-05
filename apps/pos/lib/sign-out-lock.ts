/** Why Sign out is locked (#82 item 15), or undefined when it is not locked for a reason the cashier should see. */
export function signOutLockReason(state: { saving: boolean; savesInFlight: number; closing: boolean }): string | undefined {
  if (state.closing) return 'Sign out waits for the register to finish closing.';
  if (state.saving || state.savesInFlight > 0) return 'Sign out waits until the sale is saved.';
  return undefined;
}
