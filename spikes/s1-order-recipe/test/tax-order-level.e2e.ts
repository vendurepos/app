import { OrderLevelTaxCalculationStrategy } from '@vendure/core';
import { taxCases } from './tax-cases';

taxCases('order-level', { taxOptions: { orderTaxCalculationStrategy: new OrderLevelTaxCalculationStrategy() } });
