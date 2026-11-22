import { wireMethodOf } from '@tallyui/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_INFO } from './demo/store';
import { MIN_ORDER_CREATE_METHOD_ID, parseTenderMethods, tenderMethodsLogger } from './tender-methods';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.restoreAllMocks();
  warn = vi.spyOn(tenderMethodsLogger, 'warn').mockImplementation(() => {});
});

describe('parseTenderMethods', () => {
  it('(r) gives a tile per listed method at order.create 10: cash is cash, card and other are external, all manual', () => {
    const methods = parseTenderMethods(DEMO_INFO, MIN_ORDER_CREATE_METHOD_ID)!;
    expect(methods.map(({ id, title, kind }) => ({ id, title, kind }))).toEqual([
      { id: 'cash', title: 'Cash', kind: 'cash' }, { id: 'card-terminal', title: 'Card terminal', kind: 'card' },
      { id: 'voucher', title: 'Gift voucher', kind: 'other' },
    ]);
    expect(methods.map(wireMethodOf)).toEqual(['cash', 'external', 'external']);
    // TenderPane offers each method whose capture is manual (components offeredMethods).
    expect(methods.filter((method) => method.capture.mode === 'manual')).toHaveLength(3);
    expect(methods.map((method) => method.capabilities.change)).toEqual([true, false, false]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('(s) gives undefined below order.create 10, where no methodId would be sent', () => {
    expect(parseTenderMethods(DEMO_INFO, 7)).toBeUndefined();
    expect(parseTenderMethods(DEMO_INFO, 9)).toBeUndefined();
    expect(parseTenderMethods(DEMO_INFO, Number.NaN)).toBeUndefined();
  });

  it.each([
    ['no key', {}], ['an empty list', { paymentMethods: [] }], ['a non-array', { paymentMethods: { code: 'cash' } }],
    ['no body', null], ['only bad entries', { paymentMethods: [{ code: '', name: 'Cash', kind: 'cash' }] }],
  ])('(t) gives undefined for %s', (_, body) => {
    expect(parseTenderMethods(body, 10)).toBeUndefined();
  });

  it('(u) drops an over-long code and keeps the others, logging only the count', () => {
    const long = 'x'.repeat(65);
    const methods = parseTenderMethods({ paymentMethods: [...DEMO_INFO.paymentMethods, { code: long, name: 'Long', kind: 'card' }] }, 10)!;
    expect(methods.map((method) => method.id)).toEqual(['cash', 'card-terminal', 'voucher']);
    expect(parseTenderMethods({ paymentMethods: [{ code: 'y'.repeat(64), name: 'Edge', kind: 'card' }] }, 10)).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(long);
    expect(warn.mock.calls[0][0]).toContain('1');
  });

  it('(r2) drops a bad kind, an empty name and a NUL code; a repeated code keeps its first entry', () => {
    const methods = parseTenderMethods({ paymentMethods: [
      { code: 'cash', name: 'Cash', kind: 'cash' }, { code: 'bank', name: 'Bank', kind: 'bank_transfer' },
      { code: 'blank', name: '', kind: 'card' }, { code: 'nul\0', name: 'Nul', kind: 'other' }, { code: 'noname', kind: 'card' },
      'not an entry', { code: 'cash', name: 'Second cash', kind: 'card' }, { code: 'voucher', name: 'Gift voucher', kind: 'other' },
    ] }, 10)!;
    expect(methods.map(({ id, title }) => [id, title])).toEqual([['cash', 'Cash'], ['voucher', 'Gift voucher']]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('5');
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/bank|blank|nul|noname/i);
  });
});
