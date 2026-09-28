import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity()
export class TallyCommand {
  @PrimaryColumn('varchar')
  id: string;

  @Index()
  @Column('varchar')
  clientOrderId: string;

  @Column('varchar')
  fingerprint: string;

  @Column('varchar')
  status: string;

  @Column('simple-json', { nullable: true })
  result: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;
}
