import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { withTransaction } from '../../db/pool.js';
import { badRequest, conflict, forbidden, unauthorized } from '../../lib/errors.js';
import { ipAllowed, safeEqual, sha256 } from '../../lib/security.js';
import { parse } from '../../lib/validate.js';
import { claimDelivery, completeDelivery, failDelivery, listPendingDeliveries, toGameDelivery } from './service.js';

/**
 * API consumida pelo servidor SA-MP (ou por um serviço ponte). A loja não fala com o jogo diretamente:
 * o servidor busca as entregas pendentes, aplica o benefício e confirma a conclusão.
 *
 * Autenticação: header "X-Game-Api-Key" (GAME_API_KEY) + lista opcional de IPs (GAME_API_ALLOWED_IPS).
 */
export function gameRoutes(app: FastifyInstance, ctx: AppContext): void {
  const authenticate = async (req: FastifyRequest) => {
    const key = req.headers['x-game-api-key'];
    if (!ctx.config.game.apiKey || typeof key !== 'string' || !safeEqual(key, ctx.config.game.apiKey)) {
      throw unauthorized('Chave da API do jogo inválida.');
    }
    if (!ipAllowed(req.ip, ctx.config.game.allowedIps)) throw forbidden('IP não autorizado.');
  };
  const opts = { preHandler: authenticate, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } };
  const accountId = z.string().trim().min(1).max(64);
  const nickname = z.string().trim().min(1).max(32);

  /** Informa/atualiza uma conta do jogo. Com googleSub, o vínculo com o site acontece automaticamente. */
  app.post('/api/game/accounts/sync', opts, async (req) => {
    const body = parse(z.object({ serverAccountId: accountId, nickname, googleSub: z.string().trim().min(1).max(255).optional() }), req.body);
    const { rows } = await ctx.db.query<{ id: string; user_id: string | null }>(
      `INSERT INTO game_accounts (server_account_id, nickname, google_sub, user_id, linked_at)
       VALUES ($1, $2, $3::text, (SELECT id FROM users WHERE google_sub = $3::text), CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (server_account_id) DO UPDATE SET
         nickname = EXCLUDED.nickname,
         google_sub = COALESCE(EXCLUDED.google_sub, game_accounts.google_sub),
         user_id = COALESCE(game_accounts.user_id, EXCLUDED.user_id),
         linked_at = COALESCE(game_accounts.linked_at, CASE WHEN EXCLUDED.user_id IS NULL THEN NULL ELSE now() END),
         updated_at = now()
       RETURNING id, user_id`,
      [body.serverAccountId, body.nickname, body.googleSub ?? null],
    );
    return { gameAccountId: rows[0]!.id, linked: rows[0]!.user_id !== null };
  });

  /** Conclui o vínculo quando o jogador digita no jogo o código gerado no site. */
  app.post('/api/game/accounts/link', opts, async (req) => {
    const body = parse(z.object({ code: z.string().trim().min(6).max(16), serverAccountId: accountId, nickname }), req.body);
    return withTransaction(ctx.db, async (tx) => {
      const { rows } = await tx.query<{ user_id: string }>(
        `UPDATE link_codes SET used_at = now()
          WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
          RETURNING user_id`,
        [sha256(body.code.toUpperCase())],
      );
      const userId = rows[0]?.user_id;
      if (!userId) throw badRequest('invalid_link_code', 'Código inválido ou expirado.');
      const existing = await tx.query<{ user_id: string | null }>(
        'SELECT user_id FROM game_accounts WHERE server_account_id = $1 FOR UPDATE',
        [body.serverAccountId],
      );
      const owner = existing.rows[0]?.user_id;
      if (owner && owner !== userId) throw conflict('account_already_linked', 'Esta conta do jogo já está vinculada a outro login.');
      const res = await tx.query<{ id: string }>(
        `INSERT INTO game_accounts (server_account_id, nickname, user_id, linked_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (server_account_id) DO UPDATE SET nickname = EXCLUDED.nickname, user_id = EXCLUDED.user_id,
           linked_at = COALESCE(game_accounts.linked_at, now()), updated_at = now()
         RETURNING id`,
        [body.serverAccountId, body.nickname, userId],
      );
      return { gameAccountId: res.rows[0]!.id, linked: true };
    });
  });

  app.get('/api/game/deliveries', opts, async (req) => {
    const q = parse(
      z.object({ serverAccountId: accountId.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      req.query,
    );
    const rows = await listPendingDeliveries(ctx.db, { serverAccountId: q.serverAccountId, limit: q.limit });
    return { deliveries: rows.map(toGameDelivery) };
  });

  app.post<{ Params: { id: string } }>('/api/game/deliveries/:id/claim', opts, async (req, reply) => {
    const id = parse(z.uuid(), req.params.id);
    const delivery = await claimDelivery(ctx, id);
    if (!delivery) {
      reply.code(409);
      return { claimed: false, error: { code: 'already_claimed', message: 'Entrega já está sendo processada ou foi concluída.' } };
    }
    return { claimed: true, delivery: toGameDelivery(delivery) };
  });

  app.post<{ Params: { id: string } }>('/api/game/deliveries/:id/complete', opts, async (req) => {
    const id = parse(z.uuid(), req.params.id);
    const body = parse(z.object({ note: z.string().max(300).optional() }).default({}), req.body ?? {});
    const { delivery, alreadyDelivered } = await completeDelivery(ctx, id, {
      source: 'game',
      data: body.note ? { note: body.note } : {},
    });
    return { delivered: true, alreadyDelivered, delivery: toGameDelivery(delivery) };
  });

  app.post<{ Params: { id: string } }>('/api/game/deliveries/:id/fail', opts, async (req) => {
    const id = parse(z.uuid(), req.params.id);
    const body = parse(z.object({ reason: z.string().trim().min(1).max(500), retry: z.boolean().default(false) }), req.body);
    const delivery = await failDelivery(ctx, id, body.reason, body.retry, { source: 'game' });
    return { delivery: toGameDelivery(delivery) };
  });
}
