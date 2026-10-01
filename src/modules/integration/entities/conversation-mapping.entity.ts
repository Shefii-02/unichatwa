import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { jsonColumn, mysqlIndexLength } from '../../../common/utils/column-types';

export type HandoverState = 'bot' | 'human' | 'closed';

// Maps a WA chat to a provider conversation, both directions. sessionId is non-FK provenance
// (a mapping outlives a session; last-write-wins).
@Entity('openwa_gw_conversation_mappings')
@Index('UQ_conversation_mappings_forward', ['sessionId', 'chatId', 'pluginId', 'instanceId'], { unique: true })
@Index('UQ_conversation_mappings_reverse', ['pluginId', 'instanceId', 'providerConversationId'], { unique: true })
export class ConversationMapping {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Lengths below are a MySQL-only guard (no-op on sqlite/postgres) — the two @Index(..., {unique:
  // true}) above are composite, and un-lengthed MySQL varchars would make either index exceed
  // InnoDB's max key length. See mysqlIndexLength's doc comment.
  @Column(mysqlIndexLength(36)) // session id is a uuid
  sessionId!: string;

  @Column(mysqlIndexLength(100)) // WhatsApp JID, generous margin over real-world chat/group/newsletter id shapes
  chatId!: string;

  @Column(mysqlIndexLength(50)) // plugin slug, e.g. "chatwoot", "typebot-connector"
  pluginId!: string;

  @Column(mysqlIndexLength(36)) // instance id is a uuid
  instanceId!: string;

  @Column(mysqlIndexLength(191)) // external provider's own conversation id
  providerConversationId!: string;

  @Column({ default: 'bot' })
  handoverState!: HandoverState;

  @Column({ ...jsonColumn(), nullable: true })
  metadata!: Record<string, unknown> | null;

  @UpdateDateColumn()
  updatedAt!: Date;
}
