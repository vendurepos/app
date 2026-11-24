import type { SyncContext } from '@tallyui/core';
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
async function infoPermissions(context: SyncContext): Promise<string[] | undefined> {
  try {
    const response = await fetch(`${context.baseUrl}/tally/v1/info`, { headers: context.headers, signal: context.signal });
    if (!response.ok) return undefined;
    const permissions = (await response.json())?.permissions;
    return isStringArray(permissions) ? permissions : undefined;
  } catch { return undefined; }
}
async function mePermissions(context: SyncContext): Promise<string[] | undefined> {
  try {
    const query = 'query TillPermissions { me { channels { id permissions } } activeChannel { id } }';
    const response = await fetch(`${context.baseUrl}/admin-api`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers },
      signal: context.signal, body: JSON.stringify({ query }) });
    if (!response.ok) return undefined;
    const body = await response.json();
    if (body?.errors?.length || !body?.data?.me) return undefined;
    const channel = body.data.me.channels?.find((channel: { id: string }) => channel.id === body.data.activeChannel?.id);
    return !channel ? [] : isStringArray(channel.permissions) ? channel.permissions : undefined;
  } catch { return undefined; }
}

/** #487: the till's permissions on the active channel: /tally/v1/info's `permissions`, else (an older plugin) Admin `me`; undefined when neither answers. */
export async function channelPermissions(context: SyncContext): Promise<string[] | undefined> {
  return (await infoPermissions(context)) ?? mePermissions(context);
}
