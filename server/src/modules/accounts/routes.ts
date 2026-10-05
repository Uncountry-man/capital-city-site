import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { SESSION_COOKIE, requireUser, sessionCookieOptions } from '../../auth/plugin.js';
import { createSession, destroySession } from '../../auth/sessions.js';
import { upsertGoogleUser, type UserRow } from '../../auth/users.js';
import { withTransaction } from '../../db/pool.js';
import { conflict, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { randomCode, safeEqual, sha256 } from '../../lib/security.js';
import { parse } from '../../lib/validate.js';

const LINK_CODE_TTL_MINUTES = 15;

function userView(user: UserRow) {
  return { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatar_url, role: user.role };
}

export async function listGameAccounts(ctx: AppContext, userId: string) {
  const { rows } = await ctx.db.query<{ id: string; nickname: string; server_account_id: string; linked_at: Date | null }>(
    'SELECT id, nickname, server_account_id, linked_at FROM game_accounts WHERE user_id = $1 ORDER BY linked_at NULLS LAST, nickname',
    [userId],
  );
  return rows.map((r) => ({ id: r.id, nickname: r.nickname, serverAccountId: r.server_account_id, linkedAt: r.linked_at }));
}

export function accountRoutes(app: FastifyInstance, ctx: AppContext): void {
  const authLimit = { rateLimit: { max: 15, timeWindow: '1 minute' } };

  app.get('/api/auth/config', async () => ({
    googleClientId: ctx.config.googleClientIds[0] ?? null,
    loginUri: `${ctx.config.publicBaseUrl}/api/auth/google/redirect`,
    devLogin: ctx.config.devLogin,
  }));

  async function startSession(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply, user: UserRow) {
    if (user.status !== 'active') throw forbidden('Conta bloqueada. Fale com a equipe no Discord.');
    const session = await createSession(ctx.db, user.id, ctx.config.sessionTtlDays, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(ctx, session.expiresAt));
    return session;
  }

  // Login via JSON (launcher/app nativo ou botão do Google no navegador).
  // Com mode="token" o token de sessão é devolvido para uso como "Authorization: Bearer" no launcher.
  app.post('/api/auth/google', { config: authLimit }, async (req, reply) => {
    const body = parse(z.object({ credential: z.string().min(20).max(5000), mode: z.enum(['cookie', 'token']).default('cookie') }), req.body);
    const profile = await ctx.verifyGoogleToken(body.credential);
    const user = await upsertGoogleUser(ctx.db, profile, ctx.config.adminEmails);
    const session = await startSession(req, reply, user);
    return { user: userView(user), ...(body.mode === 'token' ? { token: session.token, expiresAt: session.expiresAt } : {}) };
  });

  // Login do Google Identity Services em modo redirect (sem popup, melhor para WebView).
  // Proteção CSRF do próprio Google: o cookie g_csrf_token precisa ser igual ao campo enviado no formulário.
  app.post('/api/auth/google/redirect', { config: authLimit }, async (req, reply) => {
    const body = parse(z.object({ credential: z.string().min(20).max(5000), g_csrf_token: z.string().min(1).max(200) }), req.body);
    const cookieToken = req.cookies.g_csrf_token;
    if (!cookieToken || !safeEqual(cookieToken, body.g_csrf_token)) throw unauthorized('Falha na verificação de segurança do login.');
    const profile = await ctx.verifyGoogleToken(body.credential);
    const user = await upsertGoogleUser(ctx.db, profile, ctx.config.adminEmails);
    await startSession(req, reply, user);
    const target = req.cookies.cc_return === 'admin' ? '/admin/' : '/store/#/conta';
    reply.clearCookie('cc_return', { path: '/' });
    return reply.redirect(target, 303);
  });

  // Login local para desenvolvimento/testes. Desativado automaticamente em produção.
  app.post('/api/auth/dev-login', { config: authLimit }, async (req, reply) => {
    if (!ctx.config.devLogin) throw notFound();
    const body = parse(z.object({ email: z.email(), name: z.string().min(1).max(80), admin: z.boolean().default(false) }), req.body);
    const user = await upsertGoogleUser(
      ctx.db,
      { sub: `dev:${body.email}`, email: body.email, emailVerified: true, name: body.name, picture: null },
      body.admin ? [body.email.toLowerCase()] : ctx.config.adminEmails,
    );
    await startSession(req, reply, user);
    return { user: userView(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : req.cookies[SESSION_COOKIE];
    if (token) await destroySession(ctx.db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!req.user) return { user: null, gameAccounts: [] };
    return { user: userView(req.user), gameAccounts: await listGameAccounts(ctx, req.user.id) };
  });

  // Gera um código para o jogador digitar no jogo (/vincular CODIGO). Guardamos apenas o hash.
  app.post('/api/me/game-accounts/link-code', { preHandler: requireUser, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const code = randomCode(8);
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60_000);
    await withTransaction(ctx.db, async (tx) => {
      await tx.query('DELETE FROM link_codes WHERE user_id = $1 AND used_at IS NULL', [req.user!.id]);
      await tx.query('INSERT INTO link_codes (code_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sha256(code), req.user!.id, expiresAt]);
    });
    return { code, expiresAt };
  });

  app.delete<{ Params: { id: string } }>('/api/me/game-accounts/:id', { preHandler: requireUser }, async (req) => {
    const id = parse(z.uuid(), req.params.id);
    const owned = await ctx.db.query('SELECT 1 FROM game_accounts WHERE id = $1 AND user_id = $2', [id, req.user!.id]);
    if (!owned.rowCount) throw notFound('Conta não encontrada.');
    const open = await ctx.db.query(
      `SELECT 1 FROM orders WHERE game_account_id = $1 AND status IN ('pending', 'processing', 'paid', 'approved') LIMIT 1`,
      [id],
    );
    if (open.rowCount) throw conflict('account_has_open_orders', 'Esta conta tem pedidos em andamento e não pode ser desvinculada agora.');
    const res = await ctx.db.query(
      'UPDATE game_accounts SET user_id = NULL, linked_at = NULL, updated_at = now() WHERE id = $1 AND user_id = $2',
      [id, req.user!.id],
    );
    if (!res.rowCount) throw notFound('Conta não encontrada.');
    return { gameAccounts: await listGameAccounts(ctx, req.user!.id) };
  });
}
