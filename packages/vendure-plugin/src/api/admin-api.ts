import { createRequire } from 'node:module';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, ChannelService, Ctx, ID, Permission, RequestContext, RoleService, TransactionalConnection, UserInputError } from '@vendure/core';
import { tallyPosResetDisplayDevice } from '../config/permissions';
import { POS_TILL_PERMISSIONS, POS_TILL_ROLE_CODE } from '../config/pos-till-role';
import { TallyCommand } from '../entities/tally-command.entity';
import { DisplaySignallingService } from '../service/display-signalling.service';
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

"A till's customer-display device in the active channel. Never carries a key, token, secret, code or check code."
type TallyDisplayDevice {
  deviceId: String!
  "Whether a device key has been issued for this id; a keyless row is a pre-migration device that has not registered yet."
  keyIssued: Boolean!
  "When a pre-migration device adopted its displays, if it did."
  adoptedAt: DateTime
  "The last till call that passed the key check, or the registration."
  lastCallAt: DateTime!
  displays: [TallyDisplayDeviceDisplay!]!
}

type TallyDisplayDeviceDisplay {
  id: String!
  name: String!
  confirmedAt: DateTime!
  lastSeenAt: DateTime
}

extend type Query {
  tallyNeedsAdminCommands: [TallyNeedsAdminCommand!]!
  "The active channel's customer-display devices, most recent till call first. Needs TallyPosResetDisplayDevice."
  tallyDisplayDevices: [TallyDisplayDevice!]!
}

extend type Mutation {
  tallyEnsurePosTillRole: Role!
  tallyResolveNeedsAdmin(commandId: String!, resolution: TallyNeedsAdminResolution!, note: String!): TallyNeedsAdminResolved!
  """
  Deletes the device with every display, code and pending pairing it owns in the active channel, so the id registers
  as new. DELETED when anything was deleted; NOT_DELETED when the channel has nothing under this id.
  Needs TallyPosResetDisplayDevice.
  """
  tallyResetDisplayDevice(deviceId: String!): DeletionResponse!
}
`);

@Resolver()
export class TallyAdminResolver {
  constructor(
    private connection: TransactionalConnection, private orderCreate: OrderCreateService,
    private roles: RoleService, private channels: ChannelService, private signalling: DisplaySignallingService,
  ) {}

  @Mutation()
  @Allow(Permission.SuperAdmin)
  async tallyEnsurePosTillRole(@Ctx() ctx: RequestContext) {
    const { items: [role] } = await this.roles.findAll(ctx, { filter: { code: { eq: POS_TILL_ROLE_CODE } } });
    const channelIds: ID[] = [];
    let totalItems: number;
    do {
      const channels = await this.channels.findAll(ctx, { skip: channelIds.length });
      channelIds.push(...channels.items.map(channel => channel.id));
      totalItems = channels.totalItems;
    } while (channelIds.length < totalItems);
    if (!role) {
      return this.roles.create(ctx, {
        code: POS_TILL_ROLE_CODE, description: 'VendurePOS till',
        permissions: POS_TILL_PERMISSIONS as Permission[], channelIds,
      });
    }
    return this.roles.update(ctx, {
      id: role.id,
      permissions: [...new Set([...role.permissions, ...POS_TILL_PERMISSIONS])] as Permission[],
      channelIds: [...new Set([...role.channels.map(channel => channel.id), ...channelIds])],
    });
  }

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
        // Stored encoded (the commands API's serverRefs); the ID type encodes again, so decode first.
        orderId: (result?.serverRefs?.orderId && this.orderCreate.decodeId(result.serverRefs.orderId)) ?? null, orderCode: result?.serverRefs?.displayId ?? null,
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

  @Query()
  @Allow(tallyPosResetDisplayDevice.Permission)
  tallyDisplayDevices(@Ctx() ctx: RequestContext) {
    return this.signalling.listDevices(ctx);
  }

  @Mutation()
  @Allow(tallyPosResetDisplayDevice.Permission)
  tallyResetDisplayDevice(@Ctx() ctx: RequestContext, @Args() { deviceId }: { deviceId: string }) {
    return this.signalling.resetDevice(ctx, deviceId);
  }
}
