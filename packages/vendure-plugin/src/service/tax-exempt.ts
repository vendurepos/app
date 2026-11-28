export function taxExemptPayloadErrors(payload: unknown): string[] {
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isObject(payload) || !Object.hasOwn(payload, 'taxExempt')) return [];
  if (payload.taxExempt !== true) return ['taxExempt: expected true when present'];
  const errors: string[] = [];
  if (payload.pricesIncludeTax === true) errors.push('pricesIncludeTax: expected false on a tax-exempt order');
  for (const group of ['lines', 'fees', 'shipping']) {
    const rows = payload[group];
    const field = group === 'lines' ? 'taxInclusive' : 'amountIncludesTax';
    if (Array.isArray(rows)) rows.forEach((row, index) => {
      if (isObject(row) && row[field] === true) errors.push(`${group}[${index}].${field}: expected not true on a tax-exempt order`);
    });
  }
  const checkTax = (row: unknown, prefix: string) => {
    if (isObject(row) && Object.hasOwn(row, 'taxMinor') && row.taxMinor !== 0) errors.push(`${prefix}taxMinor: expected 0 on a tax-exempt order`);
  };
  checkTax(payload, '');
  for (const group of ['fees', 'shipping', 'taxByRate']) {
    const rows = payload[group];
    if (Array.isArray(rows)) rows.forEach((row, index) => checkTax(row, `${group}[${index}].`));
  }
  checkTax(payload.display, 'display.');
  return errors;
}
