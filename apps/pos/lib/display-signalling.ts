import { DisplaySignallingError } from '@tallyui/core';
import type { DisplaySignalling, DisplaySignallingContext, DisplaySignallingErrorCode, SyncContext, TillDevice } from '@tallyui/core';

// Every code of DisplaySignallingErrorCode (@tallyui/core); a refusal naming any other code is 'server'.
const SEAM_CODES: readonly DisplaySignallingErrorCode[] = [
  'forbidden', 'limit', 'claim_refused', 'collect_refused', 'not_found', 'device_refused', 'token_refused', 'too_large', 'network',
  'server',
];

const isAbort = (error: unknown) => (error as { name?: unknown } | null)?.name === 'AbortError';

/** One call of the plugin's display routes; every failure but an abort is the seam's error. */
async function call<T>(
  baseUrl: string, doFetch: typeof fetch, method: string, path: string,
  headers: Record<string, string>, body?: unknown, signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  let text: string;
  try {
    response = await doFetch(`${baseUrl}/tally/v1/${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    text = await response.text();
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new DisplaySignallingError('network');
  }
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    if (response.ok) throw new DisplaySignallingError('server', 'The server answered with a body that is not JSON.');
  }
  if (!response.ok) {
    const { code, message } = (parsed ?? {}) as { code?: unknown; message?: unknown };
    const known = SEAM_CODES.find(seam => seam === code) ?? 'server';
    throw new DisplaySignallingError(known, typeof message === 'string' ? message : undefined);
  }
  return parsed as T;
}

/** The till's client of the plugin's customer-display routes (`packages/vendure-plugin/src/api/displays.controller.ts`). */
export function createDisplaySignalling(): DisplaySignalling {
  const session = (ctx: SyncContext, deviceId: string, more: Record<string, string> = {}) =>
    <T>(method: string, path: string, body?: unknown) =>
      call<T>(ctx.baseUrl, fetch, method, path, { ...ctx.headers, 'X-Tally-Device-Id': deviceId, ...more }, body, ctx.signal);
  // Every till route takes the device's key beside its id; only registerDevice, which issues the key, goes without.
  const till = (ctx: SyncContext, device: TillDevice) => session(ctx, device.deviceId, { 'X-Tally-Device-Key': device.deviceKey });
  const display = (d: DisplaySignallingContext, token?: string) => <T>(method: string, path: string, body?: unknown) =>
    call<T>(d.baseUrl, d.fetch ?? fetch, method, path, token === undefined ? {} : { 'X-Tally-Display-Token': token }, body);
  const id = encodeURIComponent;
  type Items = { items: never[] };
  return {
    registerDevice: async (ctx, deviceId) => {
      const { deviceKey } = (await session(ctx, deviceId)<{ deviceKey?: unknown } | undefined>('POST', 'displays/device')) ?? {};
      if (typeof deviceKey !== 'string' || !deviceKey) throw new DisplaySignallingError('server', 'The server answered with no device key.');
      return { deviceKey };
    },
    mint: (ctx, device) => till(ctx, device)('POST', 'displays/codes'),
    pending: async (ctx, device) => (await till(ctx, device)<Items>('GET', 'displays/pending')).items,
    confirm: async (ctx, device, claimId) => { await till(ctx, device)('POST', `displays/pending/${id(claimId)}/confirm`); },
    decline: async (ctx, device, claimId) => { await till(ctx, device)('POST', `displays/pending/${id(claimId)}/decline`); },
    list: async (ctx, device) => (await till(ctx, device)<Items>('GET', 'displays')).items,
    forget: async (ctx, device, displayId) => { await till(ctx, device)('DELETE', `displays/${id(displayId)}`); },
    sendSignal: async (ctx, device, displayId, message) => { await till(ctx, device)('POST', `displays/${id(displayId)}/signals`, message); },
    receiveSignals: async (ctx, device) => (await till(ctx, device)<Items>('GET', 'displays/signals')).items,
    postSnapshot: async (ctx, device, displayId, body) => {
      await till(ctx, device)('PUT', `displays/${id(displayId)}/snapshot`, { snapshot: body });
    },
    claim: (d, request) => display(d)('POST', 'display/claim', request),
    collect: (d, claimSecret) => display(d)('POST', 'display/collect', { claimSecret }),
    displaySendSignal: async (d, token, message) => { await display(d, token)('POST', 'display/signals', message); },
    displayReceiveSignals: async (d, token) => (await display(d, token)<Items>('GET', 'display/signals')).items,
    readSnapshot: async (d, token) => (await display(d, token)<{ snapshot: unknown }>('GET', 'display/snapshot')).snapshot,
  };
}
