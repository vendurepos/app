import { Channel, EventBus, RequestContext, RequestContextService, TransactionalConnection, VendureEvent } from '@vendure/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPluginTestEnvironment } from './env';

// An event carrying a RequestContext, as Vendure's own do: EventBus.ofType waits for that context's transaction.
class ProbeEvent extends VendureEvent {
  constructor(public ctx: RequestContext, public label: string) {
    super();
  }
}

// ADR 0002 re-ruling 3 rests on this Vendure fact: a full rollback drops the events published inside it.
describe('Vendure 3.7.3 delivers the events of a transaction only when it commits', () => {
  const environment = createPluginTestEnvironment();
  const { server } = environment;
  const received: string[] = [];
  let bus: EventBus;
  let connection: TransactionalConnection;
  let ctx: RequestContext;
  beforeAll(async () => {
    await environment.init();
    bus = server.app.get(EventBus);
    connection = server.app.get(TransactionalConnection);
    ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    bus.ofType(ProbeEvent).subscribe(event => received.push(event.label));
  });
  afterAll(() => server.destroy());

  async function arrives(label: string) {
    const start = performance.now();
    while (!received.includes(label) && performance.now() - start < 5000) await new Promise(resolve => setTimeout(resolve, 20));
    return received.includes(label);
  }
  // A committed event published after the probe, awaited, then a margin: a probe that was going to arrive has arrived.
  async function settled(label: string) {
    await connection.withTransaction(ctx, async txCtx => { await bus.publish(new ProbeEvent(txCtx, `${label}-marker`)); });
    expect(await arrives(`${label}-marker`)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  it('a rolled-back transaction: the event published with its context never arrives', async () => {
    await expect(connection.withTransaction(ctx, async txCtx => {
      await bus.publish(new ProbeEvent(txCtx, 'rolled-back'));
      throw new Error('roll back');
    })).rejects.toThrow('roll back');
    await settled('rolled-back');
    expect(received).not.toContain('rolled-back');
  });

  it('control: the same event in a committed transaction arrives', async () => {
    await connection.withTransaction(ctx, async txCtx => {
      await bus.publish(new ProbeEvent(txCtx, 'committed'));
    });
    expect(await arrives('committed')).toBe(true);
  });

  it('the known leak: an event of a savepoint rolled back inside a committing transaction still arrives', async () => {
    await connection.withTransaction(ctx, async txCtx => {
      await expect(connection.withTransaction(txCtx, async savepointCtx => {
        await bus.publish(new ProbeEvent(savepointCtx, 'savepoint'));
        throw new Error('roll back to the savepoint');
      })).rejects.toThrow('roll back to the savepoint');
      // The outer transaction is still open after the savepoint's rollback.
      expect(connection.getRepository(txCtx, Channel).manager.queryRunner?.isTransactionActive).toBe(true);
    });
    expect(await arrives('savepoint')).toBe(true);
  });
});
