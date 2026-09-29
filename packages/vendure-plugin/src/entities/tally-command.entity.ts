import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * The idempotency ledger (ADR 0002 §2): one row per command id, claimed inside the command's
 * transaction, holding the fingerprint and the stored result that replays return.
 */
@Entity()
export class TallyCommand {
  @PrimaryColumn('varchar')
  id: string;

  /** The channel the command was claimed in (N6), as a string of the channel's id. */
  @Column('varchar')
  channelId: string;

  @Index()
  @Column('varchar')
  clientOrderId: string;

  @Column('varchar')
  fingerprint: string;

  /** 'pending' while claimed, then 'applied' or 'rejected', or 'needs_admin' until an admin resolves it (VP2). */
  @Column('varchar')
  status: string;

  @Column('simple-json', { nullable: true })
  result: Record<string, unknown> | null;

  /** The sale's stock top-ups and their exact locations, for an admin's take-back (migration TallyPosVp2a). */
  @Column('simple-json', { nullable: true })
  topUps: Array<{ variantId: string; stockLocationId: string; quantity: number }> | null;

  @CreateDateColumn()
  createdAt: Date;
}
