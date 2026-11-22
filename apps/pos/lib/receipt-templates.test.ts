import { expect, it } from 'vitest';
import { SYSTEM_PRINTER_ID, type PrinterProfile } from '@tallyui/pos';
import { PRINT_DIALOG, RECEIPT_TEMPLATES, receiptPrinter, routablePrinters, templatePrinter, templatePrinterLabel } from './receipt-templates';

// TEST-NET-1 addresses: never a real printer.
const epson80: PrinterProfile = { id: 'front', name: 'Front counter', connectionType: 'network', vendor: 'epson', address: '192.0.2.10', port: 9100, columns: 48 };
const star58: PrinterProfile = { id: 'back', name: 'Back office', connectionType: 'network', vendor: 'star', address: '192.0.2.11', port: 9100, columns: 32 };
const usb: PrinterProfile = { id: 'usb', name: 'USB printer', connectionType: 'usb', address: '/dev/usb/lp0', columns: 48 };
const generic: PrinterProfile = { ...epson80, id: 'generic', name: 'Other printer', vendor: 'generic' };
const [standard, thermal80, thermal58] = RECEIPT_TEMPLATES;

it('sends Standard to the print dialog, whatever printers there are', () => {
  expect(standard.id).toBe('standard');
  expect(templatePrinter(standard, [epson80, star58], {})).toBe(PRINT_DIALOG);
});

it('routes each thermal template to a direct printer of its paper width', () => {
  expect(templatePrinter(thermal80, [epson80, star58], {})).toBe(epson80);
  expect(templatePrinter(thermal58, [epson80, star58], {})).toBe(star58);
});

it('never routes a template to a printer the app cannot reach', () => {
  expect(templatePrinter(thermal80, [usb, generic], {})).toBeNull();
  expect(templatePrinter(thermal58, [usb, generic], {})).toBeNull();
  expect(routablePrinters([usb, generic])).toEqual([PRINT_DIALOG]);
});

it('a saved choice wins over Auto, and the dialog can be chosen', () => {
  expect(templatePrinter(thermal80, [epson80, star58], { 'thermal-80mm': SYSTEM_PRINTER_ID })).toBe(PRINT_DIALOG);
  expect(templatePrinter(thermal80, [epson80, star58], { 'thermal-80mm': star58.id })).toBe(star58);
});

it('a choice for a removed printer goes back to Auto', () => {
  expect(templatePrinter(thermal80, [epson80, star58], { 'thermal-80mm': 'gone' })).toBe(epson80);
});

it("prints directly on the printer today's receipts go to, with nothing saved", () => {
  expect(receiptPrinter([epson80], {})).toBe(epson80);
  const defaultStar = { ...star58, isDefault: true };
  expect(receiptPrinter([defaultStar], {})).toBe(defaultStar);
  expect(receiptPrinter([star58, epson80], {})).toBe(epson80);
  expect(receiptPrinter([epson80, defaultStar], {})).toBe(defaultStar);
  expect(receiptPrinter([usb], {})).toBeNull();
});

it('prints through the dialog when every thermal template is routed there', () => {
  expect(receiptPrinter([epson80], { 'thermal-80mm': 'system' })).toBeNull();
});

it('labels each row as v2 does', () => {
  expect(templatePrinterLabel(thermal80, [epson80], {})).toBe('Auto — Front counter');
  expect(templatePrinterLabel(thermal80, [], {})).toBe('Auto — Print dialog');
  expect(templatePrinterLabel(thermal80, [epson80], { 'thermal-80mm': SYSTEM_PRINTER_ID })).toBe('Print dialog');
  expect(templatePrinterLabel(thermal80, [epson80], { 'thermal-80mm': epson80.id })).toBe('Front counter');
  expect(templatePrinterLabel(standard, [epson80], {})).toBe('Print dialog');
});
