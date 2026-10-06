import { describe, expect, it } from 'vitest';
import { orderReference } from './order-reference';

describe('orderReference', () => {
  it('the last 8 characters of the order id before the store has it', () => {
    expect(orderReference({ id: '0199aaaa-bbbb-7ccc-8ddd-83c1a89c' })).toBe('83c1a89c');
  });

  it("then the store's display id too", () => {
    expect(orderReference({ id: '0199aaaa-bbbb-7ccc-8ddd-83c1a89c', serverRefs: { displayId: 'DEMO-000001' } })).toBe('83c1a89c · #DEMO-000001');
  });
});
