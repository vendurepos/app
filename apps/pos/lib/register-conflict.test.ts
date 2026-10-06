import { expect, it } from 'vitest';
import { canTakeOver, isClosingStatus, registerConflictText } from './register-conflict';

it.each(['counting', 'closed'])('treats %s as closing', (status) => {
  expect(isClosingStatus(status)).toBe(true);
});

it.each(['open', 'conflict', 'superseded', 'abandoned', undefined])('does not treat %s as closing', (status) => {
  expect(isClosingStatus(status)).toBe(false);
});

it('describes a conflict without details', () => {
  expect(registerConflictText(undefined)).toBe('This register is open on another till.');
});

it('describes a queued take-over', () => {
  expect(registerConflictText({ sessionId: 'other', takingOver: true }))
    .toBe('Taking over this register… waiting for the online store.');
});

it('describes the other till, opening time and cashier', () => {
  const openedAt = '2026-10-06T09:00:00.000Z';
  expect(registerConflictText({ sessionId: 'other', takingOver: false, deviceName: 'Front till', openedAt, openedBy: 'sam' }))
    .toBe('This register is open on Front till since ' + new Date(openedAt).toLocaleString() + ' by sam.');
});

it.each(['', '   '])('uses another till for a blank device name (%j)', (deviceName) => {
  expect(registerConflictText({ sessionId: 'other', takingOver: false, deviceName }))
    .toBe('This register is open on another till.');
});

it.each([undefined, 'invalid'])('omits a missing or invalid opening time (%s) and absent cashier', (openedAt) => {
  expect(registerConflictText({ sessionId: 'other', takingOver: false, openedAt }))
    .toBe('This register is open on another till.');
});

it.each([undefined, 0, 1])('does not offer take-over for contract %s', (contract) => {
  expect(canTakeOver(contract)).toBe(false);
});

it.each([2, 3])('offers take-over for contract %s', (contract) => {
  expect(canTakeOver(contract)).toBe(true);
});
