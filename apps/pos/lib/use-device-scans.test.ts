import { Subject } from 'rxjs';
import type { ScanEvent } from '@tallyui/pos';
import { expect, it, vi } from 'vitest';
import { routeDeviceScans } from './use-device-scans';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

it('routes active HID-POS and serial events with their kind, then stops after unsubscribe', () => {
  const events = new Subject<ScanEvent>();
  const handle = vi.fn();
  const subscription = routeDeviceScans(events, { isActive: () => true, handle });
  events.next({ code: 'HID-CODE', source: { kind: 'hid-pos' }, timestamp: 0 });
  events.next({ code: 'SERIAL-CODE', source: { kind: 'serial' }, timestamp: 1 });
  expect(handle.mock.calls).toEqual([['HID-CODE', 'hid-pos'], ['SERIAL-CODE', 'serial']]);
  subscription.unsubscribe();
  events.next({ code: 'AFTER-CODE', source: { kind: 'hid-pos' }, timestamp: 2 });
  expect(handle).toHaveBeenCalledTimes(2);
});
it('reads active at each event, ignores scans while covered, and resumes', () => {
  const events = new Subject<ScanEvent>();
  let active = true;
  const handle = vi.fn();
  const subscription = routeDeviceScans(events, { isActive: () => active, handle });
  const event: ScanEvent = { code: 'TALLY-MUG', source: { kind: 'hid-pos' }, timestamp: 0 };
  events.next(event);
  active = false;
  events.next(event);
  expect(handle).toHaveBeenCalledTimes(1);
  active = true;
  events.next(event);
  expect(handle).toHaveBeenCalledTimes(2);
  subscription.unsubscribe();
});
it('ignores wedge and camera events', () => {
  const events = new Subject<ScanEvent>();
  const handle = vi.fn();
  const subscription = routeDeviceScans(events, { isActive: () => true, handle });
  events.next({ code: 'TALLY-MUG', source: { kind: 'wedge' }, timestamp: 0 });
  events.next({ code: 'TALLY-MUG', source: { kind: 'camera' }, timestamp: 1 });
  expect(handle).not.toHaveBeenCalled();
  subscription.unsubscribe();
});
