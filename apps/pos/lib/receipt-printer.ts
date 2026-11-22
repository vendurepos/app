import { useCallback, useRef, useState } from 'react';
import {
  createEscPosTransport, createPrintQueue, escpos, mintUuid, networkSinkFor,
  type PrintJob, type PrinterProfile, type ReceiptData,
} from '@tallyui/pos';
import { loadPrinterProfiles, printerPaper } from './printer-profiles';

/** The cashier's line after a job reached the printer. */
export const printedOn = (name: string) => `Sent to ${name}.`;
/** The cashier's line for any failed job, whatever its PrintError code. */
export const printFailed = (name: string) =>
  `Can't print on ${name}. Check that it is on and on this network, then try again, or print with the dialog.`;
/** The till's notice for a failed job once its receipt has gone, so there is no dialog button to offer. */
export const printFailedAfterClose = (name: string) =>
  `Can't print on ${name}. Check that it is on and on this network, then reprint it from Orders.`;

/**
 * The till's receipt printer: the first printer with a web sink (Epson ePOS or Star WebPRNT), the default one first;
 * null sends receipts to the print dialog. Stands in for v2's template-to-printer mapping until 9.5c.
 */
export function directPrinter(profiles: readonly PrinterProfile[]): PrinterProfile | null {
  return [...profiles].sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true))
    .find((profile) => networkSinkFor(profile) !== null) ?? null;
}

// The latest saved profile for each printer id, set before every job, so a queued job's transport is built with the
// address as it is now. One queue for the module: one printer prints one job at a time (v2's per-printer queue), and
// a stalled printer never holds up another.
const printers = new Map<string, PrinterProfile>();
// No money format: the transport's default decides how money prints. It folds each figure to the printer's code page
// and, where the symbol has no glyph there (€ on cp437), prints the currency code ("EUR 9.52"); the screen's
// formatter would print "?9.52".
const queue = createPrintQueue({
  transportFor: (id) => {
    const profile = printers.get(id)!;
    return createEscPosTransport({ sink: networkSinkFor(profile)!, profile });
  },
});

async function send(profile: PrinterProfile, job: PrintJob): Promise<string | null> {
  printers.set(profile.id, profile);
  try {
    await queue.print(profile.id, job);
    return null;
  } catch {
    // The queue rejects with toPrintError's PrintError for any failure; every code reads the same to the cashier.
    // Never retried, and never logged: the job holds the receipt.
    return printFailed(profile.name);
  }
}

/** Prints `receipt` on `profile` through its queue; null once it printed, else the cashier's failure line. */
export async function printReceiptTo(profile: PrinterProfile, receipt: ReceiptData): Promise<string | null> {
  return send(profile, { id: mintUuid(), kind: 'receipt', receipt });
}

/** Prints a short test page (title, printer name, paper width), fed and cut; null or the failure line, as printReceiptTo. */
export async function printTestTo(profile: PrinterProfile): Promise<string | null> {
  // createEscPosTransport prints a job's `bytes` as given (it lays out `receipt` only when there are none).
  const bytes = escpos().init().codePage().align('center').bold(true).text('VendurePOS test print\n').bold(false)
    .text(`${profile.name}\n${printerPaper(profile) === '58mm' ? '58 mm' : '80 mm'} paper\n`).feed(3).cut().bytes();
  return send(profile, { id: mintUuid(), kind: 'test', bytes });
}

/**
 * A receipt's direct print: the device's direct printer (read once per mount), busy while a job runs, then its status
 * line. `print` resolves to the failure line, or null; a call while a job runs is ignored.
 */
export function useReceiptPrinter() {
  const [printer] = useState(() => directPrinter(loadPrinterProfiles()));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; failed: boolean } | null>(null);
  // `busy` disables the button only from the next render: a double tap lands before it.
  const running = useRef(false);
  const print = useCallback(async (receipt: ReceiptData): Promise<string | null> => {
    if (printer === null || running.current) return null;
    running.current = true;
    setBusy(true);
    const failure = await printReceiptTo(printer, receipt);
    running.current = false;
    setBusy(false);
    setStatus({ text: failure ?? printedOn(printer.name), failed: failure !== null });
    return failure;
  }, [printer]);
  return { printer, busy, status, print };
}
