import { DisplaySignallingError } from '@tallyui/core';
import type { DisplaySignalling, DisplaySignallingContext, DisplaySignallingErrorCode, SyncContext } from '@tallyui/core';

// Every code of DisplaySignallingErrorCode (@tallyui/core); a refusal naming any other code is 'server'.
const SEAM_CODES: readonly DisplaySignallingErrorCode[] = [
  'forbidden', 'limit', 'claim_refused', 'collect_refused', 'not_found', 'token_refused', 'too_large', 'network', 'server',
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
  const till = (ctx: SyncContext, deviceId: string) => <T>(method: string, path: string, body?: unknown) =>
    call<T>(ctx.baseUrl, fetch, method, path, { ...ctx.headers, 'X-Tally-Device-Id': deviceId }, body, ctx.signal);
  const display = (d: DisplaySignallingContext, token?: string) => <T>(method: string, path: string, body?: unknown) =>
    call<T>(d.baseUrl, d.fetch ?? fetch, method, path, token === undefined ? {} : { 'X-Tally-Display-Token': token }, body);
  const id = encodeURIComponent;
  type Items = { items: never[] };
  return {
    mint: (ctx, deviceId) => till(ctx, deviceId)('POST', 'displays/codes'),
    pending: async (ctx, deviceId) => (await till(ctx, deviceId)<Items>('GET', 'displays/pending')).items,
    confirm: async (ctx, deviceId, claimId) => { await till(ctx, deviceId)('POST', `displays/pending/${id(claimId)}/confirm`); },
    decline: async (ctx, deviceId, claimId) => { await till(ctx, deviceId)('POST', `displays/pending/${id(claimId)}/decline`); },
    list: async (ctx, deviceId) => (await till(ctx, deviceId)<Items>('GET', 'displays')).items,
    forget: async (ctx, deviceId, displayId) => { await till(ctx, deviceId)('DELETE', `displays/${id(displayId)}`); },
    sendSignal: async (ctx, deviceId, displayId, message) => { await till(ctx, deviceId)('POST', `displays/${id(displayId)}/signals`, message); },
    receiveSignals: async (ctx, deviceId) => (await till(ctx, deviceId)<Items>('GET', 'displays/signals')).items,
    postSnapshot: async (ctx, deviceId, displayId, body) => {
      await till(ctx, deviceId)('PUT', `displays/${id(displayId)}/snapshot`, { snapshot: body });
    },
    claim: (d, request) => display(d)('POST', 'display/claim', request),
    collect: (d, claimSecret) => display(d)('POST', 'display/collect', { claimSecret }),
    displaySendSignal: async (d, token, message) => { await display(d, token)('POST', 'display/signals', message); },
    displayReceiveSignals: async (d, token) => (await display(d, token)<Items>('GET', 'display/signals')).items,
    readSnapshot: async (d, token) => (await display(d, token)<{ snapshot: unknown }>('GET', 'display/snapshot')).snapshot,
  };
}
