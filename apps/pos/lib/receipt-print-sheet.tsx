import { useEffect, useRef, useState, type JSX, type ReactNode, type RefObject } from 'react';
import { View } from 'react-native';
import { ReceiptSheet } from '@tallyui/components';
import type { PrinterProfile } from '@tallyui/pos';
import { loadPrinterProfiles, loadTemplatePrinters } from './printer-profiles';
import { PRINT_DIALOG, RECEIPT_TEMPLATES, routablePrinters, sheetPrinter, sheetTemplateId, templatePrinter } from './receipt-templates';

const TEMPLATES = RECEIPT_TEMPLATES.map(({ id, title }) => ({ id, title }));

type SheetState = { profiles: PrinterProfile[]; overrides: Record<string, string>; templateId: string; manualPrinterId: string | null };
const CLOSED: SheetState = { profiles: [], overrides: {}, templateId: 'standard', manualPrinterId: null };

/** Renders nothing: its unmount is the sheet's content leaving the document, once it has slid out (D-2). */
function WhenGone({ gone }: { gone: RefObject<() => void> }) {
  useEffect(() => () => gone.current(), [gone]);
  return null;
}

/**
 * v2's print sheet for a manual Print receipt (desk ruling 9.5d): template, printer for this print, preview,
 * Close/Print. Nothing picked here is saved. `onPrint` gets a direct printer, or null for the print dialog, and is
 * called only once the sheet has left the document, so a dialog print never prints the sheet. A dialog print goes only
 * if the receipt (this sheet's parent) is still shown then: not unmounted, and not hidden with the till behind a panel
 * opened meanwhile. A direct print always goes, as it holds its own receipt.
 */
export function ReceiptPrintSheet({ open, onOpenChange, onPrint, children }: {
  open: boolean; onOpenChange(open: boolean): void; onPrint(printer: PrinterProfile | null): void; children: ReactNode;
}): JSX.Element {
  const [opened, setOpened] = useState(false);
  const [sheet, setSheet] = useState(CLOSED);
  // Read once each time the sheet opens: the printers and Settings › Printing's routing, never written from here.
  if (open !== opened) {
    setOpened(open);
    if (open) {
      const profiles = loadPrinterProfiles();
      const overrides = loadTemplatePrinters();
      setSheet({ profiles, overrides, templateId: sheetTemplateId(profiles, overrides), manualPrinterId: null });
    }
  }
  const { profiles, overrides, templateId, manualPrinterId } = sheet;
  const template = RECEIPT_TEMPLATES.find((each) => each.id === templateId) ?? RECEIPT_TEMPLATES[0];
  const printers = routablePrinters(profiles);
  const pickable = template.engine === 'thermal' && printers.some((printer) => printer !== PRINT_DIALOG);
  // Print's target, taken when the content unmounts; a second Print before then replaces it, so one close is one print.
  const pending = useRef<{ printer: PrinterProfile | null } | null>(null);
  // Laid out where the receipt is (the sheet itself draws through the host): null once the receipt unmounts, and not
  // shown while the till is hidden behind a panel. The content's own unmount comes later, through the host.
  const marker = useRef<View & { checkVisibility?(): boolean; offsetParent?: unknown }>(null);
  const gone = useRef(() => {});
  useEffect(() => {
    gone.current = () => {
      const target = pending.current;
      pending.current = null;
      const node = marker.current;
      const shown = !!node && (node.checkVisibility?.() ?? node.offsetParent !== null);
      // A dialog print now would print whatever replaced or covers the receipt (the next sale's till, a panel).
      if (target && (target.printer !== null || shown)) onPrint(target.printer);
    };
  });
  return (
    <>
    <View ref={marker} pointerEvents="none" aria-hidden dataSet={{ print: 'hide' }} style={{ position: 'absolute', width: 0, height: 0 }} />
    <ReceiptSheet open={open} title="Print receipt" templates={TEMPLATES} templateId={templateId}
      // Close, the X, Escape or the scrim: nothing prints.
      onOpenChange={(next) => { if (!next) pending.current = null; onOpenChange(next); }}
      // v2 resets the pick when the template changes.
      onTemplateChange={(id) => setSheet({ ...sheet, templateId: id, manualPrinterId: null })}
      printers={pickable ? printers : undefined} printerId={manualPrinterId}
      autoPrinterName={templatePrinter(template, profiles, overrides)?.name ?? PRINT_DIALOG.name}
      onPrinterChange={(id) => setSheet({ ...sheet, manualPrinterId: id })} printerLabel={PRINT_DIALOG.name}
      onPrint={() => {
        pending.current = { printer: sheetPrinter(template, profiles, overrides, manualPrinterId) };
        onOpenChange(false);
      }}>
      {children}
      <WhenGone gone={gone} />
    </ReceiptSheet>
    </>
  );
}
