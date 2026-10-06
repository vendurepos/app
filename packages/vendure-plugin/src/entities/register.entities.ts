import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * The register tables (ADR 0003): write-once, every row scoped by the channel the command ran in, each id unique per
 * channel. Rows are only ever inserted; a session's status and the register's counters are derived from them.
 * The till's times are kept as the strings it sent (client time, the fiscal record).
 */

// Minor units are safe integers, so bigint columns; the pg driver reads bigint as a string.
const minor = { type: 'bigint' as const, transformer: {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
} };

/** A drawer, created by the first `register.session.open` that names it (ADR-068 d8). */
@Entity()
export class TallyRegister {
  @PrimaryColumn('varchar')
  channelId: string;

  @PrimaryColumn('varchar')
  id: string;

  @CreateDateColumn()
  receivedAt: Date;
}

/** A session with the till's open fields. */
@Entity()
@Index(['channelId', 'registerId'])
// A session is taken over at most once: a database backstop for the compare-and-set (Postgres allows many NULLs).
@Unique(['channelId', 'supersedes'])
export class TallyRegisterSession {
  @PrimaryColumn('varchar')
  channelId: string;

  @PrimaryColumn('varchar')
  id: string;

  @Column('varchar')
  registerId: string;

  @Column('varchar', { nullable: true })
  storeKey: string | null;

  @Column('varchar', { nullable: true })
  businessDay: string | null;

  @Column('varchar')
  openedAt: string;

  @Column('varchar', { nullable: true })
  openedBy: string | null;

  @Column({ ...minor, nullable: true })
  expectedFloatMinor: number | null;

  @Column(minor)
  countedFloatMinor: number;

  @Column({ ...minor, nullable: true })
  openingVarianceMinor: number | null;

  /** The opening command's device id, as sent. */
  @Column('varchar', { nullable: true })
  deviceId: string | null;

  /** The till's name, trimmed (register v2). */
  @Column('varchar', { nullable: true })
  deviceName: string | null;

  /** The session this one took over, if any (register v2). */
  @Column('varchar', { nullable: true })
  supersedes: string | null;

  @Column('varchar')
  commandId: string;

  @CreateDateColumn()
  receivedAt: Date;
}

/** One applied status change, in applied order (`seq`); the last row's status is the session's (ADR-068 d5a).
 * A `superseded` row is written by the take-over's open and is final. */
@Entity()
@Index(['channelId', 'sessionId'])
export class TallyRegisterSessionStatus {
  @PrimaryGeneratedColumn()
  seq: number;

  @Column('varchar')
  channelId: string;

  @Column('varchar')
  sessionId: string;

  @Column('varchar')
  status: 'open' | 'counting' | 'closed' | 'superseded';

  @Column('varchar')
  at: string;

  @Column('simple-json', { nullable: true })
  counted: Record<string, number> | null;

  @Column('varchar', { nullable: true })
  closedBy: string | null;

  @Column('varchar', { nullable: true })
  approvedBy: string | null;

  @Column('varchar')
  commandId: string;

  @CreateDateColumn()
  receivedAt: Date;
}

/** A session id that resumed onto another session (register v2, ADR-078 d2): a permanent alias; commands and orders naming it count on `sessionId`. */
@Entity()
@Index(['channelId', 'sessionId'])
export class TallyRegisterSessionAlias {
  @PrimaryColumn('varchar')
  channelId: string;

  @PrimaryColumn('varchar')
  id: string;

  @Column('varchar')
  sessionId: string;

  @Column('varchar')
  commandId: string;

  @CreateDateColumn()
  receivedAt: Date;
}

/** A cash movement, or a void naming its target (`voids`); a target is voided at most once. */
@Entity()
@Index(['channelId', 'sessionId'])
@Unique(['channelId', 'voids'])
export class TallyRegisterMovement {
  @PrimaryColumn('varchar')
  channelId: string;

  @PrimaryColumn('varchar')
  id: string;

  @Column('varchar')
  sessionId: string;

  @Column('varchar')
  type: 'paid_in' | 'paid_out' | 'no_sale' | 'void';

  @Column(minor)
  amountMinor: number;

  @Column('varchar', { nullable: true })
  reason: string | null;

  @Column('varchar', { nullable: true })
  voids: string | null;

  @Column('varchar')
  createdAt: string;

  @Column('varchar', { nullable: true })
  createdBy: string | null;

  @Column('varchar')
  commandId: string;

  @CreateDateColumn()
  receivedAt: Date;
}

/** A session's closure: the till's figures as the fiscal record, beside the server's `expected` and `variance`. */
@Entity()
@Unique(['channelId', 'sessionId'])
@Unique(['channelId', 'registerId', 'number'])
export class TallyRegisterClosure {
  @PrimaryColumn('varchar')
  channelId: string;

  @PrimaryColumn('varchar')
  id: string;

  @Column('varchar')
  sessionId: string;

  @Column('varchar')
  registerId: string;

  @Column('int')
  number: number;

  @Column('varchar', { nullable: true })
  businessDay: string | null;

  @Column('varchar')
  openedAt: string;

  @Column('varchar')
  closedAt: string;

  @Column('varchar', { nullable: true })
  closedBy: string | null;

  @Column('varchar', { nullable: true })
  approvedBy: string | null;

  @Column('simple-json')
  tillExpected: Record<string, number>;

  @Column('simple-json')
  counted: Record<string, number>;

  @Column(minor)
  periodSalesTotalMinor: number;

  @Column(minor)
  periodRefundsTotalMinor: number;

  @Column(minor)
  perpetualSalesTotalMinor: number;

  @Column(minor)
  perpetualRefundsTotalMinor: number;

  @Column('int')
  unsyncedCount: number;

  @Column(minor)
  unsyncedTotalMinor: number;

  @Column('varchar')
  softwareVersion: string;

  @Column('simple-json')
  orderIds: string[];

  @Column('simple-json')
  movementIds: string[];

  @Column('simple-json')
  expected: Record<string, number>;

  @Column('simple-json')
  variance: Record<string, number>;

  @Column('varchar')
  commandId: string;

  @CreateDateColumn()
  receivedAt: Date;
}

export const REGISTER_ENTITIES = [TallyRegister, TallyRegisterSession, TallyRegisterSessionStatus, TallyRegisterMovement, TallyRegisterClosure, TallyRegisterSessionAlias];
