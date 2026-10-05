import type { Queryable } from '../db/pool.js';
import { randomToken, sha256 } from '../lib/security.js';
import type { UserRow } from './users.js';

export async function createSession(
  db: Queryable,
  userId: string,
  ttlDays: number,
  meta: { userAgent?: string; ip?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip) VALUES ($1, $2, $3, $4, $5)`,
    [sha256(token), userId, expiresAt, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null],
  );
  return { token, expiresAt };
}

export async function findSessionUser(db: Queryable, token: string): Promise<UserRow | null> {
  if (!token || token.length > 200) return null;
  const { rows } = await db.query<UserRow>(
    `SELECT u.id, u.google_sub, u.email, u.name, u.avatar_url, u.role, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

export async function destroySession(db: Queryable, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}
