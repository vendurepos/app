import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, DialogContent, DialogTitle, Input, InputField, Label, Text } from '@tallyui/components';
import type { ServerCapabilities } from '@tallyui/core';
import type { ApprovalNeeded, useRegisterSession } from '@tallyui/pos';
import { approvalVariance, requestManagerApproval, requestReapproval, usesStoreApproval } from './manager-approval';
import { typedApprover } from './register-approval';
import type { Session } from './session';

type Approved = { approvedBy: string; approvedByName?: string; approval?: string; approvedVariance?: Record<string, number> };
type Signed = { approvedBy: string; approvedByName: string; approval: string };
/** What the open sheet is for: a typed name, or a manager's sign-in bound to one session and variance (a refused closure's by its id). */
type Sheet = { kind: 'typed' } | { kind: 'manager'; sessionId: string; variance: Record<string, number>; closureId?: string; liveAtStore: boolean;
  result: (signed: Signed) => unknown };

/** #332: a count over the store's limit asks a manager to sign in (the store checks it); otherwise a typed name, as before. */
export function useApprovalSheet({ session, register, capabilities }: {
  session: Session; register: ReturnType<typeof useRegisterSession>; capabilities: ServerCapabilities | undefined;
}): {
  approve: (input: { counted: Record<string, number> }) => Promise<Approved | null>;
  reapprove: (needed: ApprovalNeeded) => Promise<{ approvedBy: string; approval: string } | null>;
  dialog: ReactNode;
} {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  // The manager's password lives only here: cleared on every open and close, never logged, toasted or stored.
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolve = useRef<((value: never) => void) | null>(null);
  useEffect(() => () => { resolve.current?.(null as never); resolve.current = null; }, []);
  const answer = (value: unknown) => {
    resolve.current?.(value as never);
    resolve.current = null;
    setSheet(null);
    setPassword('');
    setBusy(false);
  };
  const show = <T,>(next: Sheet) => new Promise<T | null>((done) => {
    resolve.current?.(null as never);
    resolve.current = done as (value: never) => void;
    setName('');
    setUsername('');
    setPassword('');
    setError(null);
    setBusy(false);
    setSheet(next);
  });
  const approve = (input: { counted: Record<string, number> }) => {
    if (!usesStoreApproval(capabilities, register.liveAtStore) || !register.session) return show<Approved>({ kind: 'typed' });
    const variance = approvalVariance(input.counted, register.expected);
    return show<Approved>({ kind: 'manager', sessionId: register.session.id, variance, liveAtStore: true,
      result: ({ approvedBy, approvedByName, approval }) => ({ approvedBy, approvedByName, approval, approvedVariance: variance }) });
  };
  const reapprove = (needed: ApprovalNeeded) => show<{ approvedBy: string; approval: string }>({
    kind: 'manager', sessionId: needed.sessionId, variance: needed.variance, closureId: needed.closureId, liveAtStore: needed.liveAtStore,
    result: ({ approvedBy, approval }) => ({ approvedBy, approval }),
  });
  const submit = async (manager: Extract<Sheet, { kind: 'manager' }>) => {
    const pending = resolve.current;
    setBusy(true);
    setError(null);
    const signIn = { sessionId: manager.sessionId, variance: manager.variance, username: username.trim(), password };
    const result = manager.closureId !== undefined ? await requestReapproval(session, { ...signIn, closureId: manager.closureId })
      : await requestManagerApproval(session, signIn);
    if (resolve.current !== pending) return; // cancelled, or another sheet opened, while the store answered
    if (result.ok) return answer(manager.result(result));
    setError(result.message);
    setPassword('');
    setBusy(false);
  };
  const cancel = <Button testID="approver-cancel" onPress={() => answer(null)}><Text>Cancel</Text></Button>;
  const dialog = (
    <Dialog open={sheet !== null} onOpenChange={(value) => { if (!value) answer(null); }}>
      <DialogContent>
        <DialogTitle>Manager approval</DialogTitle>
        {sheet?.kind === 'manager' && !sheet.liveAtStore ? (
          <Text testID="approver-not-live">{"This register session is no longer open at the store, so a manager can't approve it here."}</Text>
        ) : sheet?.kind === 'manager' ? (
          <>
            <Text>{"This count is over the store's limit. A manager signs in here to approve it; the store checks the sign-in."}</Text>
            <Label nativeID="approver-username-label">{"Manager's username"}</Label>
            <Input><InputField testID="approver-username" value={username} onChangeText={setUsername} autoCapitalize="none" autoComplete="username"
              accessibilityLabel="Manager's username" accessibilityLabelledBy="approver-username-label" /></Input>
            <Label nativeID="approver-password-label">Password</Label>
            <Input><InputField testID="approver-password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password"
              accessibilityLabel="Password" accessibilityLabelledBy="approver-password-label" /></Input>
            {error ? <Text testID="approver-error" role="alert" className="text-destructive">{error}</Text> : null}
            <Button testID="approver-confirm" disabled={busy || !username.trim() || !password} onPress={() => void submit(sheet)}><Text>Approve</Text></Button>
          </>
        ) : (
          <>
            <Text>{"This count is over the till's limit. Type the name of the manager who approves it. The name is recorded as typed, not verified."}</Text>
            <Label nativeID="approver-name-label">Approved by (typed name)</Label>
            <Input><InputField testID="approver-name" value={name} onChangeText={setName}
              accessibilityLabel="Approved by (typed name)" accessibilityLabelledBy="approver-name-label" /></Input>
            <Button testID="approver-confirm" disabled={!name.trim()} onPress={() => answer(typedApprover(name))}><Text>Approve</Text></Button>
          </>
        )}
        {cancel}
      </DialogContent>
    </Dialog>
  );
  return { approve, reapprove, dialog };
}
