import { describe, expect, it } from 'vitest';
import { tillNotices } from './notices';

describe('tillNotices', () => {
  it('has no notices before capabilities are read or with a current plugin', () => {
    expect(tillNotices({})).toEqual([]);
    expect(tillNotices({ capabilities: { orderCreate: 7, register: 1, orderRefund: 1 } })).toEqual([]);
  });
  it('names sales held back by an older plugin', () => {
    expect(tillNotices({ capabilities: { orderCreate: 3, register: 1, orderRefund: 1 } })).toEqual([{
      id: 'plugin-update', title: 'Update the VendurePOS plugin',
      body: "This store's VendurePOS plugin is missing or older than this app needs, so sales are held back. Update the VendurePOS plugin on the store.",
    }]);
  });
  it.each([
    [{ orderCreate: 7, orderRefund: 1 }, 'so the register is held back.'],
    [{ orderCreate: 7, register: 0, orderRefund: 1 }, 'so the register is held back.'],
    [{ orderCreate: 1, orderRefund: 1 }, 'so sales and the register are held back.'],
    [{ orderCreate: 7, register: 1 }, 'so refunds are held back.'],
    [{ orderCreate: 6, register: 1, orderRefund: 1 }, 'so the customer note is held back.'],
    [{ orderCreate: 4, register: 1, orderRefund: 1 }, 'so fee and shipping charges and the customer note are held back.'],
    [{ orderCreate: 6, orderRefund: 1 }, 'so the customer note and the register are held back.'],
    [{ orderCreate: 4 }, 'so fee and shipping charges, the customer note, refunds and the register are held back.'],
    [{ orderCreate: 1, register: 1 }, 'so sales and refunds are held back.'],
  ])('shows one notice for %j', (capabilities, body) => {
    const notices = tillNotices({ capabilities });
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toContain(body);
  });
});
