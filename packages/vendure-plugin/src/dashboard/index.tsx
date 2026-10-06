import {
  api, Button, defineDashboardExtension, Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, Input, Label, useChannel,
} from '@vendure/dashboard';
import { useState } from 'react';

type Role = { id: string; code: string; description: string };

export default defineDashboardExtension({
  actionBarItems: [{
    id: 'vendurepos-new-till-key',
    pageId: 'api-key-list',
    // tallyEnsurePosTillRole is SuperAdmin only.
    requiresPermission: 'SuperAdmin',
    component: NewPosTillKey,
  }],
});

function NewPosTillKey() {
  const { activeChannel } = useChannel();
  // Vendure's ApiKey is channel-aware; createApiKey assigns the current channel.
  const channelCode = activeChannel?.code ?? '';
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ secret: string; role: Role } | null>(null);
  const [copied, setCopied] = useState(false);

  function onOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setOpen(true);
      return;
    }
    setResult(null);
    setName('');
    setError('');
    setCopied(false);
    setOpen(false);
    // The list's query lives in the page's own data table, which an action-bar item cannot refetch.
    if (result) window.location.reload();
  }

  async function createKey() {
    setPending(true);
    setError('');
    try {
      const { tallyEnsurePosTillRole: role } = await api.mutate(
        'mutation { tallyEnsurePosTillRole { id code description } }', {},
      ) as { tallyEnsurePosTillRole: Role };
      const { createApiKey } = await api.mutate(
        'mutation CreateTillKey($input: CreateApiKeyInput!) { createApiKey(input: $input) { apiKey entityId } }',
        { input: {
          roleIds: [role.id],
          translations: [{ languageCode: activeChannel?.defaultLanguageCode ?? 'en', name: name.trim() }],
        } },
      ) as { createApiKey: { apiKey: string; entityId: string } };
      setResult({ secret: createApiKey.apiKey, role });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  return <>
    <Button data-testid="vendurepos-new-till-key" onClick={() => setOpen(true)}>New POS till key</Button>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {result ? <>
          <DialogHeader>
            <DialogTitle>Copy the key now</DialogTitle>
            <DialogDescription>
              This key is shown once. Vendure keeps only a hash of it, so it cannot be shown again. If it is lost, rotate it on the key's page.
            </DialogDescription>
          </DialogHeader>
          <p data-testid="vendurepos-till-key-role">Role granted: {result.role.description} ({result.role.code})</p>
          <p data-testid="vendurepos-till-key-channel">{`Works in the ${channelCode} channel only.`}</p>
          <code data-testid="vendurepos-till-key-secret" className="font-mono text-xs break-all select-all">{result.secret}</code>
          <DialogFooter>
            <Button data-testid="vendurepos-till-key-copy" onClick={async () => {
              try {
                await navigator.clipboard.writeText(result.secret);
                setCopied(true);
              } catch {
                // The code remains selectable if clipboard access fails.
              }
            }}>{copied ? 'Copied' : 'Copy'}</Button>
            <Button data-testid="vendurepos-till-key-done" onClick={() => onOpenChange(false)}>Done</Button>
          </DialogFooter>
        </> : <form onSubmit={event => { event.preventDefault(); void createKey(); }} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New POS till key</DialogTitle>
            <DialogDescription>Creates an API key for one till, with the VendurePOS till role. Name it after the device.</DialogDescription>
          </DialogHeader>
          <p data-testid="vendurepos-till-key-channel">{`For the ${channelCode} channel. A key works only in the channel it is created in, so switch the Dashboard to the till's channel first.`}</p>
          <Label htmlFor="vendurepos-till-key-name">Device name</Label>
          <Input id="vendurepos-till-key-name" data-testid="vendurepos-till-key-name"
            placeholder="Front counter iPad" value={name} onChange={event => setName(event.target.value)} />
          {error && <p role="alert" data-testid="vendurepos-till-key-error">{error}</p>}
          <DialogFooter>
            <Button type="submit" data-testid="vendurepos-till-key-create" disabled={!name.trim() || pending}>Create key</Button>
          </DialogFooter>
        </form>}
      </DialogContent>
    </Dialog>
  </>;
}
