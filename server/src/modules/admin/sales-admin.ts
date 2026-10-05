import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireAdmin } from '../../auth/plugin.js';
import { withTransaction } from '../../db/pool.js';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { deliveryTypesMeta } from '../catalog/delivery-types.js';
import { completeDelivery, deliverySummary, requeueDelivery, type DeliveryRow } from '../deliveries/service.js';
import { closeUnpaidOrder, lockOrder, type OrderRow } from '../orders/service.js';
import { ORDER_STATUSES, transitionOrder } from '../orders/state.js';
import { applyProviderResult, approveOrder, refreshPendingPayment, type PaymentRow } from '../payments/service.js';
import { CATEGORY_ICONS } from './catalog-admin.js';

const TZ = 'America/Sao_Paulo';
// Pedidos que representam receita efetiva (pagos e não reembolsados).
const REVENUE_STATUSES = `('paid', 'approved', 'delivered')`;

export function salesAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = { preHandler: requireAdmin };
  const uuid = z.uuid();
  const actor = (req: FastifyRequest): AuditActor => ({ userId: req.user!.id, label: req.user!.email ?? req.user!.name, ip: req.ip });

  app.get('/api/admin/meta', admin, async () => ({
    deliveryTypes: deliveryTypesMeta(),
    orderStatuses: ORDER_STATUSES,
    categoryIcons: CATEGORY_ICONS,
    paymentProvider: ctx.paymentProvider.name,
  }));

  // ------------------------------------------------------------------ dashboard
  app.get('/api/admin/dashboard', admin, async (req) => {
    const q = parse(
      z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }),
      req.query,
    );
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 30 * 86_400_000);

    const [summary, period, top, recent, queue, daily] = await Promise.all([
      ctx.db.query<Record<string, number>>(
        `WITH b AS (
           SELECT date_trunc('day', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}' AS today,
                  date_trunc('week', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}' AS week,
                  date_trunc('month', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}' AS month)
         SELECT
           COALESCE(SUM(total_cents) FILTER (WHERE status IN ${REVENUE_STATUSES}), 0) AS revenue_total,
           COUNT(*) FILTER (WHERE status IN ${REVENUE_STATUSES} AND paid_at >= b.today) AS sales_today,
           COALESCE(SUM(total_cents) FILTER (WHERE status IN ${REVENUE_STATUSES} AND paid_at >= b.today), 0) AS revenue_today,
           COUNT(*) FILTER (WHERE status IN ${REVENUE_STATUSES} AND paid_at >= b.week) AS sales_week,
           COALESCE(SUM(total_cents) FILTER (WHERE status IN ${REVENUE_STATUSES} AND paid_at >= b.week), 0) AS revenue_week,
           COUNT(*) FILTER (WHERE status IN ${REVENUE_STATUSES} AND paid_at >= b.month) AS sales_month,
           COALESCE(SUM(total_cents) FILTER (WHERE status IN ${REVENUE_STATUSES} AND paid_at >= b.month), 0) AS revenue_month,
           COUNT(*) FILTER (WHERE status = 'pending' AND expires_at > now()) AS orders_pending,
           COUNT(*) FILTER (WHERE status = 'processing') AS orders_review,
           COUNT(*) FILTER (WHERE status IN ${REVENUE_STATUSES}) AS orders_approved,
           COUNT(*) FILTER (WHERE status IN ('cancelled', 'expired', 'failed')) AS orders_cancelled,
           COUNT(*) FILTER (WHERE status = 'refunded') AS orders_refunded
         FROM orders, b
         GROUP BY b.today, b.week, b.month`,
      ),
      ctx.db.query<{ revenue: number; sales: number }>(
        `SELECT COALESCE(SUM(total_cents), 0) AS revenue, COUNT(*) AS sales
           FROM orders WHERE status IN ${REVENUE_STATUSES} AND paid_at >= $1 AND paid_at < $2`,
        [from, to],
      ),
      ctx.db.query<{ product_id: string; name: string; quantity: number; revenue: number }>(
        `SELECT i.product_id, MAX(i.product_name) AS name, SUM(i.quantity) AS quantity, SUM(i.total_cents) AS revenue
           FROM order_items i JOIN orders o ON o.id = i.order_id
          WHERE o.status IN ${REVENUE_STATUSES} AND o.paid_at >= $1 AND o.paid_at < $2
          GROUP BY i.product_id ORDER BY quantity DESC, revenue DESC LIMIT 5`,
        [from, to],
      ),
      ctx.db.query<OrderRow & { nickname: string }>(
        `SELECT o.*, g.nickname FROM orders o JOIN game_accounts g ON g.id = o.game_account_id
          WHERE o.status IN ${REVENUE_STATUSES} ORDER BY o.paid_at DESC NULLS LAST LIMIT 8`,
      ),
      ctx.db.query<{ pending: number; failed: number }>(
        `SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'processing')) AS pending,
                COUNT(*) FILTER (WHERE status = 'failed') AS failed FROM deliveries`,
      ),
      ctx.db.query<{ day: string; revenue: number }>(
        `SELECT to_char(date_trunc('day', paid_at AT TIME ZONE '${TZ}'), 'YYYY-MM-DD') AS day, SUM(total_cents) AS revenue
           FROM orders WHERE status IN ${REVENUE_STATUSES} AND paid_at >= $1 AND paid_at < $2
          GROUP BY 1 ORDER BY 1`,
        [from, to],
      ),
    ]);

    const s = summary.rows[0] ?? {};
    const p = period.rows[0] ?? { revenue: 0, sales: 0 };
    const n = (k: string) => Number(s[k] ?? 0);
    return {
      range: { from, to },
      revenue: { total: n('revenue_total'), period: p.revenue, today: n('revenue_today'), week: n('revenue_week'), month: n('revenue_month') },
      sales: { period: p.sales, today: n('sales_today'), week: n('sales_week'), month: n('sales_month') },
      averageTicketCents: p.sales > 0 ? Math.round(p.revenue / p.sales) : 0,
      orders: {
        pending: n('orders_pending'),
        review: n('orders_review'),
        approved: n('orders_approved'),
        cancelled: n('orders_cancelled'),
        refunded: n('orders_refunded'),
      },
      deliveries: queue.rows[0] ?? { pending: 0, failed: 0 },
      topProducts: top.rows.map((r) => ({ productId: r.product_id, name: r.name, quantity: r.quantity, revenueCents: r.revenue })),
      dailyRevenue: daily.rows.map((r) => ({ day: r.day, revenueCents: r.revenue })),
      recentSales: recent.rows.map((o) => ({
        id: o.id,
        code: o.code,
        nickname: o.nickname,
        totalCents: o.total_cents,
        status: o.status,
        paidAt: o.paid_at,
      })),
    };
  });

  // ------------------------------------------------------------------ pedidos
  app.get('/api/admin/orders', admin, async (req) => {
    const q = parse(
      z.object({
        status: z.enum(ORDER_STATUSES).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        q: z.string().trim().max(100).optional(),
        productId: uuid.optional(),
        userId: uuid.optional(),
        page: z.coerce.number().int().min(1).max(10_000).default(1),
        pageSize: z.coerce.number().int().min(5).max(100).default(25),
      }),
      req.query,
    );
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.status) add('o.status = ?', q.status);
    if (q.from) add('o.created_at >= ?', q.from);
    if (q.to) add('o.created_at < ?', q.to);
    if (q.userId) add('o.user_id = ?', q.userId);
    if (q.productId) add('EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.product_id = ?)', q.productId);
    if (q.q) {
      params.push(`%${q.q}%`);
      const i = `$${params.length}`;
      where.push(`(o.code ILIKE ${i} OR u.email ILIKE ${i} OR u.name ILIKE ${i} OR g.nickname ILIKE ${i} OR g.server_account_id ILIKE ${i}
                  OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.provider_transaction_id ILIKE ${i}))`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const base = `FROM orders o JOIN users u ON u.id = o.user_id JOIN game_accounts g ON g.id = o.game_account_id ${whereSql}`;
    const [count, list] = await Promise.all([
      ctx.db.query<{ n: number }>(`SELECT COUNT(*) AS n ${base}`, params),
      ctx.db.query<OrderRow & { email: string | null; user_name: string; nickname: string; items_label: string }>(
        `SELECT o.*, u.email, u.name AS user_name, g.nickname,
                (SELECT string_agg(i.quantity || 'x ' || i.product_name, ', ') FROM order_items i WHERE i.order_id = o.id) AS items_label
           ${base} ORDER BY o.created_at DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
        params,
      ),
    ]);
    return {
      total: count.rows[0]?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
      orders: list.rows.map((o) => ({
        id: o.id,
        code: o.code,
        status: o.status,
        totalCents: o.total_cents,
        createdAt: o.created_at,
        paidAt: o.paid_at,
        user: { id: o.user_id, name: o.user_name, email: o.email },
        nickname: o.nickname,
        itemsLabel: o.items_label,
      })),
    };
  });

  async function orderDetail(id: string) {
    const { rows } = await ctx.db.query<OrderRow & { email: string | null; user_name: string; nickname: string; server_account_id: string }>(
      `SELECT o.*, u.email, u.name AS user_name, g.nickname, g.server_account_id
         FROM orders o JOIN users u ON u.id = o.user_id JOIN game_accounts g ON g.id = o.game_account_id
        WHERE o.id = $1`,
      [id],
    );
    const o = rows[0];
    if (!o) throw notFound('Pedido não encontrado.');
    const [items, payments, transactions, events, deliveries, summary] = await Promise.all([
      ctx.db.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY product_name', [id]),
      ctx.db.query<PaymentRow>('SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at', [id]),
      ctx.db.query('SELECT * FROM transactions WHERE order_id = $1 ORDER BY created_at', [id]),
      ctx.db.query(
        `SELECT e.*, u.email AS actor_email FROM order_events e LEFT JOIN users u ON u.id = e.actor_user_id
          WHERE e.order_id = $1 ORDER BY e.created_at, e.id`,
        [id],
      ),
      ctx.db.query<DeliveryRow>('SELECT * FROM deliveries WHERE order_id = $1 ORDER BY created_at, unit_index', [id]),
      deliverySummary(ctx.db, id),
    ]);
    return {
      id: o.id,
      code: o.code,
      status: o.status,
      subtotalCents: o.subtotal_cents,
      discountCents: o.discount_cents,
      totalCents: o.total_cents,
      createdAt: o.created_at,
      expiresAt: o.expires_at,
      paidAt: o.paid_at,
      approvedAt: o.approved_at,
      deliveredAt: o.delivered_at,
      cancelledAt: o.cancelled_at,
      refundedAt: o.refunded_at,
      user: { id: o.user_id, name: o.user_name, email: o.email },
      gameAccount: { id: o.game_account_id, nickname: o.nickname, serverAccountId: o.server_account_id },
      items: items.rows,
      payments: payments.rows.map((p) => ({
        id: p.id,
        provider: p.provider,
        method: p.method,
        status: p.status,
        providerStatus: p.provider_status,
        transactionId: p.provider_transaction_id,
        amountCents: p.amount_cents,
        createdAt: p.created_at,
        paidAt: p.paid_at,
        lastCheckedAt: p.last_checked_at,
      })),
      transactions: transactions.rows,
      events: events.rows,
      deliveries: deliveries.rows,
      delivery: summary,
    };
  }

  app.get<{ Params: { id: string } }>('/api/admin/orders/:id', admin, async (req) => ({ order: await orderDetail(parse(uuid, req.params.id)) }));

  app.post<{ Params: { id: string } }>('/api/admin/orders/:id/recheck', admin, async (req) => {
    const id = parse(uuid, req.params.id);
    const { rows } = await ctx.db.query<PaymentRow>(`SELECT * FROM payments WHERE order_id = $1 AND status IN ('pending', 'expired', 'cancelled', 'failed') AND provider_transaction_id IS NOT NULL`, [id]);
    for (const p of rows) {
      if (p.status !== 'pending') {
        // Pagamento já encerrado localmente: consulta direta para detectar pagamento tardio.
        const remote = await ctx.paymentProvider.getTransaction(p.provider_transaction_id!);
        if (remote) await applyProviderResult(ctx, p.id, remote, 'admin');
      } else {
        await refreshPendingPayment(ctx, p, true);
      }
    }
    await writeAudit(ctx.db, actor(req), 'order.payment_rechecked', 'order', id);
    return { order: await orderDetail(id) };
  });

  app.post<{ Params: { id: string } }>('/api/admin/orders/:id/cancel', admin, async (req) => {
    const id = parse(uuid, req.params.id);
    const body = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    await withTransaction(ctx.db, async (tx) => {
      const order = await lockOrder(tx, id);
      if (order.status !== 'pending') throw conflict('order_not_cancellable', 'Apenas pedidos aguardando pagamento podem ser cancelados.');
      await closeUnpaidOrder(tx, order, 'cancelled', { source: 'admin', actorUserId: req.user!.id, message: body.reason });
      await writeAudit(tx, actor(req), 'order.cancelled', 'order', id, { reason: body.reason, code: order.code });
    });
    return { order: await orderDetail(id) };
  });

  /** Libera manualmente um pedido em análise (ex.: valor divergente conferido pela equipe). */
  app.post<{ Params: { id: string } }>('/api/admin/orders/:id/approve', admin, async (req) => {
    const id = parse(uuid, req.params.id);
    const body = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    await withTransaction(ctx.db, async (tx) => {
      const order = await lockOrder(tx, id);
      if (order.status !== 'processing') throw conflict('order_not_in_review', 'Apenas pedidos em análise podem ser aprovados manualmente.');
      const paid = await tx.query(`SELECT 1 FROM payments WHERE order_id = $1 AND status = 'paid'`, [id]);
      if (!paid.rowCount) throw conflict('payment_not_confirmed', 'Não há pagamento confirmado pelo gateway para este pedido.');
      await approveOrder(tx, order, 'admin', req.user!.id);
      await writeAudit(tx, actor(req), 'order.approved_manually', 'order', id, { reason: body.reason, code: order.code });
    });
    return { order: await orderDetail(id) };
  });

  /**
   * Registra um reembolso feito no painel do gateway. Cancela entregas ainda não aplicadas;
   * entregas já concluídas ficam no histórico para a equipe remover manualmente no jogo, se necessário.
   */
  app.post<{ Params: { id: string } }>('/api/admin/orders/:id/refund', admin, async (req) => {
    const id = parse(uuid, req.params.id);
    const body = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    await withTransaction(ctx.db, async (tx) => {
      const order = await lockOrder(tx, id);
      if (!['paid', 'approved', 'delivered', 'processing'].includes(order.status)) {
        throw conflict('order_not_refundable', 'Só é possível registrar reembolso de pedidos pagos.');
      }
      const payment = await tx.query<PaymentRow>(`SELECT * FROM payments WHERE order_id = $1 AND status = 'paid' FOR UPDATE`, [id]);
      const paid = payment.rows[0];
      if (!paid) throw conflict('payment_not_confirmed', 'Não há pagamento confirmado para reembolsar.');
      await tx.query(`UPDATE payments SET status = 'refunded', updated_at = now() WHERE id = $1`, [paid.id]);
      await tx.query(
        `INSERT INTO transactions (order_id, payment_id, type, amount_cents, provider_ref, data) VALUES ($1, $2, 'refund', $3, $4, $5)`,
        [id, paid.id, paid.amount_cents, paid.provider_transaction_id, JSON.stringify({ reason: body.reason, by: req.user!.id })],
      );
      const cancelled = await tx.query(
        `UPDATE deliveries SET status = 'cancelled', updated_at = now() WHERE order_id = $1 AND status IN ('pending', 'failed', 'processing')`,
        [id],
      );
      await transitionOrder(tx, order, 'refunded', { source: 'admin', actorUserId: req.user!.id, message: body.reason });
      await writeAudit(tx, actor(req), 'order.refunded', 'order', id, {
        reason: body.reason,
        code: order.code,
        amountCents: paid.amount_cents,
        deliveriesCancelled: cancelled.rowCount,
      });
    });
    return { order: await orderDetail(id) };
  });

  // ------------------------------------------------------------------ entregas
  app.post<{ Params: { id: string } }>('/api/admin/deliveries/:id/deliver', admin, async (req) => {
    const id = parse(uuid, req.params.id);
    const body = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    const { delivery } = await completeDelivery(ctx, id, {
      source: 'admin',
      actorUserId: req.user!.id,
      message: `Entrega manual: ${body.reason}`,
    });
    await writeAudit(ctx.db, actor(req), 'delivery.manual', 'delivery', id, { orderId: delivery.order_id, reason: body.reason });
    return { order: await orderDetail(delivery.order_id) };
  });

  app.post<{ Params: { id: string } }>('/api/admin/deliveries/:id/requeue', admin, async (req) => {
    const id = parse(uuid, req.params.id);
    const delivery = await requeueDelivery(ctx, id, { source: 'admin', actorUserId: req.user!.id });
    await writeAudit(ctx.db, actor(req), 'delivery.requeued', 'delivery', id, { orderId: delivery.order_id });
    return { order: await orderDetail(delivery.order_id) };
  });

  // ------------------------------------------------------------------ auditoria
  app.get('/api/admin/audit', admin, async (req) => {
    const q = parse(
      z.object({
        entityType: z.string().max(40).optional(),
        entityId: z.string().max(80).optional(),
        page: z.coerce.number().int().min(1).max(10_000).default(1),
      }),
      req.query,
    );
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.entityType) {
      params.push(q.entityType);
      where.push(`entity_type = $${params.length}`);
    }
    if (q.entityId) {
      params.push(q.entityId);
      where.push(`entity_id = $${params.length}`);
    }
    const pageSize = 50;
    const { rows } = await ctx.db.query(
      `SELECT id, actor_label, action, entity_type, entity_id, data, created_at FROM audit_logs
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC LIMIT ${pageSize + 1} OFFSET ${(q.page - 1) * pageSize}`,
      params,
    );
    return { logs: rows.slice(0, pageSize), page: q.page, hasMore: rows.length > pageSize };
  });
}
