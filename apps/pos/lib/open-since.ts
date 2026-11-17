const pad = (n: number) => String(n).padStart(2, '0');
// The till's short day form, as the Reports hero's dates (lib/till-sales-hero.tsx): "Mon 16 Nov".
const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/** "14:38" for a register opened today, "Mon 16 Nov 14:38" for one left open from another day; device time, as the till's clock. */
export function openSince(opened: Date, now: Date): string {
  const time = `${pad(opened.getHours())}:${pad(opened.getMinutes())}`;
  return opened.toDateString() === now.toDateString() ? time : `${DAY.format(opened)} ${time}`;
}
