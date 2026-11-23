import { toVendureStoreOrder, type VendureOrder } from '@tallyui/connector-vendure';
import { buildReceiptDataFromStoreOrder, type ReceiptConfig, type ReceiptData } from '@tallyui/pos';

type Tender = { method: string; amountMinor: number; tenderedMinor?: number; changeMinor?: number; reference?: string };

const UNPAID_PAYMENT_STATES = ['Declined', 'Error', 'Cancelled'];

/** The till's own tenders from `customFields.tallyPayments`, or null when it is missing or unreadable. */
function storedTenders(raw: string | null | undefined): Tender[] | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const readable = parsed.every((item: unknown) => typeof item === 'object' && item !== null
    && typeof (item as Tender).method === 'string' && (item as Tender).method.length > 0 && Number.isInteger((item as Tender).amountMinor));
  return readable ? parsed as Tender[] : null;
}

/** A stored Vendure order's receipt, with the payments and change the till recorded for it. */
export function storedReceiptData(order: VendureOrder, config: ReceiptConfig & { pricesIncludeTax: boolean }): ReceiptData {
  const { pricesIncludeTax, ...rest } = config;
  const receipt = buildReceiptDataFromStoreOrder(toVendureStoreOrder(order, pricesIncludeTax), rest);
  // The plugin records each tender under its methodId, else the listed code equal to its method, else Vendure method
  // 'tally-pos', and under 'tally-pos' too when that method is unknown, shared, disabled or ineligible (R3,
  // payment-methods.service.ts / order-create.service.ts); the till's own payment stays in metadata.tender and the
  // whole list in tallyPayments.
  const tenders = storedTenders(order.customFields?.tallyPayments);
  if (tenders) {
    let remaining = order.totalWithTax;
    let changeDueMinor = 0;
    const payments = tenders.flatMap(({ method, amountMinor, tenderedMinor, changeMinor, reference }) => {
      if (Number.isSafeInteger(order.totalWithTax) && remaining === 0) return [];
      const applied = Number.isSafeInteger(order.totalWithTax) ? Math.min(amountMinor, remaining) : amountMinor;
      remaining -= applied;
      changeDueMinor += changeMinor ?? 0;
      return [{ method, amountMinor: tenderedMinor ?? applied, ...(reference ? { reference } : {}) }];
    });
    return {
      ...receipt,
      payments,
      changeDueMinor,
    };
  }
  const payments = (order.payments ?? []).filter(payment => !UNPAID_PAYMENT_STATES.includes(payment.state)).map((payment) => {
    const tender = (payment.metadata as { tender?: { method?: unknown } } | null | undefined)?.tender?.method;
    return { method: typeof tender === 'string' && tender.length > 0 ? tender : payment.method, amountMinor: payment.amount };
  });
  return { ...receipt, payments, changeDueMinor: 0 };
}
