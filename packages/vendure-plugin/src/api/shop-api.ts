import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { pick } from '@vendure/common/lib/pick';
import { Refund } from '@vendure/core';

@Resolver('Refund')
export class TallyShopRefundResolver {
  @ResolveField()
  metadata(@Parent() refund: Refund) {
    // Keep till details private, as payment-entity.resolver.js does for Shop payment metadata.
    return pick(refund.metadata, ['public']);
  }
}
