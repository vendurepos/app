import { describe, expect, it } from 'vitest';
import { holdsRegister, pickRefusal, registerChoices, registerLabel, registerStatus, registerTitle, setTillHoldsSession, type ListedRegister } from './register-choice';

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

describe('registerTitle', () => {
  it('names the bound register by its last device', () => {
    expect(registerTitle([{ id: 'a', lastDeviceName: 'Till a' }, { id: 'b', lastDeviceName: 'Front counter' }], 'b')).toBe('Front counter');
  });

  it('trims the name', () => {
    expect(registerTitle([{ id: 'b', lastDeviceName: '  Front counter ' }], 'b')).toBe('Front counter');
  });

  it('has no title for a null, empty or blank name', () => {
    expect(registerTitle([{ id: 'b', lastDeviceName: null }], 'b')).toBeUndefined();
    expect(registerTitle([{ id: 'b', lastDeviceName: '' }], 'b')).toBeUndefined();
    expect(registerTitle([{ id: 'b', lastDeviceName: '   ' }], 'b')).toBeUndefined();
  });

  it('has no title when the bound register is not listed, even when another is named', () => {
    expect(registerTitle([{ id: 'a', lastDeviceName: 'Till a' }], 'b')).toBeUndefined();
  });

  it('has no title for an empty list', () => {
    expect(registerTitle([], 'b')).toBeUndefined();
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

describe('holdsRegister', () => {
  it.each([
    ['open', false, true],
    ['open', true, true],
    ['counting', false, true],
    ['closed', false, true],
    ['closed', true, false],
    ['counting', true, false],
    [undefined, false, false],
    ['conflict', false, false],
    ['superseded', false, false],
    ['abandoned', false, false],
  ] as const)('%s, closure written %s → %s', (status, closureWritten, expected) => {
    expect(holdsRegister(status, closureWritten)).toBe(expected);
  });
});
