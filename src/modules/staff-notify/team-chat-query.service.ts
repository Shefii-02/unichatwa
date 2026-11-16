import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { MysqlService } from '../wa-chat/mysql.service';
import { nowLocal, toIso } from '../widget-chat/time.util';
import { TeamChatService } from './team-chat.service';

export interface TeamUser {
  id: number;
  companyId: number;
  name: string;
}

type Row = Record<string, any>;
const NOW = (): string => `'${nowLocal()}'`;
const DT = (col: string, alias: string): string => `DATE_FORMAT(${col}, '%Y-%m-%d %H:%i:%s') AS ${alias}`;
const int = (v: unknown, d: number, min: number, max: number): number => Math.min(Math.max(Number.parseInt(String(v ?? ''), 10) || d, min), max);

/**
 * Read side of team chat served by Node: chat list (paged, search, tab filters, unread counts), chat info, message
 * history (before / after / around / search), user list and chat creation. Same paths and JSON shapes as Laravel's
 * `/team-chat/*`, so web and Flutter only switch base URL; writes that need Laravel storage (file uploads, group admin)
 * stay on Laravel. Times are read through the Laravel-app-timezone helper so both servers agree.
 */
@Injectable()
export class TeamChatQueryService {
  constructor(
    private readonly db: MysqlService,
    private readonly chat: TeamChatService,
  ) {}

  private async member(chatId: number, u: TeamUser): Promise<Row> {
    const r = await this.db.query<Row>(
      `SELECT m.*, c.type, c.name AS chat_name, c.avatar_url, c.only_admins_post, c.only_admins_edit, c.only_admins_add, c.created_by
         FROM team_chat_members m JOIN team_chats c ON c.id = m.chat_id
        WHERE m.chat_id = ? AND m.user_id = ? AND m.left_at IS NULL AND c.company_id = ? LIMIT 1`,
      [chatId, u.id, u.companyId],
    );
    if (!r.length) throw new ForbiddenException('You are not a member of this chat.');
    return r[0];
  }

  private mutedNow(row: Row): boolean {
    if (!row.muted) return false;
    if (!row.muted_until) return true;
    return new Date(row.muted_until).getTime() > Date.now();
  }

  private preview(m: Row): string {
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

  // ── people ────────────────────────────────────────────────────────────────

  async users(u: TeamUser) {
    const rows = await this.db.query<Row>(
      'SELECT id, name, avatar, department FROM users WHERE company_id = ? AND is_active = 1 AND id <> ? ORDER BY name',
      [u.companyId, u.id],
    );
    return { data: rows };
  }

  // ── chat list ─────────────────────────────────────────────────────────────

  async chats(u: TeamUser, q: Record<string, string>) {
    const perPage = int(q.per_page, 30, 5, 100);
    const page = int(q.page, 1, 1, 100000);
    const where: string[] = ['m.user_id = ?', 'm.left_at IS NULL', 'c.company_id = ?'];
    const params: (string | number)[] = [u.id, u.companyId];
    if (q.type === 'direct' || q.type === 'group') { where.push('c.type = ?'); params.push(q.type); }
    const term = (q.q ?? '').trim();
    if (term) {
      const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
      where.push(`(c.name LIKE ? OR EXISTS (SELECT 1 FROM team_chat_members om JOIN users ou ON ou.id = om.user_id
                    WHERE om.chat_id = c.id AND om.user_id <> ? AND c.type = 'direct' AND ou.name LIKE ?))`);
      params.push(like, u.id, like);
    }
    if (q.filter === 'unread') {
      where.push(`EXISTS (SELECT 1 FROM team_chat_messages um WHERE um.chat_id = c.id AND um.deleted_at IS NULL
                    AND um.id > m.last_read_message_id AND (um.sender_id IS NULL OR um.sender_id <> ?))`);
      params.push(u.id);
    }

    const fetched = await this.db.query<Row>(
      `SELECT c.*, ${DT('c.last_message_at', 'last_message_at_s')}, m.last_read_message_id, m.muted, m.muted_until, m.role AS my_role
         FROM team_chat_members m JOIN team_chats c ON c.id = m.chat_id
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
        LIMIT ${perPage + 1} OFFSET ${(page - 1) * perPage}`,
      params,
    );
    const hasMore = fetched.length > perPage;
    const rows = fetched.slice(0, perPage);
    const ids = rows.map((r) => Number(r.id));

    // Unread per chat across ALL my chats (tab badges + the nav badge) in one pass.
    const unreadAll = await this.db.query<Row>(
      `SELECT c.id, c.type, m.muted, m.muted_until, COUNT(*) AS n,
              SUM(JSON_CONTAINS(msg.mentions, CAST(? AS JSON))) AS mentions
         FROM team_chat_messages msg
         JOIN team_chat_members m ON m.chat_id = msg.chat_id AND m.user_id = ? AND m.left_at IS NULL
         JOIN team_chats c ON c.id = msg.chat_id
        WHERE c.company_id = ? AND msg.deleted_at IS NULL AND msg.id > m.last_read_message_id
          AND (msg.sender_id IS NULL OR msg.sender_id <> ?)
        GROUP BY c.id, c.type, m.muted, m.muted_until`,
      [String(u.id), u.id, u.companyId, u.id],
    );
    const unread = new Map<number, number>();
    const mentionUnread = new Map<number, number>();
    let unreadTotal = 0, directUnread = 0, groupUnread = 0, mentionsTotal = 0;
    for (const r of unreadAll) {
      unread.set(Number(r.id), Number(r.n));
      mentionUnread.set(Number(r.id), Number(r.mentions ?? 0));
      mentionsTotal += Number(r.mentions ?? 0);
      if (r.type === 'direct') directUnread++; else groupUnread++;
      if (!this.mutedNow(r)) unreadTotal += Number(r.n);
    }

    const lastIds = rows.map((r) => r.last_message_id).filter(Boolean).map(Number);
    const last = new Map<number, Row>();
    const lastSender = new Map<number, string>();
    if (lastIds.length) {
      const lm = await this.db.query<Row>(`SELECT * FROM team_chat_messages WHERE id IN (${lastIds.map(() => '?').join(',')})`, lastIds);
      lm.forEach((x) => last.set(Number(x.id), x));
      const sids = [...new Set(lm.map((x) => x.sender_id).filter(Boolean).map(Number))];
      if (sids.length) {
        (await this.db.query<Row>(`SELECT id, name FROM users WHERE id IN (${sids.map(() => '?').join(',')})`, sids)).forEach((x) => lastSender.set(Number(x.id), x.name));
      }
    }
    const counts = new Map<number, number>();
    const others = new Map<number, Row>();
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      (await this.db.query<Row>(`SELECT chat_id, COUNT(*) AS c FROM team_chat_members WHERE chat_id IN (${ph}) AND left_at IS NULL GROUP BY chat_id`, ids))
        .forEach((x) => counts.set(Number(x.chat_id), Number(x.c)));
      const directIds = rows.filter((r) => r.type === 'direct').map((r) => Number(r.id));
      if (directIds.length) {
        (await this.db.query<Row>(
          `SELECT m.chat_id, u.id AS uid, u.name, u.avatar FROM team_chat_members m JOIN users u ON u.id = m.user_id
            WHERE m.chat_id IN (${directIds.map(() => '?').join(',')}) AND m.user_id <> ?`, [...directIds, u.id],
        )).forEach((x) => others.set(Number(x.chat_id), x));
      }
    }

    const data = rows.map((c) => {
      const id = Number(c.id);
      const o = others.get(id);
      const l = c.last_message_id ? last.get(Number(c.last_message_id)) : undefined;
      const direct = c.type === 'direct';
      return {
        id, type: c.type,
        name: direct ? (o?.name ?? 'Chat') : c.name,
        avatar: direct ? (o?.avatar ?? null) : c.avatar_url,
        other_user_id: o?.uid ?? null,
        members_count: counts.get(id) ?? 0, muted: this.mutedNow(c), muted_until: c.muted ? c.muted_until : null, my_role: c.my_role,
        unread: unread.get(id) ?? 0, unread_mentions: mentionUnread.get(id) ?? 0,
        last_sender: l?.sender_id ? (lastSender.get(Number(l.sender_id)) ?? null) : null, last_sender_id: l?.sender_id ?? null,
        last_message: l ? this.preview(l) : null, last_message_at: toIso(c.last_message_at_s),
      };
    });
    return {
      data, page, has_more: hasMore, unread_total: unreadTotal,
      counts: { unread_chats: unreadAll.length, direct_unread: directUnread, group_unread: groupUnread, mentions: mentionsTotal },
    };
  }

  // ── one chat ──────────────────────────────────────────────────────────────

  async info(u: TeamUser, chatId: number) {
    const me = await this.member(chatId, u);
    const members = await this.db.query<Row>(
      `SELECT u.id, u.name, u.avatar, m.role FROM team_chat_members m JOIN users u ON u.id = m.user_id
        WHERE m.chat_id = ? AND m.left_at IS NULL ORDER BY (m.role = 'admin') DESC, u.name`, [chatId]);
    const former = me.role === 'admin'
      ? await this.db.query<Row>(
          `SELECT u.id, u.name, u.avatar, ${DT('m.left_at', 'left_at')} FROM team_chat_members m JOIN users u ON u.id = m.user_id
            WHERE m.chat_id = ? AND m.left_at IS NOT NULL ORDER BY m.left_at DESC`, [chatId])
      : [];
    return {
      id: chatId, type: me.type, name: me.chat_name, avatar: me.avatar_url,
      only_admins_post: !!me.only_admins_post, only_admins_edit: !!me.only_admins_edit, only_admins_add: !!me.only_admins_add,
      my_role: me.role, muted: this.mutedNow(me), muted_until: me.muted ? me.muted_until : null,
      created_by: me.created_by, members,
      former_members: former.map((f) => ({ ...f, left_at: toIso(f.left_at) })),
    };
  }

  // ── messages ──────────────────────────────────────────────────────────────

  async messages(u: TeamUser, chatId: number, q: Record<string, string>) {
    await this.member(chatId, u);
    const limit = int(q.limit, 40, 1, 100);
    const sel = `SELECT m.*, ${DT('m.created_at', 'created_at_s')} FROM team_chat_messages m
                  WHERE m.chat_id = ? AND NOT EXISTS (SELECT 1 FROM team_chat_hides h WHERE h.message_id = m.id AND h.user_id = ?)`;
    const base: (string | number)[] = [chatId, u.id];
    let rows: Row[];
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`;
      rows = (await this.db.query<Row>(`${sel} AND m.deleted_at IS NULL AND m.body LIKE ? ORDER BY m.id DESC LIMIT ${limit}`, [...base, like])).reverse();
    } else if (q.around_id) {
      const mid = int(q.around_id, 0, 0, Number.MAX_SAFE_INTEGER);
      const before = (await this.db.query<Row>(`${sel} AND m.id <= ? ORDER BY m.id DESC LIMIT 25`, [...base, mid])).reverse();
      const after = await this.db.query<Row>(`${sel} AND m.id > ? ORDER BY m.id ASC LIMIT 25`, [...base, mid]);
      rows = [...before, ...after];
    } else if (q.after_id) {
      rows = await this.db.query<Row>(`${sel} AND m.id > ? ORDER BY m.id ASC LIMIT 200`, [...base, int(q.after_id, 0, 0, Number.MAX_SAFE_INTEGER)]);
    } else {
      const extra = q.before_id ? ` AND m.id < ${int(q.before_id, 0, 0, Number.MAX_SAFE_INTEGER)}` : '';
      rows = (await this.db.query<Row>(`${sel}${extra} ORDER BY m.id DESC LIMIT ${limit}`, base)).reverse();
    }
    return { data: await this.formatBatch(rows, chatId, u.id) };
  }

  /** Many messages for one viewer with a fixed number of queries (not per message). */
  private async formatBatch(rows: Row[], chatId: number, viewer: number): Promise<Row[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => Number(r.id));
    const ph = (a: unknown[]) => a.map(() => '?').join(',');
    const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter(Boolean).map(Number))];
    const [reacts, stars, pins, members, replies] = await Promise.all([
      this.db.query<Row>(`SELECT message_id, emoji, user_id FROM team_chat_reactions WHERE message_id IN (${ph(ids)})`, ids),
      this.db.query<Row>(`SELECT message_id FROM team_chat_stars WHERE user_id = ? AND message_id IN (${ph(ids)})`, [viewer, ...ids]),
      this.db.query<Row>(`SELECT message_id FROM team_chat_pins WHERE chat_id = ? AND message_id IN (${ph(ids)})`, [chatId, ...ids]),
      this.db.query<Row>('SELECT user_id, last_read_message_id AS r, last_delivered_message_id AS d FROM team_chat_members WHERE chat_id = ? AND left_at IS NULL', [chatId]),
      replyIds.length ? this.db.query<Row>(`SELECT * FROM team_chat_messages WHERE id IN (${ph(replyIds)})`, replyIds) : Promise.resolve([] as Row[]),
    ]);
    const replyBy = new Map(replies.map((r) => [Number(r.id), r]));
    const nameIds = [...new Set([...rows.map((r) => r.sender_id), ...replies.map((r) => r.sender_id), ...rows.map((r) => r.deleted_by)].filter(Boolean).map(Number))];
    const names = new Map<number, string>();
    if (nameIds.length) (await this.db.query<Row>(`SELECT id, name FROM users WHERE id IN (${ph(nameIds)})`, nameIds)).forEach((x) => names.set(Number(x.id), x.name));

    const reactBy = new Map<number, Row[]>();
    reacts.forEach((r) => reactBy.set(Number(r.message_id), [...(reactBy.get(Number(r.message_id)) ?? []), r]));
    const starred = new Set(stars.map((s) => Number(s.message_id)));
    const pinned = new Set(pins.map((p) => Number(p.message_id)));

    return rows.map((m) => {
      const id = Number(m.id);
      const others = members.filter((x) => Number(x.user_id) !== Number(m.sender_id ?? 0));
      const seen = others.filter((x) => Number(x.r) >= id).length;
      const delivered = others.filter((x) => Math.max(Number(x.d), Number(x.r)) >= id).length;
      const rep = m.reply_to_id ? replyBy.get(Number(m.reply_to_id)) : undefined;
      const grouped = new Map<string, { count: number; mine: boolean }>();
      (reactBy.get(id) ?? []).forEach((r) => {
        const g = grouped.get(r.emoji) ?? { count: 0, mine: false };
        g.count++;
        if (Number(r.user_id) === viewer) g.mine = true;
        grouped.set(r.emoji, g);
      });
      const deleted = !!m.deleted_at;
      return {
        id, type: m.type, sender_id: m.sender_id, sender_name: m.sender_id ? (names.get(Number(m.sender_id)) ?? '') : null,
        mine: Number(m.sender_id) === viewer,
        body: deleted ? null : m.body, deleted, edited: !!m.edited_at,
        deleted_by_name: deleted && Number(m.sender_id) === viewer && m.deleted_by ? (names.get(Number(m.deleted_by)) ?? null) : null,
        attachment_url: deleted ? null : m.attachment_url, attachment_name: m.attachment_name, attachment_size: m.attachment_size,
        attachment_mime: m.attachment_mime, duration: m.duration_seconds, forwarded: !!m.forwarded,
        latitude: m.latitude !== null ? Number(m.latitude) : null, longitude: m.longitude !== null ? Number(m.longitude) : null,
        location_label: m.location_label, contact_name: m.contact_name, contact_phone: m.contact_phone,
        mentions: m.mentions ? (typeof m.mentions === 'string' ? JSON.parse(m.mentions) : m.mentions) : [],
        reply_to: rep ? { id: Number(rep.id), sender_name: rep.sender_id ? (names.get(Number(rep.sender_id)) ?? null) : null, preview: this.preview(rep), type: rep.type, thumb: rep.type === 'image' && !rep.deleted_at ? rep.attachment_url : null } : null,
        reactions: [...grouped.entries()].map(([emoji, g]) => ({ emoji, count: g.count, mine: g.mine })),
        starred: starred.has(id), pinned: pinned.has(id),
        seen_by_count: seen, delivered_count: delivered, recipients: others.length,
        created_at: toIso(m.created_at_s),
      };
    });
  }

  // ── create chat ───────────────────────────────────────────────────────────

  async create(u: TeamUser, body: { type?: string; user_id?: number; name?: string; member_ids?: number[] }) {
    const valid = async (ids: number[]): Promise<number[]> => {
      const clean = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      if (!clean.length) return [];
      const r = await this.db.query<Row>(`SELECT id FROM users WHERE company_id = ? AND is_active = 1 AND id IN (${clean.map(() => '?').join(',')})`, [u.companyId, ...clean]);
      return r.map((x) => Number(x.id));
    };

    if (body.type === 'direct') {
      const other = Number(body.user_id);
      if (!other || other === u.id || !(await valid([other])).length) throw new BadRequestException('Pick a team member.');
      const key = `${Math.min(u.id, other)}:${Math.max(u.id, other)}`;
      const ex = await this.db.query<Row>('SELECT id FROM team_chats WHERE company_id = ? AND direct_key = ? LIMIT 1', [u.companyId, key]);
      if (ex.length) {
        await this.db.execute('UPDATE team_chat_members SET left_at = NULL WHERE chat_id = ?', [ex[0].id]);
        return { id: Number(ex[0].id) };
      }
      const res = await this.db.run(
        `INSERT INTO team_chats (company_id, type, direct_key, created_by, created_at, updated_at) VALUES (?, 'direct', ?, ?, ${NOW()}, ${NOW()})`, [u.companyId, key, u.id]);
      for (const uid of [u.id, other]) {
        await this.db.execute(`INSERT INTO team_chat_members (chat_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'member', ${NOW()}, ${NOW()}, ${NOW()})`, [res.insertId, uid]);
      }
      return { id: res.insertId };
    }

    if (body.type === 'group') {
      const name = String(body.name ?? '').trim().slice(0, 80);
      if (!name) throw new BadRequestException('Give the group a name.');
      const members = (await valid(body.member_ids ?? [])).filter((x) => x !== u.id);
      if (!members.length) throw new BadRequestException('Add at least one member.');
      const res = await this.db.run(
        `INSERT INTO team_chats (company_id, type, name, created_by, created_at, updated_at) VALUES (?, 'group', ?, ?, ${NOW()}, ${NOW()})`, [u.companyId, name, u.id]);
      await this.db.execute(`INSERT INTO team_chat_members (chat_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'admin', ${NOW()}, ${NOW()}, ${NOW()})`, [res.insertId, u.id]);
      for (const uid of members) {
        await this.db.execute(`INSERT INTO team_chat_members (chat_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'member', ${NOW()}, ${NOW()}, ${NOW()})`, [res.insertId, uid]);
      }
      await this.chat.systemMessage(res.insertId, u.companyId, u.id, `${u.name} created the group "${name}"`);
      return { id: res.insertId };
    }
    throw new BadRequestException('type must be direct or group');
  }
}
