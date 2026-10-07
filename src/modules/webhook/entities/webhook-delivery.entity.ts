import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * A row per webhook delivery ATTEMPT — success or failure, not just the terminally-failed ones
 * `WebhookDeliveryFailure` tracks. Lets an operator browse what was actually sent to a receiver and
 * how it answered, instead of only learning about an outage after every retry is exhausted.
 * Written by both delivery paths (the primary BullMQ processor and the deprecated direct fallback)
 * through the shared `recordDeliveryAttempt` helper in `utils/deliver-once.ts`, mirroring how both
 * already share `recordTerminalFailure`. Best-effort: a write failure here must never affect the
 * delivery outcome it is logging.
 *
 * `requestPayload`/`responseBody`/`error` are truncated before insert (see `deliver-once.ts`) so a
 * large event or a verbose receiver response cannot bloat this append-only table unboundedly.
 *
 * Lives on the `data` connection (auto-loaded by the webhook entity glob).
 */
@Entity('openwa_gw_webhook_deliveries')
@Index('IDX_webhook_deliveries_sessionId_createdAt', ['sessionId', 'createdAt'])
@Index('IDX_webhook_deliveries_webhookId_createdAt', ['webhookId', 'createdAt'])
export class WebhookDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  webhookId!: string;

  @Column()
  sessionId!: string;

  @Column()
  event!: string;

  @Column()
  url!: string;

  /** Truncated JSON of the WebhookPayload sent, or null if it could not be serialized. */
  @Column({ type: 'text', nullable: true })
  requestPayload!: string | null;

  /** Null when no HTTP exchange completed (e.g. a network error or a stalled job). */
  @Column({ type: 'int', nullable: true })
  responseStatus!: number | null;

  /** Truncated response detail: the receiver's statusText on success, or the error text on failure. */
  @Column({ type: 'text', nullable: true })
  responseBody!: string | null;

  @Column({ type: 'boolean', default: false })
  success!: boolean;

  @Column({ type: 'int' })
  attempt!: number;

  @Column({ type: 'int' })
  durationMs!: number;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
