import type { Queryable } from '../db/pool.js';
import type { GoogleProfile } from './google.js';

export interface UserRow {
  id: string;
  google_sub: string | null;
  email: string | null;
  name: string;
  avatar_url: string | null;
  role: 'player' | 'admin';
  status: 'active' | 'blocked';
}

/** Cria ou atualiza o usuário a partir do perfil Google e vincula automaticamente contas do jogo com o mesmo Google ID. */
export async function upsertGoogleUser(db: Queryable, profile: GoogleProfile, adminEmails: string[]): Promise<UserRow> {
  const promote = profile.emailVerified && profile.email !== null && adminEmails.includes(profile.email.toLowerCase());
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (google_sub, email, name, avatar_url, role, last_login_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (google_sub) DO UPDATE SET
       email = EXCLUDED.email,
       name = EXCLUDED.name,
       avatar_url = EXCLUDED.avatar_url,
       role = CASE WHEN $6 THEN 'admin' ELSE users.role END,
       last_login_at = now(),
       updated_at = now()
     RETURNING id, google_sub, email, name, avatar_url, role, status`,
    [profile.sub, profile.email, profile.name, profile.picture, promote ? 'admin' : 'player', promote],
  );
  const user = rows[0]!;
  await db.query(
    `UPDATE game_accounts SET user_id = $1, linked_at = now(), updated_at = now()
     WHERE google_sub = $2 AND user_id IS NULL`,
    [user.id, profile.sub],
  );
  return user;
}
