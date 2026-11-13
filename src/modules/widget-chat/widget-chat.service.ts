import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MysqlService } from '../wa-chat/mysql.service';
import { StaffNotifyGateway } from '../staff-notify/staff-notify.gateway';
import { WidgetVisitorGateway } from '../staff-notify/widget-visitor.gateway';
import { StaffIdentity } from './staff-auth.service';
import { dt, nowLocal, toIso } from './time.util';

export type InboxTab = 'all' | 'unread' | 'read' | 'closed';

interface MessageRow {
  id: number; role: string; type: string | null; text: string | null;
  attachment_path: string | null; attachment_name: string | null; attachment_mime: string | null; attachment_size: number | null;
  reply_to_id: number | null; created_at: string | null;
}

const CLOSED = `(wc.status = 'closed' OR wc.live_status = 'ended')`;
const UNREAD = `EXISTS (SELECT 1 FROM widget_messages m WHERE m.widget_conversation_id = wc.id AND m.role = 'visitor'
                  AND (wc.staff_read_at IS NULL OR m.created_at > wc.staff_read_at))`;
const MESSAGE_COLS = `id, role, type, text, attachment_path, attachment_name, attachment_mime, attachment_size, reply_to_id, ${dt('created_at')}`;

const int = (v: unknown, def: number, min: number, max: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/**
 * Staff side of website live chat, served by Node over the SAME MySQL tables Laravel uses
 * (widget_conversations / widget_messages / widget_chat_staff). Every mutation pushes socket events straight to
 * the company's staff room and the visitor's own room — no Laravel hop, no polling.
 */
@Injectable()
export class WidgetChatService {
  constructor(
    private readonly db: MysqlService,
    private readonly staffSocket: StaffNotifyGateway,
    private readonly visitorSocket: WidgetVisitorGateway,
  ) {}

  // ── formatting ───────────────────────────────────────────────────────────
  private fileUrl(path: string | null): string | null {
    if (!path) return null;
    const base = (process.env.LARAVEL_PUBLIC_URL || process.env.LARAVEL_URL || '').replace(/\/$/, '');
    return `${base}/storage/${path}`;
  }

  private preview(m: Pick<MessageRow, 'text' | 'type' | 'attachment_name'>): string {
    if ((m.text ?? '').trim() !== '') return m.text!.length > 80 ? m.text!.slice(0, 80) : m.text!;
    return ({ image: '📷 Photo', audio: '🎤 Voice message' } as Record<string, string>)[m.type ?? ''] ?? (m.type === 'file' ? `📎 ${m.attachment_name || 'File'}` : '');
  }

  /** Same JSON shape Laravel's LiveChatSupport::format returns — the web portal, mobile app and widget all read it. */
  private async format(rows: MessageRow[]): Promise<unknown[]> {
    const replyIds = [...new Set(rows.map(r => r.reply_to_id).filter((x): x is number => !!x))];
    const replies = new Map<number, MessageRow>();
    if (replyIds.length) {
      const found = await this.db.query<MessageRow>(`SELECT ${MESSAGE_COLS} FROM widget_messages WHERE id IN (${replyIds.map(() => '?').join(',')})`, replyIds);
      found.forEach(r => replies.set(r.id, r));
    }
    return rows.map(m => {
      const reply = m.reply_to_id ? replies.get(m.reply_to_id) : undefined;
      return {
        id: m.id, role: m.role, type: m.type || 'text', text: m.text ?? '',
        url: this.fileUrl(m.attachment_path), file_name: m.attachment_name, mime: m.attachment_mime, size: m.attachment_size,
        reply_to: reply ? { id: reply.id, role: reply.role, type: reply.type || 'text', text: this.preview(reply) } : null,
        created_at: toIso(m.created_at),
      };
    });
  }

  // ── realtime ─────────────────────────────────────────────────────────────
  private async changed(staff: StaffIdentity, id: number, kind: string, message?: unknown, notifyVisitor = false): Promise<void> {
    this.staffSocket.emitToCompany(staff.companyId, 'widget_chat_update', { conversation_id: id, kind, ...(message ? { message } : {}) });
    if (notifyVisitor) this.visitorSocket.emitToConversation(id, 'widget_update', {});
  }

  private async addMessage(convoId: number, role: string, text: string, extra: { replyToId?: number | null } = {}): Promise<MessageRow> {
    const now = nowLocal();
    const r = await this.db.run(
      `INSERT INTO widget_messages (widget_conversation_id, role, text, type, reply_to_id, created_at) VALUES (?, ?, ?, 'text', ?, ?)`,
      [convoId, role, text, extra.replyToId ?? null, now],
    );
    return { id: r.insertId, role, type: 'text', text, attachment_path: null, attachment_name: null, attachment_mime: null, attachment_size: null, reply_to_id: extra.replyToId ?? null, created_at: now };
  }

  private async find(staff: StaffIdentity, id: number): Promise<Record<string, any>> {
    const rows = await this.db.query<Record<string, any>>(
      `SELECT wc.id, wc.chat_widget_id, wc.visitor_name, wc.visitor_phone, wc.status, wc.case_status, wc.flag_reason, wc.review_note,
              wc.live_status, wc.staff_name, wc.assigned_user_id, wc.page_url, wc.contact_id, wc.lead_id,
              ${dt('wc.flagged_at')}, ${dt('wc.reviewed_at')}, ${dt('wc.callback_confirmed_at')}
         FROM widget_conversations wc WHERE wc.id = ? AND wc.company_id = ? LIMIT 1`,
      [id, staff.companyId],
    );
    if (!rows.length) throw new NotFoundException('Conversation not found');
    const c = rows[0];
    return { ...c, flagged_at: toIso(c.flagged_at), reviewed_at: toIso(c.reviewed_at), callback_confirmed_at: toIso(c.callback_confirmed_at) };
  }

  // ── reads ────────────────────────────────────────────────────────────────
  async inbox(staff: StaffIdentity, q: { tab?: string; q?: string; page?: unknown; per_page?: unknown; widget_id?: unknown }) {
    const tab: InboxTab = q.tab === 'read' || q.tab === 'closed' || q.tab === 'all' ? q.tab : 'unread';
    const page = int(q.page, 1, 1, 100000);
    const perPage = int(q.per_page, 30, 1, 100);
    const where: string[] = ['wc.company_id = ?', 'EXISTS (SELECT 1 FROM widget_messages x WHERE x.widget_conversation_id = wc.id)'];
    const params: (string | number)[] = [staff.companyId];

    const widgetId = int(q.widget_id, 0, 0, Number.MAX_SAFE_INTEGER);
    if (widgetId) { where.push('wc.chat_widget_id = ?'); params.push(widgetId); }

    const s = typeof q.q === 'string' ? q.q.trim().slice(0, 80) : '';
    if (s) {
      const digits = s.replace(/\D+/g, '');
      const like = `%${s.replace(/[\\%_]/g, '\\$&')}%`;
      let cond = `(wc.visitor_name LIKE ? OR wc.visitor_phone LIKE ?`;
      params.push(like, like);
      if (digits.length >= 3) { cond += ` OR REGEXP_REPLACE(wc.visitor_phone, '[^0-9]', '') LIKE ?`; params.push(`%${digits}%`); }
      where.push(cond + ')');
    }
    const base = where.join(' AND ');

    const tabCond = tab === 'all' ? '1 = 1' : tab === 'closed' ? CLOSED : tab === 'read' ? `NOT ${CLOSED} AND NOT ${UNREAD}` : `NOT ${CLOSED} AND ${UNREAD}`;
    const offset = (page - 1) * perPage;

    const [rows, counts] = await Promise.all([
      this.db.query<Record<string, any>>(
        `SELECT wc.id, wc.chat_widget_id, cw.name AS widget_name, wc.visitor_name, wc.visitor_phone, wc.status, wc.case_status,
                wc.live_status, wc.ai_active, wc.staff_name, wc.assigned_user_id, wc.page_url, ${UNREAD} AS is_unread,
                ${dt('wc.last_message_at')}, ${dt('wc.live_requested_at')}, ${dt('wc.callback_confirmed_at')},
                (SELECT CASE WHEN m.text <> '' THEN m.text WHEN m.type = 'image' THEN '📷 Photo' WHEN m.type = 'audio' THEN '🎤 Voice message' ELSE '📎 File' END
                   FROM widget_messages m WHERE m.widget_conversation_id = wc.id ORDER BY m.id DESC LIMIT 1) AS last_text
           FROM widget_conversations wc JOIN chat_widgets cw ON cw.id = wc.chat_widget_id
          WHERE ${base} AND ${tabCond}
          ORDER BY wc.last_message_at DESC, wc.id DESC LIMIT ${perPage + 1} OFFSET ${offset}`,
        params,
      ),
      this.db.query<{ all: string; closed: string; unread: string; read: string }>(
        `SELECT COUNT(*) AS \`all\`, COALESCE(SUM(${CLOSED}), 0) AS closed,
                COALESCE(SUM(NOT ${CLOSED} AND ${UNREAD}), 0) AS unread,
                COALESCE(SUM(NOT ${CLOSED} AND NOT ${UNREAD}), 0) AS \`read\`
           FROM widget_conversations wc WHERE ${base}`,
        params,
      ),
    ]);

    const hasMore = rows.length > perPage;
    const data = rows.slice(0, perPage).map(r => ({
      ...r, is_unread: !!r.is_unread, ai_active: !!r.ai_active,
      last_message_at: toIso(r.last_message_at), live_requested_at: toIso(r.live_requested_at), callback_confirmed_at: toIso(r.callback_confirmed_at),
      widget: { id: r.chat_widget_id, name: r.widget_name },
    }));
    const c = counts[0];
    return { data, page, per_page: perPage, has_more: hasMore, counts: { all: Number(c.all), unread: Number(c.unread), read: Number(c.read), closed: Number(c.closed) } };
  }

  /** Conversation + its messages after `after` (or the latest `limit` when after=0). Opening a chat marks it read. */
  async show(staff: StaffIdentity, id: number, after: number, markRead = true) {
    const convo = await this.find(staff, id);
    let rows: MessageRow[];
    if (after > 0) {
      rows = await this.db.query<MessageRow>(`SELECT ${MESSAGE_COLS} FROM widget_messages WHERE widget_conversation_id = ? AND id > ? ORDER BY id ASC LIMIT 500`, [id, after]);
    } else {
      rows = (await this.db.query<MessageRow>(`SELECT ${MESSAGE_COLS} FROM widget_messages WHERE widget_conversation_id = ? ORDER BY id DESC LIMIT 200`, [id])).reverse();
    }
    if (markRead) await this.db.execute(`UPDATE widget_conversations SET staff_read_at = ? WHERE id = ?`, [nowLocal(), id]);
    return { conversation: convo, messages: await this.format(rows) };
  }

  /** Older messages for "scroll up" — `before` is the oldest message id currently shown. */
  async older(staff: StaffIdentity, id: number, before: number, limit: number) {
    await this.find(staff, id);
    const n = int(limit, 50, 1, 100);
    const rows = (await this.db.query<MessageRow>(`SELECT ${MESSAGE_COLS} FROM widget_messages WHERE widget_conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ${n + 1}`, [id, before]));
    return { messages: await this.format(rows.slice(0, n).reverse()), has_more: rows.length > n };
  }

  async me(staff: StaffIdentity) {
    const [m, h, l] = await Promise.all([
      this.db.query<{ muted: number }>(`SELECT muted FROM widget_chat_staff WHERE user_id = ? LIMIT 1`, [staff.id]),
      this.db.query<{ c: number }>(`SELECT COUNT(*) AS c FROM widget_conversations WHERE assigned_user_id = ? AND live_status = 'live'`, [staff.id]),
      this.db.query<{ l: number | null }>(`SELECT MAX(live_max_per_staff) AS l FROM chat_widgets WHERE company_id = ?`, [staff.companyId]),
    ]);
    return { muted: !!m[0]?.muted, handling: Number(h[0].c), limit: Number(l[0].l) || 5 };
  }

  async setMuted(staff: StaffIdentity, muted: boolean) {
    const now = nowLocal();
    await this.db.execute(
      `INSERT INTO widget_chat_staff (company_id, user_id, muted, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE muted = VALUES(muted), company_id = VALUES(company_id), updated_at = VALUES(updated_at)`,
      [staff.companyId, staff.id, muted ? 1 : 0, now, now],
    );
    return { muted };
  }

  // ── writes ───────────────────────────────────────────────────────────────
  async markRead(staff: StaffIdentity, id: number) {
    await this.find(staff, id);
    await this.db.execute(`UPDATE widget_conversations SET staff_read_at = ? WHERE id = ?`, [nowLocal(), id]);
    await this.changed(staff, id, 'read');
    return { read: true };
  }

  async accept(staff: StaffIdentity, id: number) {
    const convo = await this.find(staff, id);
    const me = await this.me(staff);
    const [lim] = await this.db.query<{ l: number | null }>(`SELECT live_max_per_staff AS l FROM chat_widgets WHERE id = ?`, [convo.chat_widget_id]);
    const limit = Math.max(1, Number(lim?.l) || 5);
    if (me.handling >= limit) throw new ConflictException(`You are already handling ${limit} chats — end one before accepting another.`);

    const now = nowLocal();
    // Atomic: only one staff member can win a waiting / missed request.
    const won = await this.db.run(
      `UPDATE widget_conversations SET live_status = 'live', ai_active = 0, live_accepted_at = ?, assigned_user_id = ?, staff_name = ?,
              case_status = 'attended', attended_by = ?, attended_at = ?, updated_at = ?
        WHERE id = ? AND company_id = ? AND live_status IN ('waiting', 'missed')`,
      [now, staff.id, staff.name, staff.id, now, now, id, staff.companyId],
    );
    if (!won.affectedRows) {
      throw new ConflictException(convo.live_status === 'live' ? 'Another staff member already accepted this chat.' : 'This chat is no longer waiting.');
    }
    const msg = await this.addMessage(id, 'system', `${staff.name} joined the chat.`);
    await this.changed(staff, id, 'accepted', (await this.format([msg]))[0], true);
    return this.show(staff, id, 0);
  }

  async reply(staff: StaffIdentity, id: number, text: string, replyToId?: number | null) {
    const t = (text ?? '').trim();
    if (!t) throw new BadRequestException('Message is empty');
    if (t.length > 2000) throw new BadRequestException('Message is too long (max 2000 characters)');
    const convo = await this.find(staff, id);
    if (convo.live_status !== 'live' || Number(convo.assigned_user_id) !== staff.id) throw new ForbiddenException('Accept the chat first.');

    let replyTo: number | null = null;
    if (replyToId) {
      const r = await this.db.query<{ id: number }>(`SELECT id FROM widget_messages WHERE id = ? AND widget_conversation_id = ?`, [replyToId, id]);
      replyTo = r[0]?.id ?? null;
    }
    const msg = await this.addMessage(id, 'staff', t, { replyToId: replyTo });
    await this.db.execute(`UPDATE widget_conversations SET last_message_at = ?, staff_read_at = ? WHERE id = ?`, [msg.created_at, msg.created_at, id]);
    const formatted = (await this.format([msg]))[0];
    await this.changed(staff, id, 'message', formatted, true);
    return { message: formatted };
  }

  async end(staff: StaffIdentity, id: number) {
    await this.find(staff, id);
    const now = nowLocal();
    await this.db.execute(
      `UPDATE widget_conversations SET live_status = 'ended', status = 'closed', case_status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND company_id = ?`,
      [now, now, id, staff.companyId],
    );
    const msg = await this.addMessage(id, 'system', 'This conversation is now closed. Thank you!');
    await this.changed(staff, id, 'ended', (await this.format([msg]))[0], true);
    return { ended: true };
  }
}
