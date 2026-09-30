import { RegisterSessionRequiredError, type useRegisterSession, type useSale } from '@tallyui/pos';

// The cashier-facing refusal for a Pay with no open session (RegisterSessionRequiredError carries only a code).
export const OPEN_REGISTER_TEXT = 'Open the register to take payment.';

/**
 * Starts the tender only inside an open register session, read from storage rather than the rendered one, and pins it
 * to the tender (INTEGRATION.md). Null means sessions are off, which this till never sells under: the settings gate
 * needs MIN_REGISTER, and a database still opening is refused the same way. Resolves to the refusal to show, or
 * undefined once the tender has started.
 */
export async function startTenderInSession(
  register: Pick<ReturnType<typeof useRegisterSession>, 'requireSaleSession'>,
  sale: Pick<ReturnType<typeof useSale>, 'startTender'>, method: 'cash' | 'external',
): Promise<string | undefined> {
  try {
    const confirmed = await register.requireSaleSession();
    if (!confirmed) throw new RegisterSessionRequiredError();
    sale.startTender(method, { session: confirmed });
  } catch (refusal) {
    return refusal instanceof RegisterSessionRequiredError ? OPEN_REGISTER_TEXT : String(refusal);
  }
}
