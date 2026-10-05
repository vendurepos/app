import { useEffect, useRef, useState } from 'react';
import { useSession } from './session-context';
import { signIn } from './sign-in';

export function useSignIn() {
  const { setSignedIn } = useSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  async function submit(values: Record<string, string | undefined>) {
    if (pending) return;
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    setPending(true);
    try {
      const result = await signIn(values, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.ok) {
        setSignedIn(result.session);
      } else {
        setError(result.error);
      }
    } catch (error) {
      if ((error as { name?: unknown })?.name !== 'AbortError') throw error;
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return { pending, error, submit };
}
