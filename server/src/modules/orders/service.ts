import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { withTransaction, type Queryable } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { randomCode } from '../../lib/security.js';
import { effectivePriceCents } from '../catalog/pricing.js';
import type { ProductRow } from '../catalog/repository.js';
import { addOrderEvent, transitionOrder, type EventMeta, type OrderStatus } from './state.js';

const MAX_OPEN_ORDERS_PER_USER = 5;

export const CreateOrderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: z.coerce.number().int().min(1).max(100),
        // Qualquer preço enviado pelo cliente é ignorado de propósito: o valor vem sempre do banco.
      }),
    )
    .min(1)
    .max(20),
  gameAccountId: z.uuid(),
  idempotencyKey: z.string().min(8).max(100).optional(),
});
export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;

export interface OrderRow {
  id: string;
  code: string;
  user_id: string;
  game_account_id: string;
  status: OrderStatus;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  currency: string;
  coupon_id: string | null;
  idempotency_key: string | null;
  stock_reserved: boolean;
  expires_at: Date;
  paid_at: Date | null;
  approved_at: Date | null;
  delivered_at: Date | null;
  cancelled_at: Date | null;
  refunded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  unit_price_cents: number;
  quantity: number;
  total_cents: number;
  delivery_type: string;
  delivery_params: Record<string, unknown>;
  duration_days: number | null;
}

/**
 * Cria o pedido interno. Preço, disponibilidade e estoque são lidos e bloqueados no banco
 * dentro da mesma transação — o cliente informa apenas IDs e quantidades.
 */
export async function createOrder(ctx: AppContext, userId: string, input: CreateOrderInput): Promise<OrderRow> {
  // Agrupa itens repetidos do mesmo produto.
  const quantities = new Map<string, number>();
  for (const item of input.items) quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);

  return withTransaction(ctx.db, async (tx) => {
    // Serializa a criação de pedidos do mesmo usuário (evita burlar o limite e duplicar pedidos em paralelo).
    await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);

    if (input.idempotencyKey) {
      const existing = await tx.query<OrderRow>('SELECT * FROM orders WHERE user_id = $1 AND idempotency_key = $2', [
        userId,
        input.idempotencyKey,
      ]);
      if (existing.rows[0]) return existing.rows[0];
    }

    const account = await tx.query<{ id: string }>('SELECT id FROM game_accounts WHERE id = $1 AND user_id = $2', [
      input.gameAccountId,
      userId,
    ]);
    if (!account.rows[0]) {
      throw badRequest('game_account_required', 'Escolha uma conta do jogo vinculada ao seu login para receber o benefício.');
    }

    const open = await tx.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM orders WHERE user_id = $1 AND status = 'pending' AND expires_at > now()`,
      [userId],
    );
    if ((open.rows[0]?.n ?? 0) >= MAX_OPEN_ORDERS_PER_USER) {
      throw conflict('too_many_open_orders', 'Você tem muitos pedidos aguardando pagamento. Pague ou cancele um deles primeiro.');
    }

    const ids = [...quantities.keys()];
    const { rows: products } = await tx.query<ProductRow & { category_active: boolean }>(
      `SELECT p.*, c.is_active AS category_active
         FROM products p JOIN categories c ON c.id = p.category_id
        WHERE p.id = ANY($1::uuid[]) AND p.deleted_at IS NULL
        ORDER BY p.id
        FOR UPDATE OF p`,
      [ids],
    );
    const byId = new Map(products.map((p) => [p.id, p]));

    const now = new Date();
    const lines: { product: ProductRow; quantity: number; unit: number }[] = [];
    for (const [productId, quantity] of quantities) {
      const product = byId.get(productId);
      if (!product || !product.is_active || !product.category_active) {
        throw conflict('product_unavailable', 'Um dos produtos não está mais disponível.', { productId });
      }
      if (quantity > product.max_per_order) {
        throw badRequest('quantity_not_allowed', `Quantidade máxima para "${product.name}": ${product.max_per_order}.`, {
          productId,
        });
      }
      if (product.stock !== null && product.stock < quantity) {
        throw conflict('out_of_stock', `Estoque insuficiente para "${product.name}".`, { productId, stock: product.stock });
      }
      lines.push({ product, quantity, unit: effectivePriceCents(product, now) });
    }

    const subtotal = lines.reduce((sum, l) => sum + l.unit * l.quantity, 0);
    const discount = 0; // Cupons: estrutura pronta (tabela coupons + orders.coupon_id), aplicação futura.
    const total = subtotal - discount;
    const expiresAt = new Date(now.getTime() + ctx.config.payment.expirationMinutes * 60_000);

    const { rows } = await tx.query<OrderRow>(
      `INSERT INTO orders (code, user_id, game_account_id, subtotal_cents, discount_cents, total_cents, idempotency_key, stock_reserved, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        `CC-${randomCode(8)}`,
        userId,
        input.gameAccountId,
        subtotal,
        discount,
        total,
        input.idempotencyKey ?? null,
        lines.some((l) => l.product.stock !== null),
        expiresAt,
      ],
    );
    const order = rows[0]!;

    for (const { product, quantity, unit } of lines) {
      if (product.stock !== null) {
        await tx.query('UPDATE products SET stock = stock - $2, updated_at = now() WHERE id = $1', [product.id, quantity]);
      }
      await tx.query(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price_cents, quantity, total_cents, delivery_type, delivery_params, duration_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          order.id,
          product.id,
          product.name,
          unit,
          quantity,
          unit * quantity,
          product.delivery_type,
          JSON.stringify(product.delivery_params),
          product.duration_days,
        ],
      );
    }
    await addOrderEvent(tx, order.id, 'created', {
      source: 'player',
      actorUserId: userId,
      to: 'pending',
      message: 'Pedido criado',
      data: { totalCents: total },
    });
    return order;
  });
}

/** Devolve ao estoque o que foi reservado por um pedido que não será pago. */
export async function releaseStock(db: Queryable, order: OrderRow): Promise<void> {
  if (!order.stock_reserved) return;
  await db.query(
    `UPDATE products p SET stock = p.stock + i.quantity, updated_at = now()
       FROM order_items i
      WHERE i.order_id = $1 AND i.product_id = p.id AND p.stock IS NOT NULL`,
    [order.id],
  );
  await db.query('UPDATE orders SET stock_reserved = false WHERE id = $1', [order.id]);
  order.stock_reserved = false;
}

/** Reserva o estoque novamente (pagamento tardio de um pedido expirado/cancelado). Nunca fica negativo. */
export async function reserveStockAgain(db: Queryable, order: OrderRow): Promise<void> {
  if (order.stock_reserved) return;
  const { rowCount } = await db.query(
    `UPDATE products p SET stock = GREATEST(p.stock - i.quantity, 0), updated_at = now()
       FROM order_items i
      WHERE i.order_id = $1 AND i.product_id = p.id AND p.stock IS NOT NULL`,
    [order.id],
  );
  if (rowCount) await db.query('UPDATE orders SET stock_reserved = true WHERE id = $1', [order.id]);
  order.stock_reserved = Boolean(rowCount);
}

export async function lockOrder(db: Queryable, orderId: string, userId?: string): Promise<OrderRow> {
  const { rows } = await db.query<OrderRow>(
    `SELECT * FROM orders WHERE id = $1 ${userId ? 'AND user_id = $2' : ''} FOR UPDATE`,
    userId ? [orderId, userId] : [orderId],
  );
  if (!rows[0]) throw notFound('Pedido não encontrado.');
  return rows[0];
}

/** Encerra um pedido não pago (cancelado/expirado/falhou): cancela cobranças pendentes e libera o estoque. */
export async function closeUnpaidOrder(
  db: Queryable,
  order: OrderRow,
  to: Extract<OrderStatus, 'cancelled' | 'expired' | 'failed'>,
  meta: EventMeta,
): Promise<void> {
  await transitionOrder(db, order, to, meta);
  await db.query(
    `UPDATE payments SET status = $2, updated_at = now() WHERE order_id = $1 AND status = 'pending'`,
    [order.id, to === 'expired' ? 'expired' : to === 'failed' ? 'failed' : 'cancelled'],
  );
  if (to === 'expired') {
    await db.query(
      `INSERT INTO transactions (order_id, type, amount_cents) VALUES ($1, 'payment_expired', $2)`,
      [order.id, order.total_cents],
    );
  }
  await releaseStock(db, order);
}

export async function getOrderItems(db: Queryable, orderId: string): Promise<OrderItemRow[]> {
  const { rows } = await db.query<OrderItemRow>('SELECT * FROM order_items WHERE order_id = $1 ORDER BY product_name', [
    orderId,
  ]);
  return rows;
}
