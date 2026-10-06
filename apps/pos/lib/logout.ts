import type { Session } from './session';

// How long sign-out waits for the server logout before aborting the request.
export const LOGOUT_WAIT_MS = 3_000;

/** Best-effort Vendure logout. Never rejects. */
export async function logout(session: Pick<Session, 'url' | 'token' | 'kind'>, waitMs = LOGOUT_WAIT_MS): Promise<'ok' | 'failed'> {
  // Sign-out forgets the device; the key stays valid until revoked on the Dashboard (ADR 0004).
  if (session.kind === 'api-key') return 'ok';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), waitMs);
  try {
    const response = await fetch(`${session.url}/admin-api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${session.token}`,
        // An unknown channel token makes Vendure refuse the request before logout runs; sessions are not tied to a channel.
      },
      body: JSON.stringify({ query: 'mutation { logout { success } }' }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error();
    const body = await response.json();
    if (body.errors?.length || body.data?.logout?.success !== true) throw new Error();
    return 'ok';
  } catch {
    console.warn('Vendure logout failed.');
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}
