import '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { findSessionUser } from './sessions.js';
import type { UserRow } from './users.js';

export const SESSION_COOKIE = 'cc_session';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
    authVia: 'cookie' | 'bearer' | null;
  }
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Rotas autenticadas por outros mecanismos (segredo do webhook, chave do servidor do jogo, double-submit do Google).
const CSRF_EXEMPT = ['/api/webhooks/', '/api/game/', '/api/auth/google/redirect'];

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('user', null);
  app.decorateRequest('authVia', null);

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/webhooks/') || req.url.startsWith('/api/game/')) return;

    // Launcher/app: token de sessão no header. Navegador: cookie httpOnly.
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      req.user = await findSessionUser(ctx.db, header.slice(7).trim());
      req.authVia = req.user ? 'bearer' : null;
      return;
    }
    const cookie = req.cookies[SESSION_COOKIE];
    if (cookie) {
      req.user = await findSessionUser(ctx.db, cookie);
      req.authVia = req.user ? 'cookie' : null;
    }

    // Proteção CSRF: requisições que alteram estado a partir do navegador precisam vir de uma origem nossa.
    if (UNSAFE.has(req.method) && !CSRF_EXEMPT.some((p) => req.url.startsWith(p))) {
      const origin = originOf(req.headers.origin) ?? originOf(req.headers.referer);
      if (origin === null ? Boolean(cookie) : !ctx.config.allowedOrigins.includes(origin)) {
        throw forbidden('Origem da requisição não permitida.');
      }
    }
  });
}

export async function requireUser(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.user) throw unauthorized();
}

export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.user) throw unauthorized();
  if (req.user.role !== 'admin') throw forbidden('Área restrita a administradores.');
}

export function sessionCookieOptions(ctx: AppContext, expires: Date) {
  return {
    path: '/',
    httpOnly: true,
    secure: ctx.config.isProduction,
    sameSite: 'lax' as const,
    expires,
  };
}
