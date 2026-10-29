import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

export interface StaffIdentity {
  id: number;
  companyId: number;
  name: string;
}

/**
 * Authenticates staff by the SAME Laravel JWT the web/mobile apps already hold (verified locally with the shared
 * JWT_SECRET, like the /staff socket). Permissions are NOT re-implemented here — Laravel computes them from roles +
 * access sections, so Node asks Laravel once (cached 60 s) via /internal/staff-can. One source of truth.
 */
@Injectable()
export class StaffAuthService {
  private readonly cache = new Map<string, { at: number; value: StaffIdentity | null }>();
  private static readonly TTL_MS = 60_000;

  verifyToken(token: string | undefined): number {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new UnauthorizedException('Server auth is not configured');
    if (!token) throw new UnauthorizedException('Token required');
    try {
      const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      const id = parseInt(payload.sub ?? '', 10);
      if (!id || Number.isNaN(id)) throw new Error('no sub');
      return id;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  async authorize(token: string | undefined, permission: string): Promise<StaffIdentity> {
    const userId = this.verifyToken(token);
    const key = `${userId}:${permission}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < StaffAuthService.TTL_MS) {
      if (!hit.value) throw new ForbiddenException('No access to website chats');
      return hit.value;
    }

    const base = (process.env.LARAVEL_INTERNAL_URL || process.env.LARAVEL_URL || 'http://localhost:8000').replace(/\/$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}/api/v1/internal/staff-can`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY ?? '' },
        body: JSON.stringify({ user_id: userId, permission }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // Laravel unreachable: serve a recent (even stale) grant rather than locking every agent out mid-chat.
      if (hit?.value) return hit.value;
      throw new UnauthorizedException('Could not verify access');
    }
    if (!res.ok) throw new UnauthorizedException('Could not verify access');
    const body = (await res.json()) as { can: boolean; company_id: number | null; name: string | null };
    const value = body.can && body.company_id ? { id: userId, companyId: body.company_id, name: body.name ?? 'Staff' } : null;
    this.cache.set(key, { at: Date.now(), value });
    if (this.cache.size > 5000) this.cache.clear();
    if (!value) throw new ForbiddenException('No access to website chats');
    return value;
  }
}
