// @vitest-environment happy-dom
import { act, createElement } from 'react';
// @ts-expect-error The app has react-dom (for the web build) but not @types/react-dom.
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holdsPayment, useReportHeldPayment, type HeldLeg } from './held-payment';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('holdsPayment', () => {
  it.each<[string, HeldLeg[], boolean]>([
    ['no legs', [], false],
    ['a captured leg with no status', [{}], true],
    ['a captured leg', [{ status: 'captured' }], true],
    ['a pending leg', [{ status: 'pending' }], true],
    ['an authorized leg', [{ status: 'authorized' }], true],
    ['only voided legs', [{ status: 'voided' }, { status: 'voided' }], false],
    ['only failed legs', [{ status: 'failed' }], false],
    ['only locked legs (a reopened order’s, the store has them)', [{ locked: true }, { status: 'captured', locked: true }], false],
    ['locked and captured', [{ locked: true }, { status: 'captured' }], true],
    ['voided and captured', [{ status: 'voided' }, { status: 'captured' }], true],
    ['a captured leg marked reopened, unlocked', [{ status: 'captured', reopened: true } as HeldLeg], true],
    ['a split whose second leg failed', [{ status: 'captured' }, { status: 'failed' }], true],
    ['a split whose second leg was voided', [{ status: 'captured' }, { status: 'voided' }], true],
  ])('%s', (_name, legs, held) => {
    expect(holdsPayment(legs)).toBe(held);
  });
});

type SaleShape = { stage: { kind: string }; order: { payments: HeldLeg[] } };

function Reporting({ sale, onHeldPayment }: { sale: SaleShape; onHeldPayment(held: boolean): void }) {
  useReportHeldPayment(sale, onHeldPayment);
  return null;
}

describe('useReportHeldPayment', () => {
  let root: { render(node: unknown): void; unmount(): void };
  let reports: boolean[];
  const onHeldPayment = (held: boolean) => { reports.push(held); };
  const render = (sale: SaleShape) => act(() => root.render(createElement(Reporting, { sale, onHeldPayment })));
  beforeEach(() => {
    root = createRoot(document.createElement('div'));
    reports = [];
  });
  afterEach(() => act(() => root.unmount()));

  it('a cart with no payment holds none; a taken leg holds one', () => {
    render({ stage: { kind: 'cart' }, order: { payments: [] } });
    expect(reports.at(-1)).toBe(false);
    render({ stage: { kind: 'tender' }, order: { payments: [{ status: 'captured' }] } });
    expect(reports.at(-1)).toBe(true);
  });

  it('a cart that kept its leg out of the tender still holds it', () => {
    render({ stage: { kind: 'cart' }, order: { payments: [{ status: 'captured' }] } });
    expect(reports.at(-1)).toBe(true);
  });

  it('the receipt holds none: the sale is complete, though its legs are still captured', () => {
    render({ stage: { kind: 'tender' }, order: { payments: [{ status: 'captured' }] } });
    expect(reports.at(-1)).toBe(true);
    render({ stage: { kind: 'receipt' }, order: { payments: [{ status: 'captured' }] } });
    expect(reports.at(-1)).toBe(false);
  });

  it('withdraws the payment when the sale unmounts', () => {
    render({ stage: { kind: 'tender' }, order: { payments: [{ status: 'pending' }] } });
    expect(reports.at(-1)).toBe(true);
    act(() => root.render(null));
    expect(reports.at(-1)).toBe(false);
  });
});
