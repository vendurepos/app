import { describe, expect, it } from 'vitest';
import { boundRegisterLabel, headerPlace, holdsRegister, pickRefusal, registerChoices, registerFilterOptions, registerLabel, registerStatus, registerTitle, setTillHoldsSession, type ListedRegister } from './register-choice';

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

it('the header names the bound register only when the store lists more than one', () => {
  const front = { id: 'front', lastDeviceName: 'Front till' };
  const unnamed = { id: '0123456789abcdef', lastDeviceName: null };
  expect(headerPlace([], front.id)).toStrictEqual({ multiRegister: false });
  expect(headerPlace([front], front.id)).toStrictEqual({ multiRegister: false });
  expect(headerPlace([front, unnamed], front.id)).toStrictEqual({ multiRegister: true, registerName: 'Front till' });
  expect(headerPlace([front, unnamed], unnamed.id)).toStrictEqual({ multiRegister: true, registerName: 'Register 01234567' });
  expect(headerPlace([front, unnamed], 'fedcba9876543210')).toStrictEqual({ multiRegister: true, registerName: 'Register fedcba98' });
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

describe('registerFilterOptions', () => {
  it('puts this device first without repeating it, then names the others in list order', () => {
    expect(registerFilterOptions('own', [listedRegister('b'), listedRegister('own'), listedRegister('c')])).toEqual([
      { value: 'own', label: 'This device' },
      { value: 'b', label: 'Till b' },
      { value: 'c', label: 'Till c' },
    ]);
  });

  it('keeps this device as the only option when the list is empty', () => {
    expect(registerFilterOptions('own', [])).toEqual([{ value: 'own', label: 'This device' }]);
  });

  it('names a register without a device name by the first 8 of its id', () => {
    expect(registerFilterOptions('own', [{ ...listedRegister('abcdef1234'), lastDeviceName: null }])).toEqual([
      { value: 'own', label: 'This device' },
      { value: 'abcdef1234', label: 'Register abcdef12' },
    ]);
  });
});

describe('boundRegisterLabel', () => {
  it('labels the own register This device, even offline or when it has a device name', () => {
    expect(boundRegisterLabel('own', [], 'own')).toBe('This device');
    expect(boundRegisterLabel('own', [listedRegister('own')], 'own')).toBe('This device');
  });

  it('labels another listed register by its last device name', () => {
    expect(boundRegisterLabel('own', [listedRegister('other')], 'other')).toBe('Till other');
  });

  it('labels an unlisted bound register by the first 8 of its id', () => {
    expect(boundRegisterLabel('own', [], '0193abcd-1111-7000-8000-000000000000')).toBe('Register 0193abcd');
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
