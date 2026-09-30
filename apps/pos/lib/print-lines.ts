// The frame the last print was drawn in; the next print replaces it.
export const PRINT_FRAME_ID = 'vendurepos-print';

/**
 * Prints plain lines through the browser's print dialog, from a hidden frame so the till's page stays as it is. Each
 * line is set as text, never as markup.
 */
export async function printLines(title: string, lines: readonly string[]): Promise<void> {
  document.getElementById(PRINT_FRAME_ID)?.remove();
  const frame = document.createElement('iframe');
  frame.id = PRINT_FRAME_ID;
  frame.title = title;
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const page = frame.contentDocument!;
  page.title = title;
  for (const line of lines) page.body.appendChild(page.createElement('p')).textContent = line;
  frame.contentWindow!.print();
}
