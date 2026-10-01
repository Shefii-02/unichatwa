import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Unique } from 'typeorm';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { jsonColumn, dateColumnType } from '../../../common/utils/column-types';

export enum BatchStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
}

export enum BatchMessageStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export interface BatchMessageResult {
  chatId: string;
  status: BatchMessageStatus;
  messageId?: string;
  error?: {
    code: string;
    message: string;
  };
  sentAt?: Date;
}

export interface BatchProgress {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  cancelled: number;
}

@Entity('message_batches')
// Uniqueness is scoped to the session, not global: one session can't deny a batch id to another.
// Migration 1781800000000 carries the same constraint on existing databases.
@Unique('UQ_message_batches_session_id_batch_id', ['sessionId', 'batchId'])
export class MessageBatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'batch_id' })
  batchId!: string;

  @Column({ name: 'session_id' })
  sessionId!: string;

  @Column({ type: 'varchar', default: BatchStatus.PENDING })
  status!: BatchStatus;

  @Column(jsonColumn())
  messages!: Array<{
    chatId: string;
    type: string;
    content: Record<string, unknown>;
    variables?: Record<string, string>;
  }>;

  @Column({ ...jsonColumn(), nullable: true })
  options!: {
    delayBetweenMessages: number;
    randomizeDelay: boolean;
    stopOnError: boolean;
  };

  @Column({ ...jsonColumn(), nullable: true })
  progress!: BatchProgress;

  @Column({ ...jsonColumn(), nullable: true })
  results!: BatchMessageResult[];

  @Column({ name: 'current_index', default: 0 })
  currentIndex!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ name: 'started_at', type: dateColumnType(), nullable: true, transformer: DateTransformer })
  startedAt!: Date | null;

  @Column({ name: 'completed_at', type: dateColumnType(), nullable: true, transformer: DateTransformer })
  completedAt!: Date | null;
}
