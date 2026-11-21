import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

/**
 * The customer-display signalling tables (TallyUI ADR-085 d4–d6, d8). Every row lives in Postgres, so any server
 * instance answers any call. Secrets, claim secrets and tokens are stored only as SHA-256 hex. Times come from the
 * service's clock (`TALLY_DISPLAY_CLOCK`), never from the database's `now()`. Expired rows are deleted, not ignored.
 */

/** A pairing code. Unique store-wide, since a claim carries no channel; it keeps the minting session's channel. */
@Entity()
export class TallyDisplayCode {
  @PrimaryColumn('varchar')
  code: string;

  @Column('varchar')
  channelId: string;

  @Column('varchar')
  deviceId: string;

  @Index()
  @Column('timestamptz')
  expiresAt: Date;

  @Column('boolean', { default: false })
  spent: boolean;
}

/** A claim waiting for the minting till's cashier; it lives as long as its code. */
@Entity()
@Index(['channelId', 'deviceId', 'checkCode'], { unique: true })
export class TallyDisplayPending {
  @PrimaryColumn('varchar')
  id: string;

  @Column('varchar')
  channelId: string;

  @Column('varchar')
  deviceId: string;

  @Column('varchar', { unique: true })
  secretHash: string;

  @Column('varchar')
  displayName: string;

  /** Unique among one till's pending pairings, which is all the till needs to tell them apart. */
  @Column('varchar')
  checkCode: string;

  @Index()
  @Column('timestamptz')
  expiresAt: Date;

  /** The display the claim's token named, which a confirm moves. */
  @Column('varchar', { nullable: true })
  movingDisplayId: string | null;
}

/** A paired display in the registry. Between the confirm and the first collect it holds the claim secret's hash. */
@Entity()
export class TallyDisplay {
  @PrimaryColumn('varchar')
  id: string;

  @Column('varchar')
  channelId: string;

  @Column('varchar')
  deviceId: string;

  @Column('varchar')
  name: string;

  /** The confirming session's user identifier: an administrator's email, or the API key's user. */
  @Column('varchar')
  cashierId: string;

  @Index()
  @Column('timestamptz')
  confirmedAt: Date;

  @Index()
  @Column('timestamptz', { nullable: true })
  lastSeenAt: Date | null;

  @Column('varchar', { nullable: true, unique: true })
  tokenHash: string | null;

  @Column('varchar', { nullable: true, unique: true })
  secretHash: string | null;
}

/** A display's one snapshot. Deleted with its display. */
@Entity()
export class TallyDisplaySnapshot {
  @PrimaryColumn('varchar')
  displayId: string;

  @ManyToOne(() => TallyDisplay, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'displayId' })
  display?: TallyDisplay;

  @Column('text')
  body: string;

  @Column('timestamptz')
  postedAt: Date;
}

/** One queued signalling message, to the display or to its till; deleted when drained or with its display. */
@Entity()
@Index(['displayId', 'toTill'])
export class TallyDisplaySignal {
  /** Send order. */
  @PrimaryGeneratedColumn()
  seq: number;

  @Column('varchar')
  displayId: string;

  @ManyToOne(() => TallyDisplay, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'displayId' })
  display?: TallyDisplay;

  @Column('boolean')
  toTill: boolean;

  @Column('varchar')
  type: string;

  @Column('text')
  payload: string;
}

/** A failed-claim window: `source:<rateLimitSource key>` per source, or `store` for the whole server. */
@Entity()
export class TallyDisplayClaimWindow {
  @PrimaryColumn('varchar')
  key: string;

  @Column('int')
  failures: number;

  @Index()
  @Column('timestamptz')
  expiresAt: Date;
}

/**
 * A till device and the hash of the key `registerDevice` issued it (TallyUI#754), per channel. A row with no key hash
 * and no adopter is a pre-migration device, which adopts once. Pruned when idle for 30 days and owning nothing.
 */
@Entity()
export class TallyDisplayDevice {
  @PrimaryColumn('varchar')
  channelId: string;

  @PrimaryColumn('varchar')
  deviceId: string;

  @Column('varchar', { nullable: true })
  keyHash: string | null;

  /** The adopting session's cashier id, as `confirm` records it. */
  @Column('varchar', { nullable: true })
  adoptedBy: string | null;

  @Column('timestamptz', { nullable: true })
  adoptedAt: Date | null;

  /** Set at register and on each till call whose key is accepted. */
  @Index()
  @Column('timestamptz')
  lastCallAt: Date;
}

export const DISPLAY_ENTITIES = [
  TallyDisplayCode, TallyDisplayPending, TallyDisplay, TallyDisplaySnapshot, TallyDisplaySignal, TallyDisplayClaimWindow, TallyDisplayDevice,
];
