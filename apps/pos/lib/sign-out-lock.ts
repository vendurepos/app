/** Why Sign out is locked (#82 item 15), or undefined when it is not locked for a reason the cashier should see. */
export function signOutLockReason(state: { saving: boolean; savesInFlight: number; closing: boolean; holdsPayment: boolean }): string | undefined {
  if (state.closing) return 'Sign out waits for the register to finish closing.';
  if (state.saving || state.savesInFlight > 0) return 'Sign out waits until the sale is saved.';
  // Sign-out unmounts the sale in progress, and its taken payment with it: off the till and off the Z (#504).
  if (state.holdsPayment) return 'Take the rest of the payment or cancel it before signing out.';
  return undefined;
}
