import {
  vendureSignIn, vendureStoreSettings, vendureGlobalStockSettings,
} from '@tallyui/connector-vendure';
import { SignInError } from '@tallyui/core';
import { checkBarcodeField, isFieldName } from './barcode-field';
import { logout } from './logout';
import { merchantTextError } from './merchant-text';
import { DEVICE_KEY_FALLBACK_NAME, sessionContext, type Session } from './session';
import { normalizeStoreUrl } from './store-url';

export type SignInOutcome = { ok: true; session: Session } | { ok: false; error: string };

/** Signs in with password or api-key credentials plus the app's barcode_field setting. */
export async function signIn(
  values: Record<string, string | undefined>,
  init?: { signal?: AbortSignal },
): Promise<SignInOutcome> {
  if (values.kind === 'api-key') return signInWithDeviceKey(values, init);
  const normalized = normalizeStoreUrl(values.url ?? '');
  if (!normalized.ok) return normalized;
  const email = values.email?.trim();
  const password = values.password ?? '';
  if (!email || !password) return { ok: false, error: 'Enter your email and password.' };
  const { channelToken, barcodeField, error: fieldError } = signInFields(values);
  if (fieldError) return { ok: false, error: fieldError };
  let signedIn = false;
  let token = '';
  try {
    ({ token } = await vendureSignIn(normalized.url, { email, password }, { signal: init?.signal }));
    signedIn = true;
    // Provisional settings are used only to build the authenticated context.
    const session: Session = {
      url: normalized.url, channelToken, email, token, ...(barcodeField ? { barcodeField } : {}),
      settings: { currency: '', pricesIncludeTax: false, taxRatesPpm: { default: 0 } },
      stock: { trackInventory: false, outOfStockThreshold: 0 },
    };
    const context = { ...sessionContext(session), signal: init?.signal };
    const [settings, stock] = await Promise.all([
      vendureStoreSettings(context),
      vendureGlobalStockSettings(context),
    ]);
    if (barcodeField) {
      const check = await checkBarcodeField(context, barcodeField);
      if (check !== 'ok') {
        void logout({ url: normalized.url, token });
        return { ok: false, error: check === 'missing'
          ? `This store's product variants have no custom field named "${barcodeField}".`
          : check === 'wrong_type' ? `The custom field "${barcodeField}" is not a single text field, so it cannot hold barcodes.`
            : `Could not check the barcode field: ${check.error}` };
      }
    }
    return { ok: true, session: { ...session, settings, stock } };
  } catch (error) {
    if (signedIn) void logout({ url: normalized.url, token });
    if ((error as { name?: unknown })?.name === 'AbortError') throw error;
    // StoreSettingsError may wrap the signal's original AbortError.
    if (init?.signal?.aborted && init.signal.reason?.name === 'AbortError') throw init.signal.reason;
    const message = error instanceof Error ? error.message : String(error);
    if (signedIn) return {
      ok: false,
      error: `Could not read the store settings: ${message}${channelToken ? ' Check the channel token.' : ''}`,
    };
    return {
      ok: false,
      error: error instanceof SignInError && error.code === 'invalid_credentials'
        ? 'Email or password is incorrect.' : message,
    };
  }
}

function signInFields(values: Record<string, string | undefined>) {
  const channelToken = values.channel_token?.trim() || undefined;
  const barcodeField = values.barcode_field?.trim() || undefined;
  const error = (barcodeField ? merchantTextError('Barcode field', barcodeField) : null) ||
    (barcodeField && !isFieldName(barcodeField) ? 'Enter the custom field name, such as barcode.' : null);
  return { channelToken, barcodeField, error };
}

async function signInWithDeviceKey(values: Record<string, string | undefined>, init?: { signal?: AbortSignal }): Promise<SignInOutcome> {
  const normalized = normalizeStoreUrl(values.url ?? '');
  if (!normalized.ok) return normalized;
  const apiKey = values.api_key?.trim();
  if (!apiKey) return { ok: false, error: 'Enter the device key.' };
  const { channelToken, barcodeField, error: fieldError } = signInFields(values);
  if (fieldError) return { ok: false, error: fieldError };
  const provisional: Session = {
    kind: 'api-key', url: normalized.url, channelToken, apiKey, email: '', token: '', ...(barcodeField ? { barcodeField } : {}),
    settings: { currency: '', pricesIncludeTax: false, taxRatesPpm: { default: 0 } },
    stock: { trackInventory: false, outOfStockThreshold: 0 },
  };
  let checkedKey = false;
  try {
    const response = await fetch(`${normalized.url}/tally/v1/info`, { headers: sessionContext(provisional).headers, signal: init?.signal });
    if (response.status === 401 || response.status === 403) return { ok: false,
      error: 'This device key was refused. Check the key, or create a new one on the Dashboard\'s API keys page.' };
    if (response.status === 404) return { ok: false, error: 'The VendurePOS plugin was not found on this store. Install @vendurepos/plugin, then sign in again.' };
    if (!response.ok) return { ok: false, error: `The store answered HTTP ${response.status} when checking the device key.` };
    const body = await response.json().catch((error: unknown) => {
      if ((error as { name?: unknown })?.name === 'AbortError') throw error;
      return null;
    });
    const device = (typeof body?.device?.name === 'string' && body.device.name.trim()) || DEVICE_KEY_FALLBACK_NAME;
    checkedKey = true;
    const context = { ...sessionContext(provisional), signal: init?.signal };
    const [settings, stock] = await Promise.all([vendureStoreSettings(context), vendureGlobalStockSettings(context)]);
    if (barcodeField) {
      const check = await checkBarcodeField(context, barcodeField);
      if (check !== 'ok') return { ok: false, error: check === 'missing'
        ? `This store's product variants have no custom field named "${barcodeField}".`
        : check === 'wrong_type' ? `The custom field "${barcodeField}" is not a single text field, so it cannot hold barcodes.`
          : `Could not check the barcode field: ${check.error}` };
    }
    return { ok: true, session: { ...provisional, device, settings, stock } };
  } catch (error) {
    if ((error as { name?: unknown })?.name === 'AbortError') throw error;
    if (init?.signal?.aborted && init.signal.reason?.name === 'AbortError') throw init.signal.reason;
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: checkedKey
      ? `Could not read the store settings: ${message}${channelToken ? ' Check the channel token.' : ''}`
      : `Could not reach Vendure at ${normalized.url}: ${message}` };
  }
}
