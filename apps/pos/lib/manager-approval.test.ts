import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerCapabilities } from '@tallyui/core';
import { SESSION_ENDED_TEXT } from './catalogue-status';
import { approvalVariance, requestManagerApproval, usesStoreApproval } from './manager-approval';
import { STORE_UNREACHABLE_TEXT } from './remote-x-report';
import { sessionContext, type Session } from './session';

const session = { url: 'https://shop.example.com', token: 'till-token', channelToken: 'chan' } as Session;
const PASSWORD = 'hunter2-manager-secret';
const input = { sessionId: 'sess-1', variance: { cash: -1000 }, username: 'manager', password: PASSWORD };
const fetchMock = vi.fn<typeof fetch>();
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
