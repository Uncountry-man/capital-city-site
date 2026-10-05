import type { AppContext } from '../../context.js';
import { withTransaction, type DbClient, type Queryable } from '../../db/pool.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { createDeliveriesForOrder } from '../deliveries/service.js';
import { closeUnpaidOrder, lockOrder, reserveStockAgain, type OrderRow } from '../orders/service.js';
import { addOrderEvent, transitionOrder, type EventSource } from '../orders/state.js';
import { PaymentProviderError, type ProviderTransaction } from './provider.js';

export interface PaymentRow {
  id: string;
  order_id: string;
  provider: string;
  method: string;
  status: 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled' | 'refunded';
  provider_status: string | null;
  provider_transaction_id: string | null;
  amount_cents: number;
  pix_copy_paste: string | null;
  expires_at: Date;
  paid_at: Date | null;
  last_checked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Intervalo mínimo entre consultas ao gateway disparadas pelo polling do jogador. */
const RECHECK_INTERVAL_MS = 10_000;

export function webhookUrl(ctx: AppContext): string {
  return `${ctx.config.publicBaseUrl}/api/webhooks/payment?token=${encodeURIComponent(ctx.config.payment.webhookSecret)}`;
}

/**
 * Gera (ou devolve a já existente) cobrança PIX de um pedido do próprio usuário.
 * O valor cobrado é sempre o total salvo no pedido, calculado pelo servidor.
 */
export async function createPaymentForOrder(
  ctx: AppContext,
  user: { id: string; name: string; email: string | null },
  orderId: string,
): Promise<PaymentRow> {
  return withTransaction(ctx.db, async (tx) => {
    const order = await lockOrder(tx, orderId, user.id);
    if (order.status !== 'pending') {
      throw conflict('order_not_payable', 'Este pedido não está aguardando pagamento.');
    }
    if (order.expires_at.getTime() <= Date.now()) {
      throw conflict('order_expired', 'O prazo de pagamento deste pedido expirou. Faça um novo pedido.');
    }
    const existing = await tx.query<PaymentRow>(`SELECT * FROM payments WHERE order_id = $1 AND status = 'pending'`, [order.id]);
    if (existing.rows[0]) return existing.rows[0];

    const { rows } = await tx.query<PaymentRow>(
      `INSERT INTO payments (order_id, provider, amount_cents, expires_at) VALUES ($1, $2, $3, $4) RETURNING *`,
      [order.id, ctx.paymentProvider.name, order.total_cents, order.expires_at],
    );
    const payment = rows[0]!;

    let charge;
    try {
      charge = await ctx.paymentProvider.createPixCharge({
        externalId: payment.id,
        amountCents: payment.amount_cents,
        description: `Capital City - Pedido ${order.code}`,
        payer: { name: user.name || 'Jogador Capital City', email: user.email },
        postbackUrl: webhookUrl(ctx),
      });
    } catch (err) {
      ctx.log.error({ err: err instanceof PaymentProviderError ? err.message : err, orderId }, 'falha ao gerar cobrança PIX');
      throw new AppError(502, 'payment_provider_error', 'Não foi possível gerar o PIX agora. Tente novamente em instantes.');
    }

    const updated = await tx.query<PaymentRow>(
      `UPDATE payments SET provider_transaction_id = $2, pix_copy_paste = $3, provider_status = $4, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [payment.id, charge.transactionId, charge.pixCopyPaste, charge.providerStatus],
    );
    await tx.query(
      `INSERT INTO transactions (order_id, payment_id, type, amount_cents, provider_ref) VALUES ($1, $2, 'charge_created', $3, $4)`,
      [order.id, payment.id, payment.amount_cents, charge.transactionId],
    );
    await addOrderEvent(tx, order.id, 'payment_created', {
      source: 'player',
      actorUserId: user.id,
      message: 'Cobrança PIX gerada',
      data: { paymentId: payment.id, provider: ctx.paymentProvider.name, transactionId: charge.transactionId },
    });
    return updated.rows[0]!;
  });
}

export type ConfirmOutcome = 'confirmed' | 'already_paid' | 'not_paid' | 'amount_mismatch' | 'mismatch' | 'ignored';

/**
 * Aplica o resultado de uma consulta ao gateway (nunca o corpo do webhook diretamente).
 * Idempotente e seguro sob concorrência: bloqueia pagamento e pedido, e só libera o benefício
 * uma vez (transição de estado + índice único em transactions + chave única em deliveries).
 */
export async function applyProviderResult(
  ctx: AppContext,
  paymentId: string,
  remote: ProviderTransaction,
  source: EventSource,
): Promise<ConfirmOutcome> {
  return withTransaction(ctx.db, async (tx) => {
    // Ordem de locks: pedido -> pagamento.
    const ref = await tx.query<{ order_id: string }>('SELECT order_id FROM payments WHERE id = $1', [paymentId]);
    if (!ref.rows[0]) throw notFound('Pagamento não encontrado.');
    const order = await lockOrder(tx, ref.rows[0].order_id);
    const { rows } = await tx.query<PaymentRow>('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
    const payment = rows[0]!;

    if (remote.transactionId !== payment.provider_transaction_id || (remote.externalId !== null && remote.externalId !== payment.id)) {
      ctx.log.warn({ paymentId }, 'resultado do gateway não corresponde ao pagamento');
      return 'mismatch';
    }

    await tx.query(`UPDATE payments SET provider_status = $2, last_checked_at = now(), updated_at = now() WHERE id = $1`, [
      payment.id,
      remote.providerStatus,
    ]);

    if (payment.status === 'paid' || payment.status === 'refunded') return 'already_paid';
    if (remote.status !== 'paid') return 'not_paid';

    await tx.query(`UPDATE payments SET status = 'paid', paid_at = now(), updated_at = now() WHERE id = $1`, [payment.id]);

    const late = order.status === 'expired' || order.status === 'cancelled' || order.status === 'failed';
    if (late) {
      await tx.query(
        `INSERT INTO transactions (order_id, payment_id, type, amount_cents, provider_ref, data) VALUES ($1, $2, 'late_payment', $3, $4, $5)`,
        [order.id, payment.id, remote.amountCents ?? 0, remote.transactionId, JSON.stringify({ previousStatus: order.status })],
      );
      await reserveStockAgain(tx, order);
    }

    if (remote.amountCents === null || remote.amountCents !== payment.amount_cents) {
      await tx.query(
        `INSERT INTO transactions (order_id, payment_id, type, amount_cents, provider_ref, data) VALUES ($1, $2, 'amount_mismatch', $3, $4, $5)`,
        [order.id, payment.id, remote.amountCents ?? 0, remote.transactionId, JSON.stringify({ expectedCents: payment.amount_cents })],
      );
      if (order.status !== 'processing') {
        await transitionOrder(tx, order, 'processing', {
          source,
          message: 'Pagamento recebido com valor diferente do pedido. Aguardando análise da equipe.',
          data: { expectedCents: payment.amount_cents, receivedCents: remote.amountCents },
        });
      }
      return 'amount_mismatch';
    }

    await tx.query(
      `INSERT INTO transactions (order_id, payment_id, type, amount_cents, provider_ref) VALUES ($1, $2, 'payment_confirmed', $3, $4)`,
      [order.id, payment.id, remote.amountCents, remote.transactionId],
    );
    if (order.status === 'pending' || late || order.status === 'processing') {
      await transitionOrder(tx, order, 'paid', {
        source,
        message: late ? 'Pagamento confirmado após o prazo' : 'Pagamento confirmado pelo gateway',
        data: { transactionId: remote.transactionId },
      });
    }
    if (order.status === 'paid') await approveOrder(tx, order, source);
    return 'confirmed';
  });
}

/** Pagamento validado: cria as entregas pendentes para o servidor do jogo. */
export async function approveOrder(tx: DbClient, order: OrderRow, source: EventSource, actorUserId?: string | null) {
  const created = await createDeliveriesForOrder(tx, order);
  await transitionOrder(tx, order, 'approved', {
    source,
    actorUserId,
    message: 'Benefício liberado para entrega no jogo',
    data: { deliveriesCreated: created },
  });
}

/**
 * Consulta o gateway quando o jogador acompanha um pagamento pendente (cobre webhooks perdidos).
 * Com limite de frequência por pagamento para não abusar da API do gateway.
 */
export async function refreshPendingPayment(ctx: AppContext, payment: PaymentRow, force = false): Promise<void> {
  if (payment.status !== 'pending' || !payment.provider_transaction_id) return;
  if (!force && payment.last_checked_at && Date.now() - payment.last_checked_at.getTime() < RECHECK_INTERVAL_MS) return;
  // Marca a consulta antes de chamar o gateway para que requisições simultâneas não repitam a chamada.
  const claimed = await ctx.db.query(
    `UPDATE payments SET last_checked_at = now()
      WHERE id = $1 AND status = 'pending' AND (last_checked_at IS NULL OR last_checked_at < now() - interval '${force ? 0 : RECHECK_INTERVAL_MS / 1000} seconds')`,
    [payment.id],
  );
  if (!claimed.rowCount) return;
  try {
    const remote = await ctx.paymentProvider.getTransaction(payment.provider_transaction_id);
    if (remote) await applyProviderResult(ctx, payment.id, remote, force ? 'system' : 'reconcile');
  } catch (err) {
    ctx.log.warn({ paymentId: payment.id, err: (err as Error).message }, 'falha ao consultar pagamento no gateway');
  }
}

export async function findPaymentForUser(db: Queryable, paymentId: string, userId: string): Promise<PaymentRow | null> {
  const { rows } = await db.query<PaymentRow>(
    `SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = $1 AND o.user_id = $2`,
    [paymentId, userId],
  );
  return rows[0] ?? null;
}

export async function latestPaymentForOrder(db: Queryable, orderId: string): Promise<PaymentRow | null> {
  const { rows } = await db.query<PaymentRow>('SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1', [
    orderId,
  ]);
  return rows[0] ?? null;
}

/** Cancelamento pelo jogador: antes confere no gateway se o PIX já não foi pago. */
export async function cancelOrderByUser(ctx: AppContext, userId: string, orderId: string): Promise<void> {
  const pending = await ctx.db.query<PaymentRow>(
    `SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.id = $1 AND o.user_id = $2 AND p.status = 'pending'`,
    [orderId, userId],
  );
  for (const p of pending.rows) await refreshPendingPayment(ctx, p, true);
  await withTransaction(ctx.db, async (tx) => {
    const order = await lockOrder(tx, orderId, userId);
    if (order.status !== 'pending') throw conflict('order_not_cancellable', 'Este pedido não pode mais ser cancelado.');
    await closeUnpaidOrder(tx, order, 'cancelled', { source: 'player', actorUserId: userId, message: 'Pedido cancelado pelo jogador' });
  });
}

/** Job periódico: expira pedidos não pagos (após uma última consulta ao gateway) e libera o estoque. */
export async function expireStaleOrders(ctx: AppContext, limit = 50): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT id FROM orders WHERE status = 'pending' AND expires_at < now() ORDER BY expires_at LIMIT $1`,
    [limit],
  );
  let expired = 0;
  for (const { id } of rows) {
    const pending = await ctx.db.query<PaymentRow>(`SELECT * FROM payments WHERE order_id = $1 AND status = 'pending'`, [id]);
    for (const p of pending.rows) await refreshPendingPayment(ctx, p, true);
    await withTransaction(ctx.db, async (tx) => {
      const order = await lockOrder(tx, id);
      if (order.status !== 'pending') return;
      await closeUnpaidOrder(tx, order, 'expired', { source: 'system', message: 'Prazo de pagamento expirado' });
      expired++;
    });
  }
  return expired;
}
