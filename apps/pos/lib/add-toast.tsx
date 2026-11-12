import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Toast, ToastTitle } from '@tallyui/components';

/** How long the "added to cart" toast stays, in ms (v2's add toast fades by itself after a moment). */
export const ADD_TOAST_MS = 2500;

/** The toast's timer: one toast at a time, so a second add replaces the line and restarts the clock. */
export function createAddToastTimer(onChange: (lineId: string | null) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    show(lineId: string) {
      clearTimeout(timer);
      onChange(lineId);
      timer = setTimeout(() => { timer = undefined; onChange(null); }, ADD_TOAST_MS);
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** The cart line the toast is about, or null once it has gone. */
export function useAddToast(): { show(lineId: string): void; lineId: string | null } {
  const [lineId, setLineId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof createAddToastTimer>>(undefined);
  timer.current ??= createAddToastTimer(setLineId);
  useEffect(() => () => timer.current?.dispose(), []);
  return { show: (id) => timer.current!.show(id), lineId };
}

/** v2's add toast: over the top centre of the till, never in the way of a tap or a scan, and never printed. */
export function AddToast({ name }: { name: string | null }) {
  if (name === null) return null;
  return (
    <View pointerEvents="none" dataSet={{ print: 'hide' }} className="absolute left-0 right-0 top-4 z-50 items-center px-4">
      {/* TallyUI's Toast takes taps itself (pointer-events-auto): this one must let them through. */}
      <Toast variant="success" testID="add-toast" pointerEvents="none" role="status" aria-live="polite" accessibilityLiveRegion="polite"
        className="w-auto max-w-md px-4 py-3">
        <ToastTitle>{`${name} added to cart`}</ToastTitle>
      </Toast>
    </View>
  );
}
