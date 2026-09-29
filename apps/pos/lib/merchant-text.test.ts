import { describe, expect, it } from 'vitest';
import { MERCHANT_TEXT_MAX, merchantTextError } from './merchant-text';

const TOO_LONG = 'Barcode field is too long: use at most 255 characters.';
const HAS_NUL = 'Barcode field contains a NUL character; remove it.';

describe('merchantTextError', () => {
  it('bounds text at 255 characters', () => {
    expect(MERCHANT_TEXT_MAX).toBe(255);
    expect(merchantTextError('Barcode field', 'a'.repeat(255))).toBeNull();
    expect(merchantTextError('Barcode field', 'a'.repeat(256))).toBe(TOO_LONG);
  });

  it.each(['\u0000abc', 'ab\u0000c', 'abc\u0000'])('refuses a NUL in %j', (value) => {
    expect(merchantTextError('Barcode field', value)).toBe(HAS_NUL);
  });

  it('names the supplied field in each error message', () => {
    expect(merchantTextError('Cashier reference', 'a'.repeat(256))).toBe(
      'Cashier reference is too long: use at most 255 characters.',
    );
    expect(merchantTextError('Register id', 'x\u0000')).toBe(
      'Register id contains a NUL character; remove it.',
    );
  });

  it('gives the length message when the text is both too long and has a NUL', () => {
    expect(merchantTextError('Barcode field', `\u0000${'a'.repeat(255)}`)).toBe(TOO_LONG);
  });

  it.each(['', 'barcode'])('accepts %j', (value) => {
    expect(merchantTextError('Barcode field', value)).toBeNull();
  });
});
