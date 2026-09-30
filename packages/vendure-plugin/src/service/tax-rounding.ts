import {
  DefaultMoneyStrategy, DefaultOrderTaxCalculationStrategy, DefaultTaxLineCalculationStrategy, OrderLevelTaxCalculationStrategy,
} from '@vendure/core';
import type { MoneyStrategy, OrderTaxCalculationStrategy, TaxLineCalculationStrategy } from '@vendure/core';

/** Core's TaxRounding (TallyUI/tallyui#287): how the store rounds tax, advertised as `/info`'s `taxRounding`. */
export type TaxRounding =
  | { granularity: 'per_order' | 'per_line_items' | 'per_rate_group_items'; mode: 'half_away_from_zero' | 'half_up' }
  | { granularity: 'custom' };

export type TaxStrategies = {
  orderTax?: OrderTaxCalculationStrategy; taxLine?: TaxLineCalculationStrategy; money?: MoneyStrategy;
};

const exactly = (instance: object | undefined, type: abstract new (...args: never[]) => unknown) => instance?.constructor === type;

/**
 * The store's rounding, by exact class and never `instanceof`: a subclass may round differently (ADR 0002 §5).
 * Vendure's DefaultMoneyStrategy is Math.round, so half up. Anything this cannot describe is `custom`, never absent.
 */
export function taxRoundingFor({ orderTax, taxLine, money }: TaxStrategies): TaxRounding {
  if (!exactly(taxLine, DefaultTaxLineCalculationStrategy) || !exactly(money, DefaultMoneyStrategy)) return { granularity: 'custom' };
  if (exactly(orderTax, DefaultOrderTaxCalculationStrategy)) return { granularity: 'per_line_items', mode: 'half_up' };
  if (exactly(orderTax, OrderLevelTaxCalculationStrategy)) return { granularity: 'per_rate_group_items', mode: 'half_up' };
  return { granularity: 'custom' };
}
