import { Injectable, Logger } from '@nestjs/common';
import { MysqlService } from '../wa-chat/mysql.service';
import { nowLocal, toIso } from '../widget-chat/time.util';

/** Quoted "now" in the Laravel app timezone — Laravel and Node must write the same wall-clock into shared DATETIME columns. */
const NOW = (): string => `'${nowLocal()}'`;

/** Emits a named event to one staff member (every device). Provided by the gateway so this service stays socket-agnostic. */
export type StaffEmitter = (staffId: number, event: string, data: unknown) => void;

interface Member {
  chat_id: number;
  type: 'direct' | 'group';
  role: 'admin' | 'member';
  only_admins_post: number;
  company_id: number;
}

export interface SendPayload {
  chat_id: number;
  body?: string | null;
  reply_to_id?: number | null;
  mentions?: number[];
  /** Client-generated id: a retry of the same send (socket timeout → REST) returns the original message instead of duplicating it. */
  client_id?: string;
  latitude?: number;
  longitude?: number;
  location_label?: string;
  contact_name?: string;
  contact_phone?: string;
}

type Ack<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Team chat over the staff socket (Node owns the live path): send / edit / delete / react / read / forward.
 * Same MySQL tables Laravel migrates (`team_chats`, `team_chat_members`, `team_chat_messages`, `team_chat_reactions`)
 * and the same rules as Laravel's REST controller, so the REST endpoints stay a working fallback.
 * Identity (`staffId`) always comes from the verified socket JWT — never from the payload.
 * Push notifications are delegated to Laravel (FCM lives there) via /internal/team-chat-push.
 */
@Injectable()
export class TeamChatService {
  private readonly logger = new Logger(TeamChatService.name);
  private emitter: StaffEmitter = () => undefined;

  constructor(private readonly db: MysqlService) {}

  setEmitter(fn: StaffEmitter): void {
    this.emitter = fn;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async member(chatId: number, staffId: number): Promise<Member> {
    const rows = await this.db.query<Member>(
      `SELECT m.chat_id, c.type, m.role, c.only_admins_post, c.company_id
         FROM team_chat_members m JOIN team_chats c ON c.id = m.chat_id
        WHERE m.chat_id = ? AND m.user_id = ? AND m.left_at IS NULL LIMIT 1`,
      [chatId, staffId],
    );
    if (!rows.length) throw new Error('You are not a member of this chat.');
    return rows[0];
  }

  private async memberIds(chatId: number): Promise<number[]> {
    const rows = await this.db.query<{ user_id: number }>(
      'SELECT user_id FROM team_chat_members WHERE chat_id = ? AND left_at IS NULL',
      [chatId],
    );
    return rows.map((r) => Number(r.user_id));
  }

  private async safe<T extends object>(fn: () => Promise<T>): Promise<Ack<T>> {
    try {
      return { ok: true, ...(await fn()) } as Ack<T>;
    } catch (e) {
      return { ok: false, error: (e as Error).message || 'Something went wrong.' };
    }
  }

  /** Message in the shape the app (and Laravel's REST `format()`) uses, personalised for `viewerId`. */
  /** One message for one viewer (thin wrapper). */
  private async format(messageId: number, viewerId: number): Promise<Record<string, unknown> | null> {
    return (await this.formatForViewers(messageId, [viewerId])).get(viewerId) ?? null;
  }

  /**
   * Message in the shape the app uses, personalised per viewer — but built from ONE round of shared queries
   * (message, reply, names, reactions, receipt totals, pin) plus a single stars lookup, instead of ~8 queries
   * per viewer. This is what keeps sends fast in big groups.
   */
  private async formatForViewers(messageId: number, viewers: number[]): Promise<Map<number, Record<string, unknown>>> {
    const out = new Map<number, Record<string, unknown>>();
    const rows = await this.db.query<Record<string, any>>("SELECT *, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at_s FROM team_chat_messages WHERE id = ? LIMIT 1", [messageId]);
    const m = rows[0];
    if (!m || !viewers.length) return out;

    const [replyRows, reacts, st, pin, stars] = await Promise.all([
      m.reply_to_id ? this.db.query<Record<string, any>>('SELECT * FROM team_chat_messages WHERE id = ? LIMIT 1', [m.reply_to_id]) : Promise.resolve([]),
      this.db.query<{ emoji: string; user_id: number }>('SELECT emoji, user_id FROM team_chat_reactions WHERE message_id = ?', [messageId]),
      // seen = read; delivered = reached the device (or read); recipients = everyone except the sender.
      this.db.query<{ recipients: number; seen: number; delivered: number }>(
        `SELECT COUNT(*) AS recipients,
                SUM(last_read_message_id >= ?) AS seen,
                SUM(GREATEST(last_delivered_message_id, last_read_message_id) >= ?) AS delivered
           FROM team_chat_members WHERE chat_id = ? AND left_at IS NULL AND user_id <> ?`,
        [m.id, m.id, m.chat_id, m.sender_id ?? 0],
      ),
      this.db.query('SELECT 1 FROM team_chat_pins WHERE message_id = ? LIMIT 1', [m.id]),
      this.db.query<{ user_id: number }>(`SELECT user_id FROM team_chat_stars WHERE message_id = ? AND user_id IN (${viewers.map(() => '?').join(',')})`, [m.id, ...viewers]),
    ])
    const reply = (replyRows as Record<string, any>[])[0] ?? null;
    const nameIds = [m.sender_id, reply?.sender_id, m.deleted_by].filter(Boolean).map(Number);
    const names = new Map<number, string>();
    if (nameIds.length) {
      const u = await this.db.query<{ id: number; name: string }>(`SELECT id, name FROM users WHERE id IN (${nameIds.map(() => '?').join(',')})`, nameIds);
      u.forEach((x) => names.set(Number(x.id), x.name));
    }

    const grouped = new Map<string, { count: number; mineBy: Set<number> }>();
    for (const r of reacts) {
      const g = grouped.get(r.emoji) ?? { count: 0, mineBy: new Set<number>() };
      g.count++;
      g.mineBy.add(Number(r.user_id));
      grouped.set(r.emoji, g);
    }
    const starredBy = new Set(stars.map((x) => Number(x.user_id)));
    const deleted = !!m.deleted_at;
    const base = {
      id: m.id,
      type: m.type,
      sender_id: m.sender_id,
      sender_name: m.sender_id ? (names.get(Number(m.sender_id)) ?? '') : null,
      body: deleted ? null : m.body,
      deleted,
      edited: !!m.edited_at,
      attachment_url: deleted ? null : m.attachment_url,
      attachment_name: m.attachment_name,
      attachment_size: m.attachment_size,
      attachment_mime: m.attachment_mime,
      duration: m.duration_seconds,
      forwarded: !!m.forwarded,
      latitude: m.latitude !== null ? Number(m.latitude) : null,
      longitude: m.longitude !== null ? Number(m.longitude) : null,
      location_label: m.location_label,
      contact_name: m.contact_name,
      contact_phone: m.contact_phone,
      mentions: m.mentions ? (typeof m.mentions === 'string' ? JSON.parse(m.mentions) : m.mentions) : [],
      reply_to: reply
        ? {
            id: reply.id,
            sender_name: reply.sender_id ? (names.get(Number(reply.sender_id)) ?? null) : null,
            preview: this.preview(reply),
            type: reply.type,
            thumb: reply.type === 'image' && !reply.deleted_at ? reply.attachment_url : null,
          }
        : null,
      pinned: pin.length > 0,
      seen_by_count: Number(st[0]?.seen ?? 0),
      delivered_count: Number(st[0]?.delivered ?? 0),
      recipients: Number(st[0]?.recipients ?? 0),
      created_at: toIso(m.created_at_s),
    };
    for (const v of viewers) {
      out.set(v, {
        ...base,
        mine: Number(m.sender_id) === v,
        starred: starredBy.has(v),
        // Only the sender learns who removed their message (company admins read the original through Laravel).
        deleted_by_name: deleted && Number(m.sender_id) === v && m.deleted_by ? (names.get(Number(m.deleted_by)) ?? null) : null,
        reactions: [...grouped.entries()].map(([emoji, g]) => ({ emoji, count: g.count, mine: g.mineBy.has(v) })),
      });
    }
    return out;
  }

  /** A centred "X created the group" style line; shown to every member immediately. */
  async systemMessage(chatId: number, companyId: number, by: number, text: string): Promise<void> {
    const res = await this.db.run(
      `INSERT INTO team_chat_messages (chat_id, company_id, sender_id, type, body, created_at, updated_at) VALUES (?,?,NULL,'system',?,${NOW()},${NOW()})`,
      [chatId, companyId, text],
    );
    await this.db.execute(`UPDATE team_chats SET last_message_id = ?, last_message_at = ${NOW()} WHERE id = ?`, [res.insertId, chatId]);
    this.background(this.fanout(chatId, by, 'system', { message_id: res.insertId }));
  }

  private preview(m: Record<string, any>): string {
    if (m.deleted_at) return 'Message deleted';
    switch (m.type) {
      case 'image': return '📷 Photo';
      case 'video': return '🎥 Video';
      case 'audio': return '🎤 Voice message';
      case 'location': return '📍 Location';
      case 'contact': return `👤 ${m.contact_name || 'Contact'}`;
      case 'file': return `📎 ${m.attachment_name || 'File'}`;
      default: return String(m.body ?? '');
    }
  }

  /** Tell every member (all their devices): `{chat_id, kind, message?}` — `message` is personalised per viewer. */
  private async fanout(chatId: number, by: number, kind: string, extra: Record<string, unknown> = {}, withMessageId?: number): Promise<void> {
    const members = await this.memberIds(chatId);
    const per = withMessageId ? await this.formatForViewers(withMessageId, members) : null;
    for (const uid of members) {
      const payload: Record<string, unknown> = { chat_id: chatId, kind, by, ...extra };
      if (per) payload.message = per.get(uid) ?? null;
      this.emitter(uid, 'team_chat', payload);
    }
  }

  /** Fire-and-forget fan-out: the sender's ack must never wait on delivering to everyone else. */
  private background(p: Promise<unknown>): void {
    p.catch((e) => this.logger.warn(`team-chat fanout failed: ${(e as Error).message}`));
  }

  /** Per-message delivered / read times (message info screen) for everything between the old and new marker. */
  private async recordReceipts(chatId: number, userId: number, fromExclusive: number, toInclusive: number, read: boolean): Promise<void> {
    if (toInclusive <= fromExclusive) return;
    await this.db.execute(
      `INSERT INTO team_chat_receipts (message_id, user_id, delivered_at, read_at)
       SELECT id, ?, ${NOW()}, ${read ? NOW() : 'NULL'} FROM team_chat_messages
        WHERE chat_id = ? AND id > ? AND id <= ? AND type <> 'system' AND (sender_id IS NULL OR sender_id <> ?)
       ON DUPLICATE KEY UPDATE delivered_at = COALESCE(delivered_at, VALUES(delivered_at))${read ? ', read_at = COALESCE(read_at, VALUES(read_at))' : ''}`,
      [userId, chatId, fromExclusive, toInclusive, userId],
    );
  }

  private pushViaLaravel(chatId: number, messageId: number, senderId: number, mentions: number[]): void {
    const base = (process.env.LARAVEL_INTERNAL_URL || process.env.LARAVEL_URL || 'http://localhost:8000').replace(/\/$/, '');
    const key = process.env.INTERNAL_API_KEY;
    if (!key) return;
    void fetch(`${base}/api/v1/internal/team-chat-push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-internal-key': key },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, sender_id: senderId, mentions }),
      signal: AbortSignal.timeout(5000),
    }).catch((e) => this.logger.debug(`team-chat push failed: ${(e as Error).message}`));
  }

  // ── commands ───────────────────────────────────────────────────────────────

  send(staffId: number, p: SendPayload): Promise<Ack<{ message: unknown }>> {
    return this.safe(async () => {
      const chatId = Number(p?.chat_id);
      const me = await this.member(chatId, staffId);
      if (me.type === 'group' && me.only_admins_post && me.role !== 'admin') throw new Error('Only admins can post in this group.');

      const clientId = typeof p.client_id === 'string' && p.client_id ? p.client_id.slice(0, 40) : null;
      if (clientId) {
        const dup = await this.db.query<{ id: number }>('SELECT id FROM team_chat_messages WHERE chat_id = ? AND sender_id = ? AND client_id = ? LIMIT 1', [chatId, staffId, clientId]);
        if (dup.length) return { message: await this.format(Number(dup[0].id), staffId) };
      }
      const body = typeof p.body === 'string' ? p.body.trim().slice(0, 4000) : '';
      const isLocation = typeof p.latitude === 'number' && typeof p.longitude === 'number'
        && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180;
      const isContact = !!p.contact_name?.trim();
      if (!body && !isLocation && !isContact) throw new Error('Write a message or attach something.');
      const type = isLocation ? 'location' : isContact ? 'contact' : 'text';

      let replyTo: number | null = null;
      if (p.reply_to_id) {
        const r = await this.db.query('SELECT id FROM team_chat_messages WHERE id = ? AND chat_id = ? LIMIT 1', [p.reply_to_id, chatId]);
        if (!r.length) throw new Error('Bad reply.');
        replyTo = Number(p.reply_to_id);
      }

      // Only people actually in this chat can be mentioned.
      let mentions: number[] = [];
      const wanted = (p.mentions ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (wanted.length) {
        const ids = await this.memberIds(chatId);
        mentions = wanted.filter((n) => ids.includes(n));
      }

      const res = await this.db.run(
        `INSERT INTO team_chat_messages
           (chat_id, company_id, sender_id, type, body, latitude, longitude, location_label, contact_name, contact_phone, reply_to_id, mentions, client_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,${NOW()},${NOW()})`,
        [chatId, me.company_id, staffId, type, body || null,
          isLocation ? p.latitude! : null, isLocation ? p.longitude! : null, isLocation ? (p.location_label ?? null) : null,
          isContact ? p.contact_name!.trim().slice(0, 120) : null, isContact ? (p.contact_phone ?? '').slice(0, 40) : null,
          replyTo, mentions.length ? JSON.stringify(mentions) : null, clientId],
      );
      const id = res.insertId;
      await this.db.execute(`UPDATE team_chats SET last_message_id = ?, last_message_at = ${NOW()} WHERE id = ?`, [id, chatId]);
      await this.db.execute('UPDATE team_chat_members SET last_read_message_id = ? WHERE chat_id = ? AND user_id = ?', [id, chatId, staffId]);

      this.background(this.fanout(chatId, staffId, 'message', { message_id: id }, id));
      this.pushViaLaravel(chatId, id, staffId, mentions);
      return { message: await this.format(id, staffId) };
    });
  }

  private async ownMessage(staffId: number, messageId: number) {
    const rows = await this.db.query<Record<string, any>>('SELECT * FROM team_chat_messages WHERE id = ? LIMIT 1', [messageId]);
    const m = rows[0];
    if (!m) throw new Error('Message not found.');
    const me = await this.member(Number(m.chat_id), staffId);
    return { m, me };
  }

  edit(staffId: number, messageId: number, body: string): Promise<Ack> {
    return this.safe(async () => {
      const { m } = await this.ownMessage(staffId, Number(messageId));
      if (Number(m.sender_id) !== staffId || m.deleted_at || m.type !== 'text') throw new Error('You can only edit your own text messages.');
      const text = String(body ?? '').trim().slice(0, 4000);
      if (!text) throw new Error('Message cannot be empty.');
      await this.db.execute(`UPDATE team_chat_messages SET body = ?, edited_at = ${NOW()}, updated_at = ${NOW()} WHERE id = ?`, [text, m.id]);
      this.background(this.fanout(Number(m.chat_id), staffId, 'edit', { message_id: Number(m.id) }));
      return {};
    });
  }

  /** scope `me` hides it from this user only; `everyone` (sender or group admin) leaves a tombstone but keeps the original on file. */
  delete(staffId: number, messageId: number, scope: 'me' | 'everyone' = 'everyone'): Promise<Ack> {
    return this.safe(async () => {
      const { m, me } = await this.ownMessage(staffId, Number(messageId));
      if (scope === 'me') {
        await this.db.execute(`INSERT IGNORE INTO team_chat_hides (message_id, user_id, created_at) VALUES (?,?,${NOW()})`, [m.id, staffId]);
        return {};
      }
      if (Number(m.sender_id) !== staffId && !(me.type === 'group' && me.role === 'admin')) throw new Error('Not allowed.');
      await this.db.execute(`UPDATE team_chat_messages SET deleted_at = ${NOW()}, deleted_by = ?, updated_at = ${NOW()} WHERE id = ?`, [staffId, m.id]);
      this.background(this.fanout(Number(m.chat_id), staffId, 'delete', { message_id: Number(m.id) }));
      return {};
    });
  }

  react(staffId: number, messageId: number, emoji: string): Promise<Ack> {
    return this.safe(async () => {
      const { m } = await this.ownMessage(staffId, Number(messageId));
      const e = String(emoji ?? '').slice(0, 16);
      if (!e) throw new Error('Pick an emoji.');
      const ex = await this.db.query('SELECT id FROM team_chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ? LIMIT 1', [m.id, staffId, e]);
      if (ex.length) await this.db.execute('DELETE FROM team_chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [m.id, staffId, e]);
      else await this.db.execute(`INSERT INTO team_chat_reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,${NOW()})`, [m.id, staffId, e]);
      this.background(this.fanout(Number(m.chat_id), staffId, 'reaction', { message_id: Number(m.id) }));
      return {};
    });
  }

  read(staffId: number, chatId: number): Promise<Ack> {
    return this.safe(async () => {
      await this.member(Number(chatId), staffId);
      const r = await this.db.query<{ last: number | null }>('SELECT MAX(id) AS last FROM team_chat_messages WHERE chat_id = ?', [chatId]);
      const last = Number(r[0]?.last ?? 0);
      const mk = await this.db.query<{ r: number; d: number }>(
        'SELECT last_read_message_id AS r, last_delivered_message_id AS d FROM team_chat_members WHERE chat_id = ? AND user_id = ? LIMIT 1',
        [chatId, staffId],
      );
      await this.recordReceipts(Number(chatId), staffId, Math.min(Number(mk[0]?.r ?? 0), Number(mk[0]?.d ?? 0)), last, true);
      await this.db.execute(
        'UPDATE team_chat_members SET last_read_message_id = ?, last_delivered_message_id = GREATEST(last_delivered_message_id, ?) WHERE chat_id = ? AND user_id = ?',
        [last, last, chatId, staffId],
      );
      this.background(this.fanout(Number(chatId), staffId, 'read', { last_id: last }));
      return {};
    });
  }

  /** This device has received everything up to now → the senders' ticks turn ✓✓. */
  delivered(staffId: number, chatId: number): Promise<Ack> {
    return this.safe(async () => {
      await this.member(Number(chatId), staffId);
      const r = await this.db.query<{ last: number | null }>('SELECT MAX(id) AS last FROM team_chat_messages WHERE chat_id = ?', [chatId]);
      const last = Number(r[0]?.last ?? 0);
      const prev = await this.db.query<{ d: number }>(
        'SELECT last_delivered_message_id AS d FROM team_chat_members WHERE chat_id = ? AND user_id = ? LIMIT 1',
        [chatId, staffId],
      );
      await this.recordReceipts(Number(chatId), staffId, Number(prev[0]?.d ?? 0), last, false);
      await this.db.execute(
        'UPDATE team_chat_members SET last_delivered_message_id = GREATEST(last_delivered_message_id, ?) WHERE chat_id = ? AND user_id = ?',
        [last, chatId, staffId],
      );
      this.background(this.fanout(Number(chatId), staffId, 'delivered', { last_id: last }));
      return {};
    });
  }

  forward(staffId: number, messageId: number, chatIds: number[]): Promise<Ack> {
    return this.safe(async () => {
      const { m } = await this.ownMessage(staffId, Number(messageId));
      if (m.deleted_at || m.type === 'system') throw new Error('Cannot forward this message.');
      for (const cid of (chatIds ?? []).map(Number).slice(0, 10)) {
        let target: Member;
        try { target = await this.member(cid, staffId); } catch { continue; }
        if (target.type === 'group' && target.only_admins_post && target.role !== 'admin') continue;
        const res = await this.db.run(
          `INSERT INTO team_chat_messages
             (chat_id, company_id, sender_id, type, body, attachment_url, attachment_name, attachment_size, attachment_mime,
              duration_seconds, latitude, longitude, location_label, contact_name, contact_phone, forwarded, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,${NOW()},${NOW()})`,
          [cid, target.company_id, staffId, m.type, m.body, m.attachment_url, m.attachment_name, m.attachment_size, m.attachment_mime,
            m.duration_seconds, m.latitude, m.longitude, m.location_label, m.contact_name, m.contact_phone],
        );
        const id = res.insertId;
        await this.db.execute(`UPDATE team_chats SET last_message_id = ?, last_message_at = ${NOW()} WHERE id = ?`, [id, cid]);
        await this.db.execute('UPDATE team_chat_members SET last_read_message_id = ? WHERE chat_id = ? AND user_id = ?', [id, cid, staffId]);
        this.background(this.fanout(cid, staffId, 'message', { message_id: id }, id));
        this.pushViaLaravel(cid, id, staffId, []);
      }
      return {};
    });
  }
}
