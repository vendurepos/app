import { VendurePlugin } from '@vendure/core';
import { TallyCommand } from './tally-command.entity';

@VendurePlugin({
  compatibility: '^3.6.0',
  entities: [TallyCommand],
  configuration: config => {
    config.customFields.Order = [
      { name: 'tallyClientOrderId', type: 'string', unique: true, readonly: true, nullable: true },
      { name: 'tallySaleAt', type: 'datetime', readonly: true, nullable: true },
      { name: 'tallyRegisterId', type: 'string', readonly: true, nullable: true },
      { name: 'tallySessionId', type: 'string', readonly: true, nullable: true },
      { name: 'tallyCashierRef', type: 'string', readonly: true, nullable: true },
      { name: 'tallyPayments', type: 'text', readonly: true, nullable: true },
      { name: 'tallySnapshot', type: 'text', readonly: true, nullable: true },
    ];
    config.customFields.OrderLine = [
      { name: 'tallyUnitPrice', type: 'int', readonly: true, nullable: true },
      { name: 'tallyClientLineId', type: 'string', readonly: true, nullable: true },
    ];
    return config;
  },
})
export class TallySpikePlugin {}
