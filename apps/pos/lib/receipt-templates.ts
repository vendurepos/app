import type { ReceiptTemplate } from '@tallyui/core';
import { networkSinkFor, resolvePrinter, SYSTEM_PRINTER_ID, type PrinterProfile } from '@tallyui/pos';

/** TallyUI's routing shape for a template: no body, as Standard prints the on-screen receipt (spec 9.5c D-3). */
export type AppReceiptTemplate = Pick<ReceiptTemplate, 'id' | 'kind' | 'title' | 'engine' | 'paper'>;

/** v2's receipt templates, this app's copy until TallyUI ships one (desk ruling, 9.5c). */
export const RECEIPT_TEMPLATES: readonly AppReceiptTemplate[] = [
  { id: 'standard', kind: 'receipt', title: 'Standard receipt', engine: 'html' },
  { id: 'thermal-80mm', kind: 'receipt', title: 'Thermal receipt (80 mm)', engine: 'thermal', paper: '80mm' },
  { id: 'thermal-58mm', kind: 'receipt', title: 'Thermal receipt (58 mm)', engine: 'thermal', paper: '58mm' },
];

/** The print dialog as resolvePrinter's built-in system printer. */
export const PRINT_DIALOG: PrinterProfile = { id: SYSTEM_PRINTER_ID, name: 'Print dialog', connectionType: 'system', isBuiltIn: true };

/** The printers a template can go to: the dialog and the printers the app can reach directly (networkSinkFor). */
export function routablePrinters(profiles: readonly PrinterProfile[]): PrinterProfile[] {
  return [PRINT_DIALOG, ...profiles.filter((profile) => networkSinkFor(profile) !== null)];
}

/** resolvePrinter over routablePrinters: null and PRINT_DIALOG both mean the dialog. */
export function templatePrinter(template: AppReceiptTemplate, profiles: readonly PrinterProfile[],
  overrides: Readonly<Record<string, string>>): PrinterProfile | null {
  return resolvePrinter({ template, profiles: routablePrinters(profiles), overrides });
}

/**
 * The printer a receipt goes to directly: the first thermal template whose printer isn't the dialog, else null.
 * The device's default printer wins across paper widths, as 9.5b's first-direct-printer rule did (spec 9.5c D-1).
 */
export function receiptPrinter(profiles: readonly PrinterProfile[], overrides: Readonly<Record<string, string>>): PrinterProfile | null {
  const direct = RECEIPT_TEMPLATES.filter((template) => template.engine === 'thermal')
    .map((template) => templatePrinter(template, profiles, overrides))
    .filter((printer): printer is PrinterProfile => printer !== null && printer !== PRINT_DIALOG);
  return direct.find((printer) => printer.isDefault === true) ?? direct[0] ?? null;
}

/** The row text: "Auto — <name>" or "<name>", and "Print dialog" when resolved to null or the dialog. */
export function templatePrinterLabel(template: AppReceiptTemplate, profiles: readonly PrinterProfile[],
  overrides: Readonly<Record<string, string>>): string {
  const name = templatePrinter(template, profiles, overrides)?.name ?? PRINT_DIALOG.name;
  // Standard always prints through the dialog; a saved choice counts only while its printer is still there.
  const chosen = template.engine === 'html' || routablePrinters(profiles).some((printer) => printer.id === overrides[template.id]);
  return chosen ? name : `Auto — ${name}`;
}
