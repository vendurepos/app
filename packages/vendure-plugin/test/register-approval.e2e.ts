import { createHash, randomUUID } from 'node:crypto';
import { SUPER_ADMIN_ROLE_CODE } from '@vendure/common/lib/shared-constants';
import { Logger, RequestContextService, Role, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { IsNull } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RegisterService, TallyCommand, TallyPosPlugin, TallyRegisterApproval, TallyRegisterClosure } from '../src';
import type { RegisterEnvelope } from '../src';
import { markTallyRoute } from '../src/config/strategies';
import type { RegisterCommandType } from '../src/vendored/commands';
import { TallyRegisterSession, TallyRegisterSessionAlias } from '../src/entities/register.entities';
import { createPluginTestEnvironment } from './env';

const NOW = Date.parse('2026-10-01T00:00:00.000Z');
const AT = '2026-09-30T10:00:00.000Z';
const THRESHOLD = 500;
const uuid = () => randomUUID();
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const INVALID = { code: 'approval_invalid_credentials', message: 'The username or password is wrong.' };

// #332: register contract 3, with the plugin's approval option set (case 14, and each open below v3, turn it off).
describe('register approval (contract 3)', () => {
  const environment = createPluginTestEnvironment({}, [TallyPosPlugin.init({ registerApproval: { thresholdMinor: THRESHOLD } })]);
  const { server, adminClient, decode } = environment;
  let registers: RegisterService;
  let connection: TransactionalConnection;
  let base: string;
  let channelId: string;
  let manager: { email: string; userId: string };
  beforeAll(async () => {
    await environment.init();
    registers = server.app.get(RegisterService);
    connection = server.app.get(TransactionalConnection);
    base = await server.app.getUrl();
    channelId = (await adminClient.query<{ activeChannel: { id: string } }>(parse('query { activeChannel { id } }'))).activeChannel.id;
    manager = await admin(['ApproveTallyPosVariance'], 'Mia', 'Manager');
  });
  afterAll(() => server.destroy());

  async function admin(permissions: string[], firstName = 'Till', lastName = 'User', channelIds = [channelId]) {
    const { createRole } = await adminClient.query<{ createRole: { id: string } }>(parse(`mutation Role($input: CreateRoleInput!) {
      createRole(input: $input) { id } }`), { input: { code: `role-${uuid()}`, description: 'test', permissions, channelIds } });
    const email = `${uuid()}@staff.example`;
    const { createAdministrator } = await adminClient.query<{ createAdministrator: { user: { id: string } } }>(parse(`
      mutation Admin($input: CreateAdministratorInput!) { createAdministrator(input: $input) { user { id } } }`),
    { input: { firstName, lastName, emailAddress: email, password: 'secret-password', roleIds: [createRole.id] } });
    return { email, userId: decode(createAdministrator.user.id) };
  }
  // A till cashier of its own, so each test's failures count only against its own limit.
  async function cashier() {
    const { email } = await admin(['TallyPosSell']);
    const response = await fetch(`${base}/admin-api`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `mutation { login(username: "${email}", password: "secret-password") { ... on CurrentUser { id } } }` }) });
    return `Bearer ${response.headers.get('vendure-auth-token')}`;
  }
  const superAdmin = () => `Bearer ${adminClient.getAuthToken()}`;
  async function approve(body: Record<string, unknown>, auth = superAdmin()) {
    const response = await fetch(`${base}/tally/v1/register-approvals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const request = (sessionId: string, extra: Record<string, unknown> = {}) =>
    ({ sessionId, variance: { cash: 600 }, username: manager.email, password: 'secret-password', ...extra });
  async function proofFor(sessionId: string, variance = { cash: 600 }) {
    const { status, body } = await approve(request(sessionId, { variance }));
    expect(status).toBe(200);
    return body.approval as string;
  }

  async function send(command: RegisterEnvelope, channelOrToken?: string) {
    const ctx = markTallyRoute(await server.app.get(RequestContextService).create({ apiType: 'custom', channelOrToken }));
    return registers.apply(ctx, command, { requestTimeMs: NOW });
  }
  const envelope = (type: RegisterCommandType, version: number, payload: Record<string, unknown>): RegisterEnvelope =>
    ({ id: uuid(), type, version, createdAt: AT, deviceId: 'till-1', attempt: 1, payload });
  const open = (s: string, r: string, version = 3) => envelope('register.session.open', version, { sessionId: s, registerId: r, openedAt: AT, countedFloatMinor: 10000 });
  // The server expects 10000 cash (the float, no sales), so its variance is counted − 10000; tillExpected says the till's own figure.
  const closure = (s: string, r: string, cash: number, extra: Record<string, unknown> = {}, version = 3) => envelope('register.closure.submit', version, {
    closureId: uuid(), sessionId: s, registerId: r, number: 1, openedAt: AT, closedAt: AT, tillExpected: { cash }, counted: { cash },
    periodSalesTotalMinor: 0, periodRefundsTotalMinor: 0, perpetualSalesTotalMinor: 0, perpetualRefundsTotalMinor: 0,
    unsyncedCount: 0, unsyncedTotalMinor: 0, softwareVersion: '3.20.0', orderIds: [], movementIds: [], ...extra });
  // #334: with the option set no session opens below v3, so such a send switches it off for that send alone.
  async function withoutApproval(command: RegisterEnvelope, channelOrToken?: string) {
    const saved = TallyPosPlugin.options.registerApproval;
    TallyPosPlugin.options.registerApproval = undefined;
    try {
      return await send(command, channelOrToken);
    } finally {
      TallyPosPlugin.options.registerApproval = saved;
    }
  }
  // A session below v3 is one opened before the option was set.
  async function session(version = 3, channelOrToken?: string) {
    const [s, r] = [uuid(), uuid()];
    expect(await (version < 3 ? withoutApproval : send)(open(s, r, version), channelOrToken)).toMatchObject({ status: 'applied' });
    return { s, r };
  }
  const ledger = (command: { id: string }) => connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: command.id });
  const approvals = () => connection.rawConnection.getRepository(TallyRegisterApproval);
  async function refused(command: RegisterEnvelope, code: string, message: string, data: Record<string, unknown>) {
    const result = await send(command);
    expect(result).toEqual({ id: command.id, status: 'rejected', error: { code, message, data } });
    expect(await ledger(command)).toMatchObject({ status: 'rejected', result });
    expect(await send(command)).toEqual(result);
  }
  const invalid = (command: RegisterEnvelope, reason: string) =>
    refused(command, 'register_approval_invalid', `The approval is not valid for this closure: ${reason}`, { reason });
  async function channel(code: string) {
    const { activeChannel } = await adminClient.query(parse('query { activeChannel { defaultTaxZone { id } } }'));
    const zone = activeChannel.defaultTaxZone.id;
    const { createChannel } = await adminClient.query(parse(`mutation Channel($input: CreateChannelInput!) {
      createChannel(input: $input) { ... on Channel { id } } }`), { input: { code, token: `${code}-token`, defaultLanguageCode: 'en',
      pricesIncludeTax: false, defaultCurrencyCode: 'EUR', availableCurrencyCodes: ['EUR'], defaultTaxZoneId: zone, defaultShippingZoneId: zone } });
    return createChannel.id as string;
  }
  const transition = (s: string) => envelope('register.session.transition', 3, { sessionId: s, status: 'closed', at: AT, approvedBy: 'mallory' });
  // reapproveClosure: the refused closure resent with a new command id and the proof, every other field as it was.
  const resend = (command: RegisterEnvelope, approval: string) => ({ ...command, id: uuid(), payload: { ...command.payload, approval } });
  async function closureRead(r: string) {
    const response = await fetch(`${base}/tally/v1/registers/${r}`, { headers: { Authorization: superAdmin() } });
    return (await response.json()).closures.items[0];
  }

  it('1. a manager with ApproveTallyPosVariance gets a proof; only its sha256 is stored, with the manager as approvedBy', async () => {
    const { s } = await session();
    const { status, body } = await approve(request(s));
    expect(status).toBe(200);
    expect(body).toEqual({ approval: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), approvedBy: manager.userId, approvedByName: 'Mia Manager',
      expiresAt: expect.any(String) });
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
    const row = await approvals().findOneByOrFail({ tokenHash: sha256(body.approval) });
    expect(row).toMatchObject({ sessionId: s, variance: { cash: 600 }, approvedBy: manager.userId, targetIdentifier: manager.email, usedAt: null });
    expect(JSON.stringify(row)).not.toContain(body.approval);
  });

  it('2. a wrong password and an unknown username answer the identical 401, and both rows count as failures', async () => {
    const { s } = await session();
    const auth = await cashier();
    const wrong = await approve(request(s, { password: 'not-the-password' }), auth);
    const unknown = await approve(request(s, { username: `${uuid()}@nobody.example` }), auth);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(INVALID);
    expect(unknown.body).toEqual(wrong.body);
    const headers = (h: Headers) => [...h.entries()].filter(([name]) => name !== 'date');
    expect(headers(unknown.headers)).toEqual(headers(wrong.headers));
    expect(await approvals().countBy({ sessionId: s, tokenHash: IsNull() })).toBe(2);
  });

  it('3. the 6th failure from one cashier, and the 11th for one username from cashiers under their own limit, answer 429', async () => {
    const { s } = await session();
    const one = await cashier();
    for (let i = 0; i < 5; i++) expect((await approve(request(s, { username: `${uuid()}@nobody.example` }), one)).status).toBe(401);
    expect(await approve(request(s, { username: `${uuid()}@nobody.example` }), one)).toMatchObject({ status: 429,
      body: { code: 'approval_rate_limited', message: 'Too many failed approvals. Try again in a few minutes.' } });
    const target = `${uuid()}@target.example`;
    for (const auth of [await cashier(), await cashier()]) {
      for (let i = 0; i < 5; i++) expect((await approve(request(s, { username: `  ${target.toUpperCase()} ` }), auth)).status).toBe(401);
    }
    expect((await approve(request(s, { username: target }), await cashier())).body.code).toBe('approval_rate_limited');
  });

  it("4. an administrator without ApproveTallyPosVariance gets 403; a customer's correct credentials get the unknown username's 401", async () => {
    const { s } = await session();
    const auth = await cashier();
    const clerk = await admin(['ReadOrder']);
    expect(await approve(request(s, { username: clerk.email }), auth)).toMatchObject({ status: 403,
      body: { code: 'approval_forbidden', message: "This user can't approve register variances." } });
    const email = `${uuid()}@customer.example`;
    await adminClient.query(parse(`mutation C($input: CreateCustomerInput!, $password: String) { createCustomer(input: $input, password: $password) {
      ... on Customer { id } } }`), { input: { firstName: 'Cus', lastName: 'Tomer', emailAddress: email }, password: 'secret-password' });
    const shopLogin = await environment.shopClient.query(parse(`mutation { login(username: "${email}", password: "secret-password") {
      ... on CurrentUser { id } ... on ErrorResult { errorCode } } }`));
    expect(shopLogin.login).toEqual({ id: expect.any(String) });
    const customer = await approve(request(s, { username: email }), auth);
    const nobody = await approve(request(s, { username: `${uuid()}@nobody.example` }), auth);
    expect([customer.status, nobody.status]).toEqual([401, 401]);
    expect(customer.body).toEqual(nobody.body);
    expect(await approvals().countBy({ sessionId: s, tokenHash: IsNull() })).toBe(3);
  });

  it('5. an unknown session answers 404 and a closed one 409', async () => {
    expect(await approve(request(uuid()))).toMatchObject({ status: 404, body: { code: 'approval_session_unknown' } });
    const { s, r } = await session();
    expect(await send(closure(s, r, 10000))).toMatchObject({ status: 'applied' });
    expect(await approve(request(s))).toMatchObject({ status: 409, body: { code: 'approval_session_closed' } });
  });

  it('6. no Logger call carries the password, the proof or its hash while approving and failing', async () => {
    const spies = (['error', 'warn', 'info', 'verbose', 'debug'] as const).map(level => vi.spyOn(Logger, level));
    try {
      const { s } = await session();
      const proof = await proofFor(s);
      const auth = await cashier();
      await approve(request(s, { password: 'wrong-secret' }), auth);
      await approve(request(s, { username: `${uuid()}@nobody.example` }), auth);
      const logged = JSON.stringify(spies.flatMap(spy => spy.mock.calls));
      for (const secret of ['secret-password', 'wrong-secret', proof, sha256(proof)]) expect(logged).not.toContain(secret);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('7. a successful approval creates no Vendure session for the manager', async () => {
    const count = async () => (await connection.rawConnection.query('SELECT count(*)::int AS n FROM "session" WHERE "userId" = $1', [manager.userId]))[0].n;
    const before = await count();
    const { s } = await session();
    await proofFor(s);
    expect(await count()).toBe(before);
  });

  it('8. over the threshold with no proof is register_approval_required, carrying the server variance, not counted − tillExpected', async () => {
    const { s, r } = await session();
    // The till expects 10600 (no variance on its side); the server expects 10000, so the variance is 600.
    await refused(closure(s, r, 10600), 'register_approval_required', `Session ${s} needs a manager's approval: its cash variance is over ${THRESHOLD}`,
      { sessionId: s, thresholdMinor: THRESHOLD, variance: { cash: 600 } });
  });

  it('9a. register_approval_invalid unknown: a proof the store never issued', async () => {
    const { s, r } = await session();
    await invalid(closure(s, r, 10600, { approval: 'never-issued' }), 'unknown');
  });

  it('9b. register_approval_invalid used: a proof that already closed a session', async () => {
    const first = await session();
    const proof = await proofFor(first.s);
    expect(await send(closure(first.s, first.r, 10600, { approval: proof }))).toMatchObject({ status: 'applied' });
    const second = await session();
    await invalid(closure(second.s, second.r, 10600, { approval: proof }), 'used');
  });

  it('9c. register_approval_invalid expired: a proof past its expiresAt', async () => {
    const { s, r } = await session();
    const proof = await proofFor(s);
    await approvals().update({ tokenHash: sha256(proof) }, { expiresAt: new Date(Date.now() - 1000) });
    await invalid(closure(s, r, 10600, { approval: proof }), 'expired');
  });

  it('9d. register_approval_invalid session_mismatch: a proof for another session', async () => {
    const other = await session();
    const { s, r } = await session();
    await invalid(closure(s, r, 10600, { approval: await proofFor(other.s) }), 'session_mismatch');
  });

  it('9e. register_approval_invalid variance_mismatch: a proof for another variance', async () => {
    const { s, r } = await session();
    await invalid(closure(s, r, 10600, { approval: await proofFor(s, { cash: 700 }) }), 'variance_mismatch');
  });

  it("10. a valid proof applies with the manager's approvedBy, reads approvalVerified: true and marks the approval used", async () => {
    const { s, r } = await session();
    const proof = await proofFor(s);
    const command = closure(s, r, 10600, { approval: proof, approvedBy: 'till-label' });
    expect(await send(command)).toMatchObject({ status: 'applied', register: { closure: { variance: { cash: 600 }, approvalVerified: true } } });
    expect(await closureRead(r)).toMatchObject({ closureId: command.payload.closureId, approvedBy: manager.userId, approvalVerified: true });
    expect(await approvals().findOneByOrFail({ tokenHash: sha256(proof) })).toMatchObject({
      usedAt: expect.any(Date), usedByCommandId: command.id, closureId: command.payload.closureId });
  });

  it('11. a proof minted in one channel is unknown to a closure in another', async () => {
    await channel('approval-b');
    const a = await session();
    const proof = await proofFor(a.s);
    const b = await session(3, 'approval-b-token');
    const command = closure(b.s, b.r, 10600, { approval: proof });
    expect(await send(command, 'approval-b-token')).toEqual({ id: command.id, status: 'rejected', error: { code: 'register_approval_invalid',
      message: 'The approval is not valid for this closure: unknown', data: { reason: 'unknown' } } });
  });

  it('12. a v2 closure over the threshold needs approval on a session opened at v3, and applies unverified on one opened at v2', async () => {
    const v3 = await session(3);
    await refused(closure(v3.s, v3.r, 10600, {}, 2), 'register_approval_required',
      `Session ${v3.s} needs a manager's approval: its cash variance is over ${THRESHOLD}`, { sessionId: v3.s, thresholdMinor: THRESHOLD, variance: { cash: 600 } });
    const v2 = await session(2);
    const applied = await send(closure(v2.s, v2.r, 10600, { approvedBy: 'manager-1' }, 2));
    expect(applied).toMatchObject({ status: 'applied', register: { closure: { variance: { cash: 600 } } } });
    expect(applied.register!.closure).not.toHaveProperty('approvalVerified');
    expect(await closureRead(v2.r)).toMatchObject({ approvedBy: 'manager-1', approvalVerified: false });
  });

  it("13. a transition's approvedBy never becomes a closure's approver", async () => {
    const under = await session();
    expect(await send(transition(under.s))).toMatchObject({ status: 'applied' });
    expect(await send(closure(under.s, under.r, 10100, { approvedBy: 'mallory' }))).toMatchObject({ status: 'applied',
      register: { closure: { approvalVerified: false } } });
    expect(await closureRead(under.r)).toMatchObject({ approvedBy: null, approvalVerified: false });
    const over = await session();
    const proof = await proofFor(over.s);
    expect(await send(transition(over.s))).toMatchObject({ status: 'applied' });
    expect(await send(closure(over.s, over.r, 10600, { approval: proof }))).toMatchObject({ status: 'applied' });
    expect(await closureRead(over.r)).toMatchObject({ approvedBy: manager.userId, approvalVerified: true });
  });

  it('14. with the option off, a v3 closure over the would-be threshold applies without a proof', async () => {
    const saved = TallyPosPlugin.options.registerApproval;
    TallyPosPlugin.options.registerApproval = undefined;
    try {
      const { s, r } = await session();
      expect(await send(closure(s, r, 10600))).toMatchObject({ status: 'applied', register: { closure: { approvalVerified: false } } });
      expect(await closureRead(r)).toMatchObject({ approvedBy: null, approvalVerified: false });
    } finally {
      TallyPosPlugin.options.registerApproval = saved;
    }
  });

  it('16. a closure stored as a v2 closure would be reads approvalVerified: false, its approvedBy as the till sent it', async () => {
    const { s, r } = await session(2);
    expect(await send(closure(s, r, 10000, { approvedBy: 'manager-1' }, 2))).toMatchObject({ status: 'applied' });
    expect(await closureRead(r)).toMatchObject({ approvedBy: 'manager-1', approvalVerified: false });
  });

  it('17. a closure whose counted has no cash key is held to the server cash variance, and a proof for it applies', async () => {
    const { s, r } = await session();
    // deriveVariance maps only counted's keys; the server still expects the 10000 float in cash.
    const command = closure(s, r, 0, { tillExpected: {}, counted: {} });
    await refused(command, 'register_approval_required', `Session ${s} needs a manager's approval: its cash variance is over ${THRESHOLD}`,
      { sessionId: s, thresholdMinor: THRESHOLD, variance: { cash: -10000 } });
    const applied = await send(resend(command, await proofFor(s, { cash: -10000 })));
    expect(applied).toMatchObject({ status: 'applied', register: { closure: { approvalVerified: true } } });
    expect((applied as { register: { closure: { variance: unknown } } }).register.closure.variance).toEqual({});
    // The stored and applied variance stay deriveVariance's output (counted has no keys), not the approval's cash figure.
    const row = await connection.rawConnection.getRepository(TallyRegisterClosure).findOneByOrFail({ id: String(command.payload.closureId) });
    expect(row.variance).toEqual({});
  });

  let approvedAfterTransition: string;
  it('18. a session the till transitioned to closed is admitted, and its refused closure resent with the proof applies', async () => {
    const { s, r } = await session();
    expect(await send(transition(s))).toMatchObject({ status: 'applied' });
    const command = closure(s, r, 10600);
    expect(await send(command)).toMatchObject({ status: 'rejected', error: { code: 'register_approval_required' } });
    expect(await send(resend(command, await proofFor(s)))).toMatchObject({ status: 'applied', register: { closure: { approvalVerified: true } } });
    expect(await closureRead(r)).toMatchObject({ approvedBy: manager.userId, approvalVerified: true });
    approvedAfterTransition = s;
  });

  it("18b. once test 18's closure has applied, its session answers 409", async () => {
    expect(approvedAfterTransition).toBeDefined();
    expect(await approve(request(approvedAfterTransition))).toMatchObject({ status: 409, body: { code: 'approval_session_closed' } });
  });

  it('19. a superseded session answers 409', async () => {
    const { s, r } = await session();
    // A takeover from another till, at v3 as #334 requires; the same device would resume instead.
    const takeover = { ...envelope('register.session.open', 3, { sessionId: uuid(), registerId: r, openedAt: AT, countedFloatMinor: 10000,
      supersedes: s }), deviceId: 'till-2' };
    expect(await send(takeover)).toMatchObject({ status: 'applied', register: { superseded: { sessionId: s } } });
    expect(await approve(request(s))).toMatchObject({ status: 409, body: { code: 'approval_session_closed' } });
  });

  it('20. ApproveTallyPosVariance held only on another channel answers 403 for a session in this one', async () => {
    const elsewhere = await admin(['ApproveTallyPosVariance'], 'Else', 'Where', [await channel('approval-c')]);
    const { s } = await session();
    expect(await approve(request(s, { username: elsewhere.email }), await cashier())).toMatchObject({ status: 403,
      body: { code: 'approval_forbidden' } });
  });

  it("21. a SuperAdmin approves, and the closure stores the superadmin's user id as approvedBy", async () => {
    const { me } = await adminClient.query<{ me: { id: string } }>(parse('query { me { id } }'));
    const { s, r } = await session();
    const asCashier = await cashier();
    // Vendure gives the SuperAdmin role every assignable permission; take ours off so only SuperAdmin itself can admit it.
    const roles = connection.rawConnection.getRepository(Role);
    const role = await roles.findOneByOrFail({ code: SUPER_ADMIN_ROLE_CODE });
    await roles.update(role.id, { permissions: role.permissions.filter(permission => String(permission) !== 'ApproveTallyPosVariance') });
    let result: Awaited<ReturnType<typeof approve>>;
    try {
      result = await approve(request(s, { username: 'superadmin', password: 'superadmin' }), asCashier);
    } finally {
      await roles.update(role.id, { permissions: role.permissions });
    }
    const { status, body } = result;
    expect(role.permissions).toContain('ApproveTallyPosVariance');
    expect(status).toBe(200);
    expect(await send(closure(s, r, 10600, { approval: body.approval }))).toMatchObject({ status: 'applied' });
    expect(await closureRead(r)).toMatchObject({ approvedBy: decode(me.id), approvalVerified: true });
  });

  it('22. with the option set, a session opened at v2 closes over the threshold unapproved, and its record says so', async () => {
    const { s, r } = await session(2);
    expect(await send(closure(s, r, 10600, {}, 2))).toMatchObject({ status: 'applied' });
    expect(await closureRead(r)).toMatchObject({ approvedBy: null, approvalVerified: false });
  });

  // #334: while the option is set, a new session opens only at v3; a resume or a replay still answers as before.
  const sessions = () => connection.rawConnection.getRepository(TallyRegisterSession);
  async function needsV3(command: RegisterEnvelope) {
    expect(await send(command)).toEqual({ id: command.id, status: 'rejected', error: { code: 'unsupported_version',
      message: `register version ${command.version} cannot open a new session while manager approval is required; this server needs 3`,
      data: { register: 3 } } });
    expect(await ledger(command)).toBeNull();
    expect(await sessions().findOneBy({ id: String(command.payload.sessionId) })).toBeNull();
  }

  let refusedV1: RegisterEnvelope;
  it('23. a v1 open of a fresh session is refused unsupported_version, and nothing is stored', async () => {
    refusedV1 = open(uuid(), uuid(), 1);
    await needsV3(refusedV1);
  });

  it('24. a v2 open of a fresh session, and a v2 take-over, are refused the same way; the live session stays open', async () => {
    await needsV3(open(uuid(), uuid(), 2));
    const { s, r } = await session();
    await needsV3({ ...envelope('register.session.open', 2, { sessionId: uuid(), registerId: r, openedAt: AT, countedFloatMinor: 10000,
      supersedes: s }), deviceId: 'till-2' });
    const read = await fetch(`${base}/tally/v1/registers/${r}`, { headers: { Authorization: superAdmin() } });
    expect((await read.json()).session).toMatchObject({ id: s, status: 'open' });
  });

  it("25. test 23's command id and payload, resent at v3, apply", async () => {
    expect(refusedV1).toBeDefined();
    expect(await send({ ...refusedV1, version: 3 })).toMatchObject({ id: refusedV1.id, status: 'applied',
      register: { session: { id: refusedV1.payload.sessionId } } });
  });

  it('26. a v2 open stored with the option off replays its stored result once the option is on', async () => {
    const command = open(uuid(), uuid(), 2);
    const stored = await withoutApproval(command);
    expect(stored).toMatchObject({ status: 'applied' });
    expect(await send(command)).toEqual({ ...stored, status: 'duplicate' });
  });

  it('27. a v1 session resumes at v1 from the same device, with no new session row', async () => {
    const { s, r } = await session(1);
    expect(await send(open(s, r, 1))).toMatchObject({ status: 'applied', register: { session: { id: s } } });
    expect(await sessions().countBy({ registerId: r })).toBe(1);
  });

  it('28. a v2 session resumes at v2 from the same device under a new session id, which aliases the live session', async () => {
    const { s, r } = await session(2);
    const alias = uuid();
    expect(await send(open(alias, r, 2))).toMatchObject({ status: 'applied',
      register: { session: { id: s }, resumed: { fromSessionId: alias } } });
    expect(await connection.rawConnection.getRepository(TallyRegisterSessionAlias).findOneBy({ id: alias })).toMatchObject({ sessionId: s });
    expect(await sessions().countBy({ registerId: r })).toBe(1);
  });
});
