/** The plugin stores merchant-entered text in varchar(255) columns and refuses NUL (ADR 0002). */
export const MERCHANT_TEXT_MAX = 255;

/** The refusal for merchant-entered text, naming the field, or null when the value is acceptable. */
export function merchantTextError(fieldName: string, value: string): string | null {
  // UTF-16 code units, the same count as the plugin's check.
  if (value.length > MERCHANT_TEXT_MAX) {
    return `${fieldName} is too long: use at most ${MERCHANT_TEXT_MAX} characters.`;
  }
  if (value.includes('\u0000')) return `${fieldName} contains a NUL character; remove it.`;
  return null;
}
