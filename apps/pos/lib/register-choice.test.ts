import { describe, expect, it } from 'vitest';
import { pickRefusal, registerChoices, registerLabel, registerStatus, setTillHoldsSession, type ListedRegister } from './register-choice';

const now = new Date(2026, 10, 17, 18, 0);
const at = new Date(2026, 10, 17, 14, 38).toISOString();
const listedRegister = (id: string, session: ListedRegister['session'] = null): ListedRegister =>
  ({ id, receivedAt: at, lastDeviceName: `Till ${id}`, session });

describe('registerLabel', () => {
  it("names a register by its last device, else by the first 8 of its id", () => {
    expect(registerLabel({ id: 'a', lastDeviceName: 'Front till' })).toBe('Front till');
    const id = '0193abcd-1111-7000-8000-000000000000';
    expect(registerLabel({ id, lastDeviceName: null })).toBe('Register 0193abcd');
    expect(registerLabel({ id, lastDeviceName: '  ' })).toBe('Register 0193abcd');
  });
});

describe('registerStatus', () => {
  it('says since when and on which device a register is open', () => {
    expect(registerStatus(undefined, now)).toBeNull();
    expect(registerStatus(listedRegister('a'), now)).toBeNull();
    const session = { status: 'open' as const, openedAt: at, openedBy: null, deviceName: 'Till two' };
    expect(registerStatus(listedRegister('a', session), now)).toBe('Open since 14:38 on Till two');
    expect(registerStatus(listedRegister('a', { ...session, deviceName: null }), now)).toBe('Open since 14:38');
  });
});

describe('registerChoices', () => {
  it("puts this device's own register first, then the others in the list's order", () => {
    const own = listedRegister('own', { status: 'open', openedAt: at, openedBy: null, deviceName: 'Till own' });
    const [b, c] = [listedRegister('b'), listedRegister('c')];
    const choices = registerChoices('own', [b, own, c], now);
    expect(choices.map(choice => choice.id)).toEqual(['own', 'b', 'c']);
    expect(choices[0]).toEqual({ id: 'own', label: 'This device', status: registerStatus(own, now) });
    expect(choices[1]).toEqual({ id: 'b', label: 'Till b', status: null });
    const unlisted = registerChoices('mine', [b, c], now);
    expect(unlisted.map(choice => choice.id)).toEqual(['mine', 'b', 'c']);
    expect(unlisted[0]).toEqual({ id: 'mine', label: 'This device', status: null });
  });
});

describe('pickRefusal', () => {
  it('refuses another register while this till holds a live session', () => {
    expect(pickRefusal('b', 'a', true)).toBe('Close the register first');
    expect(pickRefusal('a', 'a', true)).toBeNull();
    expect(pickRefusal('b', 'a', false)).toBeNull();
    expect(pickRefusal('b', 'a')).toBeNull();
    setTillHoldsSession(true);
    expect(pickRefusal('b', 'a')).toBe('Close the register first');
    setTillHoldsSession(false);
  });
});
