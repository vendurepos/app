export type StoreUrlResult = { ok: true; url: string } | { ok: false; error: string };

export function normalizeStoreUrl(input: string, pageProtocol: string | undefined = globalThis.location?.protocol): StoreUrlResult {
  const value = input.trim();
  if (!value) return { ok: false, error: 'Enter your Vendure server URL.' };
  let parsed: URL;
  try {
    parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
  } catch {
    return { ok: false, error: 'Enter the full server URL, starting with https://.' };
  }

  if (parsed.protocol === 'http:') {
    const host = parsed.hostname;
    const octets = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.split('.').map(Number) : [];
    const loopback = host === 'localhost' || host.endsWith('.localhost') ||
      host === '[::1]' || octets[0] === 127;
    if (pageProtocol === 'https:' && !loopback) {
      return {
        ok: false,
        error: 'This POS is served over https://, so the browser blocks a plain http:// store. Use https:// for the store.',
      };
    }
    const privateIpv4 = octets.length === 4 && octets.every((n) => n >= 0 && n <= 255) && (
      octets[0] === 127 || octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
    const local = host === 'localhost' || host.endsWith('.localhost') ||
      host === '[::1]' || host.endsWith('.local') || privateIpv4;
    if (!local) {
      return {
        ok: false,
        error: 'Use https:// for this server. Plain http:// is only allowed for local and private network addresses.',
      };
    }
  }

  const pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/admin-api$/, '').replace(/\/+$/, '');
  return { ok: true, url: parsed.origin + pathname };
}
