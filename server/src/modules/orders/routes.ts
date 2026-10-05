import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../auth/plugin.js';
import type { Queryable } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { deliverySummary } from '../deliveries/service.js';
import {
  cancelOrderByUser,
  createPaymentForOrder,
  findPaymentForUser,
  latestPaymentForOrder,
  refreshPendingPayment,
  type PaymentRow,
} from '../payments/service.js';
import { handlePaymentWebhook } from '../payments/webhook.js';
import { CreateOrderSchema, createOrder, getOrderItems, type OrderRow } from './service.js';

const uuid = z.uuid();
const NO_STORE = 'no-store';

async function paymentView(payment: PaymentRow | null) {
  if (!payment) return null;
  const showPix = payment.status === 'pending' && payment.pix_copy_paste;
  return {
    id: payment.id,
    method: payment.method,
    status: payment.status,
    amountCents: payment.amount_cents,
    expiresAt: payment.expires_at,
    paidAt: payment.paid_at,
    pixCopyPaste: showPix ? payment.pix_copy_paste : null,
    // QR Code gerado no próprio servidor: sem serviços externos e sem popups.
    pixQrSvg: showPix ? await QRCode.toString(payment.pix_copy_paste!, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : null,
  };
}

export async function orderView(db: Queryable, order: OrderRow) {
  const [items, payment, delivery, account] = await Promise.all([
    getOrderItems(db, order.id),
    latestPaymentForOrder(db, order.id),
    deliverySummary(db, order.id),
    db.query<{ nickname: string }>('SELECT nickname FROM game_accounts WHERE id = $1', [order.game_account_id]),
  ]);
  return {
    id: order.id,
    code: order.code,
    status: order.status,
    subtotalCents: order.subtotal_cents,
    discountCents: order.discount_cents,
    totalCents: order.total_cents,
    currency: order.currency,
    createdAt: order.created_at,
    expiresAt: order.expires_at,
    paidAt: order.paid_at,
    deliveredAt: order.delivered_at,
    gameAccount: { id: order.game_account_id, nickname: account.rows[0]?.nickname ?? '' },
    items: items.map((i) => ({
      productId: i.product_id,
      name: i.product_name,
      quantity: i.quantity,
      unitPriceCents: i.unit_price_cents,
      totalCents: i.total_cents,
      durationDays: i.duration_days,
    })),
    payment: await paymentView(payment),
    delivery,
  };
}

async function findOwnOrder(db: Queryable, orderId: string, userId: string): Promise<OrderRow> {
  // Sempre filtrado pelo dono: IDs de outros jogadores retornam 404 (sem revelar que existem).
  const { rows } = await db.query<OrderRow>('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [orderId, userId]);
  if (!rows[0]) throw notFound('Pedido não encontrado.');
  return rows[0];
}

export function orderRoutes(app: FastifyInstance, ctx: AppContext): void {
  const strict = { rateLimit: { max: 20, timeWindow: '1 minute' } };

  app.post('/api/store/orders', { preHandler: requireUser, config: strict }, async (req, reply) => {
    const input = parse(CreateOrderSchema, req.body);
    const order = await createOrder(ctx, req.user!.id, input);
    reply.header('Cache-Control', NO_STORE).code(201);
    return { order: await orderView(ctx.db, order) };
  });

  app.get('/api/store/orders', { preHandler: requireUser }, async (req, reply) => {
    const q = parse(z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) }), req.query);
    const pageSize = 20;
    const { rows } = await ctx.db.query<OrderRow>(
      'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [req.user!.id, pageSize + 1, (q.page - 1) * pageSize],
    );
    reply.header('Cache-Control', NO_STORE);
    const page = rows.slice(0, pageSize);
    return {
      orders: await Promise.all(page.map((o) => orderView(ctx.db, o))),
      page: q.page,
      hasMore: rows.length > pageSize,
    };
  });

  app.get<{ Params: { id: string } }>('/api/store/orders/:id', { preHandler: requireUser }, async (req, reply) => {
    const id = parse(uuid, req.params.id);
    let order = await findOwnOrder(ctx.db, id, req.user!.id);
    if (order.status === 'pending') {
      const payment = await latestPaymentForOrder(ctx.db, order.id);
      if (payment) {
        await refreshPendingPayment(ctx, payment);
        order = await findOwnOrder(ctx.db, id, req.user!.id);
      }
    }
    reply.header('Cache-Control', NO_STORE);
    return { order: await orderView(ctx.db, order) };
  });

  app.post<{ Params: { id: string } }>('/api/store/orders/:id/cancel', { preHandler: requireUser, config: strict }, async (req) => {
    const id = parse(uuid, req.params.id);
    await cancelOrderByUser(ctx, req.user!.id, id);
    return { order: await orderView(ctx.db, await findOwnOrder(ctx.db, id, req.user!.id)) };
  });

  app.post('/api/payments/create', { preHandler: requireUser, config: strict }, async (req, reply) => {
    const { orderId } = parse(z.object({ orderId: uuid }), req.body);
    const payment = await createPaymentForOrder(ctx, req.user!, orderId);
    reply.header('Cache-Control', NO_STORE).code(201);
    return { payment: await paymentView(payment) };
  });

  app.get<{ Params: { id: string } }>(
    '/api/payments/:id/status',
    { preHandler: requireUser, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const id = parse(uuid, req.params.id);
      let payment = await findPaymentForUser(ctx.db, id, req.user!.id);
      if (!payment) throw notFound('Pagamento não encontrado.');
      if (payment.status === 'pending') {
        await refreshPendingPayment(ctx, payment);
        payment = (await findPaymentForUser(ctx.db, id, req.user!.id))!;
      }
      const order = await findOwnOrder(ctx.db, payment.order_id, req.user!.id);
      reply.header('Cache-Control', NO_STORE);
      return {
        payment: { id: payment.id, status: payment.status, paidAt: payment.paid_at, expiresAt: payment.expires_at },
        orderStatus: order.status,
        delivery: await deliverySummary(ctx.db, order.id),
      };
    },
  );

  // Webhook do gateway. Autenticado pelo segredo na URL (configurado no postbackUrl de cada cobrança).
  app.post(
    '/api/webhooks/payment',
    { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const token = (req.query as Record<string, string | undefined>).token;
      const result = await handlePaymentWebhook(ctx, { token, ip: req.ip, body: req.body });
      reply.code(200);
      return { received: true, ...result };
    },
  );
}
