import { useEffect, useRef, useState } from 'react';
import type { DisplayAdvertisement, DisplayRecord, DisplaySignalling, ServerCapabilities } from '@tallyui/core';
import {
  createLogger, createTillDevice, createTillDisplayService, createTillPairing, type DisplayConfig, type TillDisplayService, type TillPairing,
} from '@tallyui/pos';
import { DEMO_STORE_ORIGIN } from './demo/fetch';
import { createDisplaySignalling } from './display-signalling';
import { defaultStore, sessionContext, sessionKey, type KeyValueStore, type Session } from './session';
import { storeLabel } from './store-label';
import { displayDeviceId, displayDeviceKeys } from './till-ids';

// How long a display holds a completed sale before it goes idle; TallyUI sets no default.
export const AFTER_COMPLETE_MS = 10_000;

/** The till's customer display: the service's and the pairing's refused or failed calls. */
export const customerDisplayLogger = createLogger('customer-display');

/** One display's config: this store and channel, the device's locale and time zone, and the display's own record. */
export function displayConfig(session: Session, display: DisplayRecord): DisplayConfig {
  const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions();
  return {
    contract: '1.0',
    display: { id: display.displayId, name: display.name },
    store: {
      id: session.channelToken ? `${session.url}#${session.channelToken}` : session.url,
      name: storeLabel(session),
      currency: session.settings.currency,
      locale,
      timezone: timeZone,
    },
    presentation_hints: {},
    i18n: {},
    idle: { afterCompleteMs: AFTER_COMPLETE_MS },
  };
}

/** The store's display advertisement, or null where there is none: the demo store never pairs a display. */
export function customerDisplayAdvertisement(session: Session, capabilities?: ServerCapabilities): DisplayAdvertisement | null {
  if (session.url === DEMO_STORE_ORIGIN) return null;
  return capabilities?.customerDisplay ?? null;
}

export interface TillCustomerDisplay { service: TillDisplayService; pairing: TillPairing; close(): void }

const logError = (error: unknown) => customerDisplayLogger.warn('A customer display call failed', { error });

/**
 * The till's display service and pairing over the plugin's routes, with the display device id (never the register id)
 * and its key, both kept only in `storage`. The service and the pairing share one device handle, so they register once.
 */
export function createTillCustomerDisplay({ session, advertisement, signalling = createDisplaySignalling(), storage = defaultStore() }: {
  session: () => Session; advertisement: DisplayAdvertisement; signalling?: DisplaySignalling; storage?: KeyValueStore;
}): TillCustomerDisplay {
  const device = createTillDevice({
    signalling, deviceId: displayDeviceId(storage), keys: displayDeviceKeys(storage), onError: logError,
  });
  const context = () => sessionContext(session());
  const service = createTillDisplayService({
    signalling, context, device, advertisement, configFor: (display) => displayConfig(session(), display), onError: logError,
  });
  const pairing = createTillPairing({ signalling, context, device, service, onError: logError });
  return { service, pairing, close() { pairing.close(); service.close(); } };
}

/** The handles while the store advertises a display; null otherwise. A new store or channel starts them again. */
export function useTillCustomerDisplay(session: Session, capabilities?: ServerCapabilities): TillCustomerDisplay | null {
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [handles, setHandles] = useState<TillCustomerDisplay | null>(null);
  const advertisement = customerDisplayAdvertisement(session, capabilities);
  const advertised = advertisement ? JSON.stringify(advertisement) : null;
  const key = sessionKey(session);
  useEffect(() => {
    if (advertised === null) return;
    const display = createTillCustomerDisplay({ session: () => sessionRef.current, advertisement: JSON.parse(advertised) as DisplayAdvertisement });
    setHandles(display);
    return () => {
      display.close();
      setHandles(null);
    };
  }, [key, advertised]);
  return handles;
}
