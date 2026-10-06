import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logout } from './logout';

const session = { url: 'https://shop.example.com', token: 'secret-session-token', channelToken: 'secret-channel-token' };
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  const warnings = JSON.stringify(vi.mocked(console.warn).mock.calls);
  expect(warnings).not.toContain(session.token);
  expect(warnings).not.toContain(session.channelToken);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('logout', () => {
  it('forgets a device-key session without a logout request', async () => {
    expect(await logout({ ...session, kind: 'api-key', token: '' })).toBe('ok');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the mutation without a channel header even when the session has a channel token', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: { logout: { success: true } } }));
    expect(await logout(session)).toBe('ok');
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${session.url}/admin-api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ query: 'mutation { logout { success } }' }),
      signal: expect.any(AbortSignal),
    });
    expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty('vendure-token');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('omits the channel header for the default channel', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: { logout: { success: true } } }));
    expect(await logout({ url: session.url, token: session.token })).toBe('ok');
    expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty('vendure-token');
  });

  it.each([
    ['network error', () => Promise.reject(new Error(session.token))],
    ['GraphQL error', () => Promise.resolve(Response.json({ errors: [{ message: session.token }], data: { logout: { success: true } } }))],
    ['non-OK status', () => Promise.resolve(Response.json({ data: { logout: { success: true } } }, { status: 500 }))],
    ['bad JSON', () => Promise.resolve(new Response('not JSON'))],
    ['unsuccessful logout', () => Promise.resolve(Response.json({ data: { logout: { success: false } } }))],
    ['missing success', () => Promise.resolve(Response.json({ data: {} }))],
  ])('returns failed and warns once on %s', async (_name, response) => {
    fetchMock.mockImplementation(response);
    expect(await logout(session)).toBe('failed');
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('aborts a pending fetch after the timeout and warns once', async () => {
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    expect(await logout(session, 20)).toBe('failed');
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(console.warn).toHaveBeenCalledOnce();
  });
});
