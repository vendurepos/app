import { createRequire } from 'node:module';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, Permission, RequestContext, TransactionalConnection, UserInputError } from '@vendure/core';
import { TallyCommand } from '../entities/tally-command.entity';
import { OrderCreateService } from '../service/order-create.service';
import type { OrderCreateResult } from '../service/order-create.service';

const { parse } = createRequire(require.resolve('@vendure/core'))('graphql') as typeof import('graphql');

export const adminApiSchema = parse(`
enum TallyNeedsAdminResolution {
  applied
  rejected
}

"A sale the plugin kept for an admin: its order is partly recorded and resends answer 409."
type TallyNeedsAdminCommand {
  "The order.create command id."
  id: String!
  clientOrderId: String
  "The channel the sale was made in; resolve a rejection with that channel's token."
  channelId: ID!
  orderId: ID
  orderCode: String
  createdAt: DateTime!
}

type TallyNeedsAdminResolved {
  id: String!
  status: String!
}

extend type Query {
  tallyNeedsAdminCommands: [TallyNeedsAdminCommand!]!
}

extend type Mutation {
  tallyResolveNeedsAdmin(commandId: String!, resolution: TallyNeedsAdminResolution!, note: String!): TallyNeedsAdminResolved!
}
`);

@Resolver()
export class TallyAdminResolver {
  constructor(private connection: TransactionalConnection, private orderCreate: OrderCreateService) {}

  @Query()
  @Allow(Permission.SuperAdmin)
  async tallyNeedsAdminCommands(@Ctx() ctx: RequestContext) {
    const rows = await this.connection.getRepository(ctx, TallyCommand).find({
      where: { status: 'needs_admin' }, order: { createdAt: 'ASC', id: 'ASC' },
    });
    return rows.map(row => {
      const result = row.result as unknown as OrderCreateResult | null;
      return {
        id: row.id, clientOrderId: row.clientOrderId, channelId: row.channelId,
        orderId: result?.serverRefs?.orderId ?? null, orderCode: result?.serverRefs?.displayId ?? null,
        createdAt: row.createdAt,
      };
    });
  }

  @Mutation()
  @Allow(Permission.SuperAdmin)
  async tallyResolveNeedsAdmin(@Ctx() ctx: RequestContext, @Args() args: {
    commandId: string; resolution: 'applied' | 'rejected'; note: string;
  }) {
    if (!args.note.trim()) throw new UserInputError('A note is required to resolve a sale');
    const result = await this.orderCreate.resolveNeedsAdmin(ctx, args.commandId, args.resolution, args.note.trim());
    return { id: result.id, status: result.status };
  }
}
