import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Administrator, ConfigService, Injector, NativeAuthenticationStrategy, Permission, RequestContext, RequestContextService, TransactionalConnection,
  idsAreEqual } from '@vendure/core';
import { getUserChannelsPermissions } from '@vendure/core/dist/service/helpers/utils/get-user-channels-permissions';
import { tallyPosApproveVariance } from '../config/permissions';
import { TallyRegisterApproval } from '../entities/register.entities';
import { TallyCommand } from '../entities/tally-command.entity';
import { APPROVAL_FAILURE_WINDOW_MS, APPROVAL_TTL_MS, MAX_APPROVAL_FAILURES_PER_ACTOR, MAX_APPROVAL_FAILURES_PER_IDENTIFIER, REGISTER_LOCK_NAMESPACE } from './constants';
import { RegisterService } from './register.service';
import { jsonbOf } from './sql-json';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** 4.3d: a variance the till computed, or the closure the store refused, whose stored variance a blind till never sees. */
export type ApprovalBody = { sessionId: string; username: string; password: string }
  & ({ variance: Record<string, number>; closureId?: never } | { closureId: string; variance?: never });
export type ApprovalAnswer = { status: number; body: Record<string, unknown> };

const TENDERS = ['cash', 'external'];
const FIELDS = ['sessionId', 'variance', 'closureId', 'username', 'password'];
const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\u0000');

/** The route's body, or the 400 message; the message never quotes a value, so the password is never echoed. */
export function approvalBody(body: unknown): ApprovalBody | string {
  const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!object(body)) return 'Expected a body of { sessionId, variance, username, password }';
  const unknown = Object.keys(body).find(key => !FIELDS.includes(key));
  if (unknown !== undefined) return 'unknown field in the body';
  if (!text(body.sessionId, 64)) return 'sessionId: expected a non-empty string of at most 64 characters';
  if ((body.variance === undefined) === (body.closureId === undefined)) return 'Expected exactly one of variance or closureId';
  if (body.closureId !== undefined) {
    if (!text(body.closureId, 64)) return 'closureId: expected a non-empty string of at most 64 characters';
  } else if (!object(body.variance) || Object.entries(body.variance).some(([key, value]) => !TENDERS.includes(key) || !Number.isSafeInteger(value))) {
    return 'variance: expected tender keys (cash, external) with safe integer values';
  }
  if (!text(body.username, 255)) return 'username: expected a non-empty string';
  if (!text(body.password, 1024)) return 'password: expected a non-empty string';
  return body as ApprovalBody;
}

const answer = (status: number, code: string, message: string): ApprovalAnswer => ({ status, body: { code, message } });

/**
 * `POST /tally/v1/register-approvals` (#332, medusapos ADR 0023): a manager's username and password, checked without a
 * login, buy a single-use proof bound to one session and its variance. Nothing here logs the body, the proof or its hash.
 */
@Injectable()
export class RegisterApprovalService {
  private strategy?: Promise<NativeAuthenticationStrategy>;

  constructor(
    private connection: TransactionalConnection, private registers: RegisterService, private contexts: RequestContextService,
    private config: ConfigService, private moduleRef: ModuleRef,
  ) {}

  async approve(ctx: RequestContext, body: ApprovalBody): Promise<ApprovalAnswer> {
    const channelId = String(ctx.channelId);
    const requestedBy = String(ctx.activeUserId);
    const targetIdentifier = body.username.trim().toLowerCase();
    // 1. Admit and 2. rate-limit, in one transaction: the pending row counts as a failure until it is issued.
    const admitted = await this.connection.withTransaction(ctx, async tx => {
      const session = await this.registers.approvalSession(tx, body.sessionId);
      if (session === 'unknown') return answer(404, 'approval_session_unknown', 'This register session is not known to the store.');
      if (session === 'closed') return answer(409, 'approval_session_closed', 'This register session is already closed.');
      // 4.3d: the closure id form approves the variance the store stored with its newest refusal of that closure.
      let variance = body.variance;
      if (body.closureId !== undefined) {
        const refusal = await this.connection.getRepository(tx, TallyCommand).createQueryBuilder('c')
          .where(`c."channelId" = :channelId AND c."status" = 'rejected'
            AND ${jsonbOf('c."result"')} -> 'error' ->> 'code' = 'register_approval_required'
            AND ${jsonbOf('c."result"')} -> 'error' -> 'data' ->> 'sessionId' = :sessionId
            AND ${jsonbOf('c."result"')} -> 'error' -> 'data' ->> 'closureId' = :closureId`,
          { channelId, sessionId: body.sessionId, closureId: body.closureId })
          .orderBy('c.createdAt', 'DESC').getOne();
        const data = (refusal?.result?.error as { data?: { variance?: Record<string, number> } } | undefined)?.data;
        if (!data?.variance) return answer(404, 'approval_request_unknown', 'The store has no refused closure to approve for this session.');
        variance = data.variance;
      }
      const repo = this.connection.getRepository(tx, TallyRegisterApproval);
      for (const key of [`approval-actor:${requestedBy}`, `approval-identifier:${targetIdentifier}`]) {
        await repo.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [REGISTER_LOCK_NAMESPACE, key]);
      }
      const failures = (column: string, value: string) => repo.createQueryBuilder('a').where(`a."tokenHash" IS NULL AND a."${column}" = :value
        AND a."createdAt" > now() - (:ms * interval '1 millisecond')`, { value, ms: APPROVAL_FAILURE_WINDOW_MS }).getCount();
      if (await failures('requestedBy', requestedBy) >= MAX_APPROVAL_FAILURES_PER_ACTOR
        || await failures('targetIdentifier', targetIdentifier) >= MAX_APPROVAL_FAILURES_PER_IDENTIFIER) {
        return answer(429, 'approval_rate_limited', 'Too many failed approvals. Try again in a few minutes.');
      }
      const id = randomUUID();
      await repo.insert({ id, channelId, sessionId: session.id, variance, requestedBy, targetIdentifier });
      return id;
    });
    if (typeof admitted !== 'string') return admitted;
    // 3. The manager, through an admin context: the route's custom one would look only at customers. No session is created.
    const adminCtx = await this.contexts.create({ apiType: 'admin', channelOrToken: ctx.channel });
    const user = await (await this.native()).authenticate(adminCtx, { username: body.username, password: body.password });
    // One answer for an unknown username, a customer and a wrong password: the same status, body and headers.
    if (!user) return answer(401, 'approval_invalid_credentials', 'The username or password is wrong.');
    const permissions = getUserChannelsPermissions(user).find(channel => idsAreEqual(channel.id, ctx.channelId))?.permissions ?? [];
    if (!permissions.includes(Permission.SuperAdmin) && !permissions.includes(tallyPosApproveVariance.Permission as Permission)) {
      return answer(403, 'approval_forbidden', "This user can't approve register variances.");
    }
    // 4. Issue: only the proof's hash is stored.
    const proof = randomBytes(32).toString('base64url');
    const admin = await this.connection.getRepository(ctx, Administrator).findOneBy({ user: { id: user.id } });
    const approvedBy = String(user.id);
    const approvedByName = `${admin?.firstName ?? ''} ${admin?.lastName ?? ''}`.trim() || user.identifier;
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
    await this.connection.withTransaction(ctx, tx => this.connection.getRepository(tx, TallyRegisterApproval)
      .update(admitted, { tokenHash: sha256(proof), approvedBy, approvedByName, expiresAt }));
    return { status: 200, body: { approval: proof, approvedBy, approvedByName, expiresAt: expiresAt.toISOString() } };
  }

  // Vendure's own initialised strategy when the store keeps it, else one of our own: authenticate never logs the user in.
  private native(): Promise<NativeAuthenticationStrategy> {
    const configured = this.config.authOptions.adminAuthenticationStrategy.find(s => s instanceof NativeAuthenticationStrategy);
    const own = new NativeAuthenticationStrategy();
    return this.strategy ??= configured ? Promise.resolve(configured as NativeAuthenticationStrategy)
      : Promise.resolve(own.init(new Injector(this.moduleRef))).then(() => own);
  }
}
