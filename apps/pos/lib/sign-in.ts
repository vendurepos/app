import {
  vendureSignIn, vendureStoreSettings, vendureGlobalStockSettings,
} from '@tallyui/connector-vendure';
import { SignInError } from '@tallyui/core';
import { hasVariantCustomField, isFieldName } from './barcode-field';
import { logout } from './logout';
import { sessionContext, type Session } from './session';
import { normalizeStoreUrl } from './store-url';

export type SignInOutcome = { ok: true; session: Session } | { ok: false; error: string };

/** `values` is keyed by vendureAuth.fields keys plus the app's barcode_field setting. */
export async function signIn(
  values: Record<string, string | undefined>,
  init?: { signal?: AbortSignal },
): Promise<SignInOutcome> {
  const normalized = normalizeStoreUrl(values.url ?? '');
  if (!normalized.ok) return normalized;
  const email = values.email?.trim();
  const password = values.password ?? '';
  if (!email || !password) return { ok: false, error: 'Enter your email and password.' };
  const channelToken = values.channel_token?.trim() || undefined;
  const barcodeField = values.barcode_field?.trim() || undefined;
  if (barcodeField && !isFieldName(barcodeField)) {
    return { ok: false, error: 'Enter the custom field name, such as barcode.' };
  }
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
    if (barcodeField && !await hasVariantCustomField(context, barcodeField)) {
      void logout({ url: normalized.url, token });
      return { ok: false, error: `This store's product variants have no custom field named "${barcodeField}".` };
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
