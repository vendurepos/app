import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** A receipt-email send window (#345): `order:<order id>` (30 days), `user:<user id>` or `channel:<channel id>` (24 hours each). */
@Entity()
export class TallyReceiptEmailWindow {
  @PrimaryColumn('varchar')
  key: string;

  @Column('int')
  sends: number;

  @Index()
  @Column('timestamptz')
  expiresAt: Date;
}
