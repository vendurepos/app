import { useCallback, useState } from 'react';
import {
  createEscPosTransport, createPrintQueue, escpos, mintUuid, networkSinkFor,
  type EscPosTransportOptions, type PrintJob, type PrinterProfile, type ReceiptData,
} from '@tallyui/pos';
import { loadPrinterProfiles, printerPaper } from './printer-profiles';

type PrintFormat = EscPosTransportOptions['format'];

/** The cashier's line after a job reached the printer. */
export const printedOn = (name: string) => `Sent to ${name}.`;
/** The cashier's line for any failed job, whatever its PrintError code. */
export const printFailed = (name: string) =>
  `Can't print on ${name}. Check that it is on and on this network, then try again, or print with the dialog.`;

/**
 * The till's receipt printer: the first printer with a web sink (Epson ePOS or Star WebPRNT), the default one first;
 * null sends receipts to the print dialog. Stands in for v2's template-to-printer mapping until 9.5c.
 */
export function directPrinter(profiles: readonly PrinterProfile[]): PrinterProfile | null {
  return [...profiles].sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true))
    .find((profile) => networkSinkFor(profile) !== null) ?? null;
}

// The latest saved profile (and money format) for each printer id, set before every job, so a queued job's transport
// is built with the address as it is now. One queue for the module: one printer prints one job at a time (v2's
// per-printer queue), and a stalled printer never holds up another.
const printers = new Map<string, { profile: PrinterProfile; format: PrintFormat }>();
const queue = createPrintQueue({
  transportFor: (id) => {
    const { profile, format } = printers.get(id)!;
    return createEscPosTransport({ sink: networkSinkFor(profile)!, profile, format });
  },
});

async function send(profile: PrinterProfile, job: PrintJob, format?: PrintFormat): Promise<string | null> {
  // A job with no format (a test page, a reprint) keeps the one a receipt last gave this printer.
  printers.set(profile.id, { profile, format: format ?? printers.get(profile.id)?.format });
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
export async function printReceiptTo(profile: PrinterProfile, receipt: ReceiptData, format?: PrintFormat): Promise<string | null> {
  return send(profile, { id: mintUuid(), kind: 'receipt', receipt }, format);
}

/** Prints a short test page (title, printer name, paper width), fed and cut; null or the failure line, as printReceiptTo. */
export async function printTestTo(profile: PrinterProfile): Promise<string | null> {
  // createEscPosTransport prints a job's `bytes` as given (it lays out `receipt` only when there are none).
  const bytes = escpos().init().codePage().align('center').bold(true).text('VendurePOS test print\n').bold(false)
    .text(`${profile.name}\n${printerPaper(profile) === '58mm' ? '58 mm' : '80 mm'} paper\n`).feed(3).cut().bytes();
  return send(profile, { id: mintUuid(), kind: 'test', bytes });
}

/** A receipt's direct print: the device's direct printer (read once per mount), busy while a job runs, then its status line. */
export function useReceiptPrinter() {
  const [printer] = useState(() => directPrinter(loadPrinterProfiles()));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; failed: boolean } | null>(null);
  const print = useCallback(async (receipt: ReceiptData, format?: PrintFormat) => {
    if (printer === null) return;
    setBusy(true);
    const failure = await printReceiptTo(printer, receipt, format);
    setBusy(false);
    setStatus({ text: failure ?? printedOn(printer.name), failed: failure !== null });
  }, [printer]);
  return { printer, busy, status, print };
}
