import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Toast, ToastTitle } from '@tallyui/components';

/** How long the "added to cart" toast stays, in ms (v2's add toast fades by itself after a moment). */
export const ADD_TOAST_MS = 2500;

/** The toast's timer: one toast at a time, so a second add replaces the line and restarts the clock. */
export function createAddToastTimer(onChange: (lineId: string | null) => void, ms = ADD_TOAST_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    show(lineId: string) {
      clearTimeout(timer);
      onChange(lineId);
      timer = setTimeout(() => { timer = undefined; onChange(null); }, ms);
    },
    hide() {
      clearTimeout(timer);
      timer = undefined;
      onChange(null);
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** The cart line the toast is about (or another short text), or null once it has gone or been hidden. */
export function useAddToast(ms = ADD_TOAST_MS): { show(lineId: string): void; hide(): void; lineId: string | null } {
  const [lineId, setLineId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof createAddToastTimer>>(undefined);
  timer.current ??= createAddToastTimer(setLineId, ms);
  useEffect(() => () => timer.current?.dispose(), []);
  return { show: (id) => timer.current!.show(id), hide: () => timer.current!.hide(), lineId };
}

/** v2's add toast (or, with `title`, another short confirmation or notice): over the top centre of the till, never in the way of a tap or a scan, and never printed. */
export function AddToast({ name, title = `${name} added to cart`, testID = 'add-toast', variant = 'success' }: {
  name: string | null; title?: string; testID?: string; variant?: 'success' | 'destructive';
}) {
  if (name === null) return null;
  return (
    <View pointerEvents="none" dataSet={{ print: 'hide' }} className="absolute left-0 right-0 top-4 z-50 items-center px-4">
      {/* TallyUI's Toast takes taps itself (pointer-events-auto): this one must let them through. */}
      <Toast variant={variant} testID={testID} pointerEvents="none" role="status" aria-live="polite" accessibilityLiveRegion="polite"
        className="w-auto max-w-md px-4 py-3">
        <ToastTitle>{title}</ToastTitle>
      </Toast>
    </View>
  );
}
