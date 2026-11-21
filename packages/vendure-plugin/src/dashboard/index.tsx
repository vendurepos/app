import {
  api, Button, defineDashboardExtension, Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, Input, Label, Link, Page, PageBlock, PageContextValue, PageLayout, PageTitle,
  PermissionGuard, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useChannel, useLocalFormat,
} from '@vendure/dashboard';
import { useCallback, useEffect, useState } from 'react';

type Role = { id: string; code: string; description: string };

export default defineDashboardExtension({
  actionBarItems: [{
    id: 'vendurepos-new-till-key',
    pageId: 'api-key-list',
    // tallyEnsurePosTillRole is SuperAdmin only.
    requiresPermission: 'SuperAdmin',
    component: NewPosTillKey,
  }],
  routes: [{
    path: '/vendurepos-needs-admin',
    // tallyNeedsAdminCommands and tallyResolveNeedsAdmin are SuperAdmin only.
    navMenuItem: {
      sectionId: 'sales', id: 'vendurepos-needs-admin', title: 'POS sales to resolve', requiresPermission: 'SuperAdmin',
    },
    component: () => <PermissionGuard requires="SuperAdmin"><NeedsAdminPage /></PermissionGuard>,
  }],
  pageBlocks: [{
    id: 'vendurepos-custom-items',
    title: 'Till custom items',
    location: { pageId: 'order-detail', column: 'main', position: { blockId: 'order-table', order: 'after' } },
    requiresPermission: 'ReadOrder',
    shouldRender: context => customLines(context.entity).length > 0,
    component: TillCustomItems,
  }],
});

type CustomLine = {
  id: string; quantity: number; linePriceWithTax: number;
  customFields?: { tallyCustomName?: string | null; tallyCustomSku?: string | null };
};

// A till custom line sits on the shared "POS custom item" variant, so the stock table titles it by
// that variant; its own name is in tallyCustomName (ADR 0005 ruling (a)). The order page's query
// already selects OrderLine custom fields, so the page entity carries it.
const customLines = (order?: { lines?: CustomLine[] }) =>
  (order?.lines ?? []).filter(line => line.customFields?.tallyCustomName);

function TillCustomItems({ context }: { context: PageContextValue }) {
  const { formatCurrency } = useLocalFormat();
  return <div data-testid="vendurepos-custom-items">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>SKU</TableHead>
          <TableHead>Quantity</TableHead>
          <TableHead className="text-right">Total</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {customLines(context.entity).map(line => <TableRow key={line.id} data-testid="vendurepos-custom-item">
          <TableCell>{line.customFields?.tallyCustomName}</TableCell>
          <TableCell>{line.customFields?.tallyCustomSku || '—'}</TableCell>
          <TableCell>{line.quantity}</TableCell>
          <TableCell className="text-right">{formatCurrency(line.linePriceWithTax, context.entity.currencyCode)}</TableCell>
        </TableRow>)}
      </TableBody>
    </Table>
  </div>;
}

type NeedsAdminRow = {
  id: string; clientOrderId: string | null; channelId: string; orderId: string | null; orderCode: string | null; createdAt: string;
};
type Resolution = 'applied' | 'rejected';

// What each resolution does (ADR 0002, needs_admin).
const RESOLUTIONS: Record<Resolution, { label: string; effect: string }> = {
  applied: {
    label: 'Keep the sale',
    effect: "The order stays as recorded. The till's resend is answered as already recorded.",
  },
  rejected: {
    label: 'Cancel the sale',
    effect: "The order and its POS payments are cancelled. The till's sale is refused with your note, and the till can send it again as a new sale.",
  },
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

// A sale's channel by its code, or its raw id when the Dashboard does not list that channel.
const channelCode = (channels: Array<{ id: string; code: string }>, channelId: string) =>
  channels.find(channel => channel.id === channelId)?.code ?? channelId;

function NeedsAdminPage() {
  const [rows, setRows] = useState<NeedsAdminRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [target, setTarget] = useState<{ row: NeedsAdminRow; resolution: Resolution } | null>(null);
  const { channels } = useChannel();

  const load = useCallback(async () => {
    try {
      const { tallyNeedsAdminCommands } = await api.query(
        'query { tallyNeedsAdminCommands { id clientOrderId channelId orderId orderCode createdAt } }', {},
      ) as { tallyNeedsAdminCommands: NeedsAdminRow[] };
      setRows(tallyNeedsAdminCommands);
      setLoadError('');
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return <Page pageId="vendurepos-needs-admin">
    <PageTitle>POS sales to resolve</PageTitle>
    <p className="text-sm text-muted-foreground">
      A till's sale stopped part-way through recording. The till cannot resend it until you resolve it here.
    </p>
    <PageLayout>
      <PageBlock column="full" blockId="vendurepos-needs-admin-list">
        {loadError && <p role="alert" data-testid="vendurepos-needs-admin-load-error">{loadError}</p>}
        {rows?.length === 0 && <p data-testid="vendurepos-needs-admin-empty">No POS sales need you.</p>}
        {!!rows?.length && <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Created</TableHead>
              <TableHead>Order</TableHead>
              <TableHead>Till sale</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(row => <TableRow key={row.id} data-testid="vendurepos-needs-admin-row">
              <TableCell>{new Date(row.createdAt).toLocaleString()}</TableCell>
              <TableCell>{row.orderId ? <Link className="text-primary hover:underline" to={`/orders/${row.orderId}`}>{row.orderCode ?? row.orderId}</Link> : '—'}</TableCell>
              <TableCell className="whitespace-normal break-all">{row.clientOrderId ?? '—'}</TableCell>
              <TableCell>{channelCode(channels, row.channelId)}</TableCell>
              <TableCell className="space-x-2 text-right">
                <Button variant="outline" data-testid="vendurepos-needs-admin-apply"
                  onClick={() => setTarget({ row, resolution: 'applied' })}>{RESOLUTIONS.applied.label}</Button>
                <Button variant="destructive" data-testid="vendurepos-needs-admin-reject"
                  onClick={() => setTarget({ row, resolution: 'rejected' })}>{RESOLUTIONS.rejected.label}</Button>
              </TableCell>
            </TableRow>)}
          </TableBody>
        </Table>}
      </PageBlock>
    </PageLayout>
    {target && <ResolveDialog key={`${target.row.id}-${target.resolution}`} {...target}
      onClose={() => setTarget(null)} onResolved={() => { setTarget(null); void load(); }} />}
  </Page>;
}

function ResolveDialog({ row, resolution, onClose, onResolved }: {
  row: NeedsAdminRow; resolution: Resolution; onClose: () => void; onResolved: () => void;
}) {
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const { label, effect } = RESOLUTIONS[resolution];
  const { channels, activeChannel, setActiveChannel } = useChannel();
  const saleCode = channelCode(channels, row.channelId);
  // The server cancels only from the sale's channel (ADR 0002, needs_admin); Keep works from any.
  const otherChannel = resolution === 'rejected' && activeChannel?.id !== row.channelId;

  async function resolve() {
    setPending(true);
    setError('');
    try {
      await api.mutate(
        `mutation Resolve($commandId: String!, $resolution: TallyNeedsAdminResolution!, $note: String!) {
          tallyResolveNeedsAdmin(commandId: $commandId, resolution: $resolution, note: $note) { id status }
        }`,
        { commandId: row.id, resolution, note: note.trim() },
      );
      onResolved();
    } catch (error) {
      setError(errorText(error));
      setPending(false);
    }
  }

  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <DialogContent>
      <form onSubmit={event => { event.preventDefault(); void resolve(); }} className="space-y-4">
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>{effect}</DialogDescription>
        </DialogHeader>
        <p>{`Order ${row.orderCode ?? '—'}, till sale ${row.clientOrderId ?? '—'}`}</p>
        {otherChannel && <div className="space-y-2">
          <p role="status" data-testid="vendurepos-needs-admin-channel-warning">
            {`This sale is in the ${saleCode} channel, and the Dashboard is in ${activeChannel?.code}. Cancelling works only from the sale's channel.`}
          </p>
          <Button type="button" variant="outline" data-testid="vendurepos-needs-admin-switch-channel"
            onClick={() => setActiveChannel(row.channelId)}>{`Switch to ${saleCode}`}</Button>
        </div>}
        <Label htmlFor="vendurepos-needs-admin-note">Note</Label>
        <Input id="vendurepos-needs-admin-note" data-testid="vendurepos-needs-admin-note" required
          value={note} onChange={event => setNote(event.target.value)} />
        {error && <p role="alert" data-testid="vendurepos-needs-admin-error">{error}</p>}
        <DialogFooter>
          <Button type="submit" data-testid="vendurepos-needs-admin-confirm" aria-busy={pending}
            variant={resolution === 'rejected' ? 'destructive' : 'default'}
            disabled={!note.trim() || pending || otherChannel}>{pending ? 'Resolving…' : label}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

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
