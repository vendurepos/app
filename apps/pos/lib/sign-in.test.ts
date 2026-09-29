import {
  vendureSignIn, vendureStoreSettings, vendureGlobalStockSettings,
} from '@tallyui/connector-vendure';
import { SignInError, StoreSettingsError } from '@tallyui/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkBarcodeField } from './barcode-field';
import { logout } from './logout';
import { signIn } from './sign-in';

vi.mock('./logout', () => ({ logout: vi.fn() }));
vi.mock('./barcode-field', async (importActual) => ({
  ...await importActual<typeof import('./barcode-field')>(), checkBarcodeField: vi.fn(),
}));

vi.mock('@tallyui/connector-vendure', async (importActual) => ({
  ...await importActual<typeof import('@tallyui/connector-vendure')>(),
  vendureSignIn: vi.fn(),
  vendureStoreSettings: vi.fn(),
  vendureGlobalStockSettings: vi.fn(),
}));

const values = {
  url: ' https://shop.example.com/admin-api/ ', email: ' cashier@example.com ',
  password: ' password with spaces ', channel_token: ' channel-1 ',
};
const settings = {
  currency: 'GBP', pricesIncludeTax: true, taxRatesPpm: { default: 200000 },
  pricingContext: { channel: 'channel-1' },
};
const stock = { trackInventory: true, outOfStockThreshold: 2 };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(logout).mockResolvedValue('failed');
  vi.mocked(vendureSignIn).mockResolvedValue({ token: 'test-token' });
  vi.mocked(vendureStoreSettings).mockResolvedValue(settings);
  vi.mocked(vendureGlobalStockSettings).mockResolvedValue(stock);
  vi.mocked(checkBarcodeField).mockResolvedValue('ok');
});

describe('signIn', () => {
  it('rejects an invalid barcode field before signing in', async () => {
    expect(await signIn({ ...values, barcode_field: 'x{y}' })).toEqual({
      ok: false, error: 'Enter the custom field name, such as barcode.',
    });
    expect(vendureSignIn).not.toHaveBeenCalled();
    expect(checkBarcodeField).not.toHaveBeenCalled();
  });

  it.each([
    ['a 256-character value', 'a'.repeat(256), 'Barcode field is too long: use at most 255 characters.'],
    ['a NUL character', 'bar\u0000code', 'Barcode field contains a NUL character; remove it.'],
  ])('rejects a barcode field with %s before signing in', async (_label, barcode_field, error) => {
    expect(await signIn({ ...values, barcode_field })).toEqual({ ok: false, error });
    expect(vendureSignIn).not.toHaveBeenCalled();
    expect(checkBarcodeField).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', 'This store\'s product variants have no custom field named "barcode".'],
    ['wrong_type', 'The custom field "barcode" is not a single text field, so it cannot hold barcodes.'],
    [{ error: 'HTTP 403' }, 'Could not check the barcode field: HTTP 403'],
  ] as const)('reports barcode check %j and starts logout without waiting', async (check, error) => {
    vi.mocked(checkBarcodeField).mockResolvedValue(check);
    vi.mocked(logout).mockReturnValue(new Promise(() => {}));
    expect(await signIn({ ...values, barcode_field: 'barcode' })).toEqual({
      ok: false, error,
    });
    expect(logout).toHaveBeenCalledExactlyOnceWith({ url: 'https://shop.example.com', token: 'test-token' });
  }, 1_000);

  it('checks and stores the trimmed barcode field after reading settings and stock', async () => {
    const signal = new AbortController().signal;
    vi.mocked(checkBarcodeField).mockImplementation(async () => {
      expect(vendureStoreSettings).toHaveBeenCalledTimes(1);
      expect(vendureGlobalStockSettings).toHaveBeenCalledTimes(1);
      return 'ok';
    });
    const result = await signIn({ ...values, barcode_field: ' barcode ' }, { signal });
    expect(result.ok && result.session.barcodeField).toBe('barcode');
    expect(checkBarcodeField).toHaveBeenCalledExactlyOnceWith({
      connectorId: 'vendure', baseUrl: 'https://shop.example.com', signal,
      headers: { Authorization: 'Bearer test-token', 'vendure-token': 'channel-1' },
    }, 'barcode');
    expect(logout).not.toHaveBeenCalled();
  });

  it.each([undefined, '   '])('omits barcode field %j without checking it', async (barcode_field) => {
    const result = await signIn({ ...values, barcode_field });
    expect(result.ok && result.session.barcodeField).toBeUndefined();
    expect(checkBarcodeField).not.toHaveBeenCalled();
  });

  it('returns the full session and sends credentials and channel headers at the correct stages', async () => {
    const signal = new AbortController().signal;
    expect(await signIn(values, { signal })).toEqual({
      ok: true,
      session: {
        url: 'https://shop.example.com', email: 'cashier@example.com',
        channelToken: 'channel-1', token: 'test-token', settings, stock,
      },
    });
    expect(vendureSignIn).toHaveBeenCalledExactlyOnceWith(
      'https://shop.example.com', { email: 'cashier@example.com', password: values.password }, { signal },
    );
    const context = {
      connectorId: 'vendure', baseUrl: 'https://shop.example.com', signal,
      headers: { Authorization: 'Bearer test-token', 'vendure-token': 'channel-1' },
    };
    expect(vendureStoreSettings).toHaveBeenCalledExactlyOnceWith(context);
    expect(vendureGlobalStockSettings).toHaveBeenCalledExactlyOnceWith(context);
    expect(logout).not.toHaveBeenCalled();
  });

  it.each([undefined, '   '])('uses the default channel for %j', async (channel_token) => {
    const result = await signIn({ ...values, channel_token });
    expect(result.ok && result.session.channelToken).toBeUndefined();
    expect(vendureStoreSettings).toHaveBeenCalledWith({
      connectorId: 'vendure', baseUrl: 'https://shop.example.com', signal: undefined,
      headers: { Authorization: 'Bearer test-token' },
    });
  });

  it.each([
    [new SignInError('invalid_credentials', 'Bad login'), 'Email or password is incorrect.'],
    [new SignInError('unsupported', 'Native auth is disabled.'), 'Native auth is disabled.'],
    [new SignInError('failed', 'Could not reach Vendure.'), 'Could not reach Vendure.'],
    [new SignInError('server_error', 'Server unavailable.'), 'Server unavailable.'],
    [new Error('Unexpected failure.'), 'Unexpected failure.'],
  ])('returns the sign-in failure message for %s', async (error, message) => {
    vi.mocked(vendureSignIn).mockRejectedValue(error);
    expect(await signIn(values)).toEqual({ ok: false, error: message });
    expect(logout).not.toHaveBeenCalled();
    expect(vendureStoreSettings).not.toHaveBeenCalled();
    expect(vendureGlobalStockSettings).not.toHaveBeenCalled();
  });

  it.each([
    ['settings', values.channel_token, ' Check the channel token.'],
    ['stock', values.channel_token, ' Check the channel token.'],
    ['settings', undefined, ''],
    ['stock', undefined, ''],
  ])('reports a %s read failure with channel token %j', async (stage, channel_token, hint) => {
    const message = 'Vendure GraphQL error: No Channel with the token "x" could be found';
    vi.mocked(stage === 'settings' ? vendureStoreSettings : vendureGlobalStockSettings)
      .mockRejectedValue(new StoreSettingsError('failed', message));
    expect(await signIn({ ...values, channel_token })).toEqual({
      ok: false, error: `Could not read the store settings: ${message}${hint}`,
    });
    expect(logout).toHaveBeenCalledExactlyOnceWith({
      url: 'https://shop.example.com', token: 'test-token',
    });
  });

  it('returns the settings error promptly when logout never resolves', async () => {
    vi.mocked(logout).mockReturnValue(new Promise(() => {}));
    vi.mocked(vendureStoreSettings).mockRejectedValue(new StoreSettingsError('failed', 'Settings unavailable.'));
    expect(await signIn(values)).toEqual({
      ok: false, error: 'Could not read the store settings: Settings unavailable. Check the channel token.',
    });
    expect(logout).toHaveBeenCalledExactlyOnceWith({
      url: 'https://shop.example.com', token: 'test-token',
    });
  }, 1_000);

  it.each([
    [{ url: 'shop.example.com' }, 'Enter the full server URL, starting with https://.'],
    [{ url: undefined }, 'Enter your Vendure server URL.'],
    [{ url: '', password: '' }, 'Enter your Vendure server URL.'],
    [{ password: '' }, 'Enter your email and password.'],
    [{ password: undefined }, 'Enter your email and password.'],
    [{ email: '   ' }, 'Enter your email and password.'],
    [{ email: undefined }, 'Enter your email and password.'],
  ])('rejects invalid fields %j before calling the connector', async (fields, error) => {
    expect(await signIn({ ...values, ...fields })).toEqual({ ok: false, error });
    expect(vendureSignIn).not.toHaveBeenCalled();
    expect(vendureStoreSettings).not.toHaveBeenCalled();
    expect(vendureGlobalStockSettings).not.toHaveBeenCalled();
  });

  it.each(['sign-in', 'settings', 'stock', 'barcode'])('rethrows AbortError at the %s stage', async (stage) => {
    const controller = new AbortController();
    controller.abort();
    const operation = stage === 'sign-in' ? vendureSignIn
      : stage === 'settings' ? vendureStoreSettings : stage === 'stock' ? vendureGlobalStockSettings : checkBarcodeField;
    vi.mocked(operation).mockRejectedValue(controller.signal.reason);
    await expect(signIn({ ...values, barcode_field: 'barcode' }, { signal: controller.signal })).rejects.toBe(controller.signal.reason);
    if (stage === 'sign-in') expect(logout).not.toHaveBeenCalled();
    else expect(logout).toHaveBeenCalledExactlyOnceWith({
      url: 'https://shop.example.com', token: 'test-token',
    });
  });

  it('rethrows the signal AbortError when store settings wraps it', async () => {
    const controller = new AbortController();
    const abortError = new DOMException('This operation was aborted', 'AbortError');
    vi.mocked(vendureStoreSettings).mockImplementation(async () => {
      controller.abort(abortError);
      throw new StoreSettingsError('failed', 'This operation was aborted');
    });
    await expect(signIn(values, { signal: controller.signal })).rejects.toBe(abortError);
    expect(logout).toHaveBeenCalledExactlyOnceWith({
      url: 'https://shop.example.com', token: 'test-token',
    });
  });
});
