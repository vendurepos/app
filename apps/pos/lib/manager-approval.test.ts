import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerCapabilities } from '@tallyui/core';
import { SESSION_ENDED_TEXT } from './catalogue-status';
import { approvalVariance, requestManagerApproval, requestReapproval, usesStoreApproval } from './manager-approval';
import { STORE_UNREACHABLE_TEXT } from './remote-x-report';
import { sessionContext, type Session } from './session';

const session = { url: 'https://shop.example.com', token: 'till-token', channelToken: 'chan' } as Session;
const PASSWORD = 'hunter2-manager-secret';
const input = { sessionId: 'sess-1', variance: { cash: -1000 }, username: 'manager', password: PASSWORD };
const fetchMock = vi.fn<typeof fetch>();
const INVALID_BODY = { code: 'approval_invalid_credentials', message: 'server text' };
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  for (const method of CONSOLE_METHODS) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  for (const method of CONSOLE_METHODS) expect(JSON.stringify(vi.mocked(console[method]).mock.calls)).not.toContain(PASSWORD);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const caps = (register: number, registerApproval?: { thresholdMinor: number }) =>
  ({ orderCreate: 5, register, ...(registerApproval ? { registerApproval } : {}) }) as ServerCapabilities;

describe('usesStoreApproval', () => {
  it('is true only at contract 3 with registerApproval and a session the store holds', () => {
    expect(usesStoreApproval(caps(3, { thresholdMinor: 500 }), true)).toBe(true);
  });
  it.each([
    ['contract 2', caps(2, { thresholdMinor: 500 }), true],
    ['no registerApproval', caps(3), true],
    ['a session the store does not hold', caps(3, { thresholdMinor: 500 }), false],
    ['no capabilities', undefined, true],
  ])('is false for %s', (_, capabilities, live) => {
    expect(usesStoreApproval(capabilities, live)).toBe(false);
  });
});

describe('approvalVariance', () => {
  it('is counted minus expected per key', () => {
    expect(approvalVariance({ cash: 9000, external: 2500 }, { cash: 10000, external: 2000 })).toEqual({ cash: -1000, external: 500 });
  });
});

describe('requestManagerApproval', () => {
  it('posts the four fields with the session headers and a JSON content type', async () => {
    fetchMock.mockResolvedValue(Response.json({ approval: 'proof', approvedBy: '7', approvedByName: 'Mia Manager', expiresAt: 'x' }));
    expect(await requestManagerApproval(session, input)).toEqual({ ok: true, approval: 'proof', approvedBy: '7', approvedByName: 'Mia Manager' });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${session.url}/tally/v1/register-approvals`, {
      method: 'POST', headers: { ...sessionContext(session).headers, 'content-type': 'application/json' }, body: expect.any(String),
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual(input);
  });

  it.each([
    [401, 'approval_invalid_credentials', 'The username or password is wrong.'],
    [403, 'approval_forbidden', "This user can't approve register variances."],
    [429, 'approval_rate_limited', 'Too many failed approvals. Try again in a few minutes.'],
    [404, 'approval_session_unknown', 'The store no longer has this register session open.'],
    [409, 'approval_session_closed', 'The store no longer has this register session open.'],
    [400, 'invalid_payload', "The store couldn't approve this count. Try again."],
    [404, 'approval_request_unknown', 'The store has no refused closure to approve for this session.'],
  ])('maps %i %s', async (status, code, message) => {
    fetchMock.mockResolvedValue(Response.json({ code, message: 'server text' }, { status }));
    expect(await requestManagerApproval(session, input)).toEqual({ ok: false, message });
  });

  it.each([401, 403])("reads the till's own %i (no approval code) as a session that ended", async (status) => {
    fetchMock.mockResolvedValue(Response.json({ message: 'Unauthorized' }, { status }));
    expect(await requestManagerApproval(session, input)).toEqual({ ok: false, message: SESSION_ENDED_TEXT });
  });

  it('says the store is unreachable when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError(`failed ${PASSWORD}`));
    expect(await requestManagerApproval(session, input)).toEqual({ ok: false, message: STORE_UNREACHABLE_TEXT });
  });

  it.each([
    ['a 200 without an approval', () => Response.json({ approvedBy: '7' })],
    ['a 500', () => new Response('boom', { status: 500 })],
  ])('falls back to try again for %s', async (_, response) => {
    fetchMock.mockResolvedValue(response());
    expect(await requestManagerApproval(session, input)).toEqual({ ok: false, message: "The store couldn't approve this count. Try again." });
  });
});

describe('4.3d: approval by closure id', () => {
  const byId = { sessionId: 'sess-1', closureId: 'closure-1', username: 'manager', password: PASSWORD };
  const sent = (call: number) => JSON.parse(fetchMock.mock.calls[call][1]?.body as string);
  const PROOF = { approval: 'proof', approvedBy: '7', approvedByName: 'Mia Manager', expiresAt: 'x' };
  const OK = { ok: true, approval: 'proof', approvedBy: '7', approvedByName: 'Mia Manager' };
  const legacy = () => Response.json({ code: 'invalid_payload', message: 'unknown field in the body' }, { status: 400 });

  it('requestManagerApproval with a closureId posts the four fields and no variance', async () => {
    fetchMock.mockResolvedValue(Response.json(PROOF));
    expect(await requestManagerApproval(session, byId)).toEqual(OK);
    expect(sent(0)).toEqual(byId);
  });

  it("requestReapproval posts the closure id alone, and a 400 invalid_payload (an older plugin) posts once more with the refusal's variance", async () => {
    fetchMock.mockResolvedValueOnce(legacy()).mockResolvedValueOnce(Response.json(PROOF));
    expect(await requestReapproval(session, { ...byId, variance: { cash: 600 } })).toEqual(OK);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(0)).toEqual(byId);
    expect(sent(1)).toEqual({ sessionId: 'sess-1', variance: { cash: 600 }, username: 'manager', password: PASSWORD });
  });

  it("shows the second answer after the fallback, with exactly 2 calls", async () => {
    fetchMock.mockResolvedValueOnce(legacy()).mockResolvedValueOnce(Response.json(INVALID_BODY, { status: 401 }));
    expect(await requestReapproval(session, { ...byId, variance: { cash: 600 } })).toEqual({ ok: false, message: 'The username or password is wrong.' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a first 404 approval_request_unknown makes no second call', async () => {
    fetchMock.mockResolvedValue(Response.json({ code: 'approval_request_unknown', message: 'x' }, { status: 404 }));
    expect(await requestReapproval(session, { ...byId, variance: { cash: 600 } }))
      .toEqual({ ok: false, message: 'The store has no refused closure to approve for this session.' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
