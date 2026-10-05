import type { AppContext } from '../../context.js';
import { withTransaction, type Queryable } from '../../db/pool.js';
import { conflict, notFound } from '../../lib/errors.js';
import { getOrderItems, type OrderRow } from '../orders/service.js';
import { addOrderEvent, transitionOrder, type EventMeta, type OrderStatus } from '../orders/state.js';

export type DeliveryStatus = 'pending' | 'processing' | 'delivered' | 'failed' | 'cancelled';

export interface DeliveryRow {
  id: string;
  order_id: string;
  order_item_id: string;
  unit_index: number;
  user_id: string;
  product_id: string;
  game_account_id: string;
  server_account_id: string;
  type: string;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  attempts: number;
  claimed_at: Date | null;
  delivered_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Tempo que o servidor do jogo tem para concluir uma entrega reivindicada antes de ela voltar para a fila. */
export const CLAIM_LEASE_MINUTES = 10;

/**
 * Cria uma entrega pendente por unidade comprada. Idempotente: a chave única (order_item_id, unit_index)
 * garante que reprocessar o mesmo pagamento não gera benefícios duplicados.
 */
export async function createDeliveriesForOrder(db: Queryable, order: OrderRow): Promise<number> {
  const { rows: accounts } = await db.query<{ server_account_id: string }>(
    'SELECT server_account_id FROM game_accounts WHERE id = $1',
    [order.game_account_id],
  );
  const serverAccountId = accounts[0]?.server_account_id;
  if (!serverAccountId) throw new Error(`Conta do jogo ${order.game_account_id} não encontrada para o pedido ${order.id}`);

  let created = 0;
  for (const item of await getOrderItems(db, order.id)) {
    for (let unit = 0; unit < item.quantity; unit++) {
      const payload = {
        order_code: order.code,
        product_id: item.product_id,
        product_name: item.product_name,
        type: item.delivery_type,
        params: item.delivery_params,
        duration_days: item.duration_days,
      };
      const res = await db.query(
        `INSERT INTO deliveries (order_id, order_item_id, unit_index, user_id, product_id, game_account_id, server_account_id, type, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (order_item_id, unit_index) DO NOTHING`,
        [order.id, item.id, unit, order.user_id, item.product_id, order.game_account_id, serverAccountId, item.delivery_type, JSON.stringify(payload)],
      );
      created += res.rowCount ?? 0;
    }
  }
  return created;
}

export function toGameDelivery(d: DeliveryRow) {
  return {
    id: d.id,
    orderId: d.order_id,
    serverAccountId: d.server_account_id,
    type: d.type,
    payload: d.payload,
    status: d.status,
    attempts: d.attempts,
    createdAt: d.created_at,
  };
}

/** Lista entregas prontas para o servidor do jogo (pendentes ou com reivindicação vencida). */
export async function listPendingDeliveries(db: Queryable, filter: { serverAccountId?: string; limit: number }) {
  const params: unknown[] = [filter.limit];
  let where = `(d.status = 'pending' OR (d.status = 'processing' AND d.claimed_at < now() - interval '${CLAIM_LEASE_MINUTES} minutes'))`;
  if (filter.serverAccountId) {
    params.push(filter.serverAccountId);
    where += ` AND d.server_account_id = $${params.length}`;
  }
  const { rows } = await db.query<DeliveryRow>(
    `SELECT d.* FROM deliveries d WHERE ${where} ORDER BY d.created_at LIMIT $1`,
    params,
  );
  return rows;
}

async function lockDelivery(db: Queryable, id: string): Promise<DeliveryRow> {
  const { rows } = await db.query<DeliveryRow>('SELECT * FROM deliveries WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('Entrega não encontrada.');
  return rows[0];
}

/**
 * O servidor do jogo reivindica a entrega antes de aplicá-la. Só uma instância consegue reivindicar
 * (o lock de linha + checagem de status evitam entrega dupla). Retorna null se já estiver com outro processo.
 */
export async function claimDelivery(ctx: AppContext, id: string): Promise<DeliveryRow | null> {
  return withTransaction(ctx.db, async (tx) => {
    const d = await lockDelivery(tx, id);
    const leaseExpired = d.status === 'processing' && d.claimed_at !== null && d.claimed_at.getTime() < Date.now() - CLAIM_LEASE_MINUTES * 60_000;
    if (d.status !== 'pending' && !leaseExpired) return null;
    const { rows } = await tx.query<DeliveryRow>(
      `UPDATE deliveries SET status = 'processing', claimed_at = now(), attempts = attempts + 1, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id],
    );
    return rows[0]!;
  });
}

/** Marca a entrega como concluída. Idempotente: concluir duas vezes não altera nada. */
export async function completeDelivery(
  ctx: AppContext,
  id: string,
  meta: EventMeta,
): Promise<{ delivery: DeliveryRow; alreadyDelivered: boolean }> {
  return withTransaction(ctx.db, async (tx) => {
    // Ordem de locks: pedido -> entrega (a mesma usada no reembolso), evitando deadlocks.
    const ref = await tx.query<{ order_id: string }>('SELECT order_id FROM deliveries WHERE id = $1', [id]);
    if (!ref.rows[0]) throw notFound('Entrega não encontrada.');
    const order = await lockOrderRow(tx, ref.rows[0].order_id);
    const d = await lockDelivery(tx, id);
    if (d.status === 'delivered') return { delivery: d, alreadyDelivered: true };
    if (d.status === 'cancelled') throw conflict('delivery_cancelled', 'Esta entrega foi cancelada.');
    if (order.status === 'refunded') throw conflict('order_refunded', 'O pedido foi reembolsado; a entrega não deve ser aplicada.');
    const { rows } = await tx.query<DeliveryRow>(
      `UPDATE deliveries SET status = 'delivered', delivered_at = now(), last_error = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id],
    );
    await addOrderEvent(tx, d.order_id, 'delivery_delivered', {
      ...meta,
      message: meta.message ?? 'Benefício entregue no jogo',
      data: { deliveryId: id, type: d.type, ...(meta.data ?? {}) },
    });
    await maybeMarkOrderDelivered(tx, order, meta);
    return { delivery: rows[0]!, alreadyDelivered: false };
  });
}

export async function failDelivery(ctx: AppContext, id: string, reason: string, retry: boolean, meta: EventMeta) {
  return withTransaction(ctx.db, async (tx) => {
    const d = await lockDelivery(tx, id);
    if (d.status === 'delivered' || d.status === 'cancelled') {
      throw conflict('delivery_closed', 'Esta entrega já foi finalizada.');
    }
    const status: DeliveryStatus = retry ? 'pending' : 'failed';
    const { rows } = await tx.query<DeliveryRow>(
      `UPDATE deliveries SET status = $2, last_error = $3, claimed_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, status, reason.slice(0, 500)],
    );
    await addOrderEvent(tx, d.order_id, retry ? 'delivery_retry' : 'delivery_failed', {
      ...meta,
      message: retry ? 'Entrega devolvida para a fila' : 'Falha na entrega',
      data: { deliveryId: id, reason: reason.slice(0, 500) },
    });
    return rows[0]!;
  });
}

/** Admin: recoloca uma entrega com falha na fila. */
export async function requeueDelivery(ctx: AppContext, id: string, meta: EventMeta) {
  return withTransaction(ctx.db, async (tx) => {
    const d = await lockDelivery(tx, id);
    if (d.status !== 'failed' && d.status !== 'processing') {
      throw conflict('delivery_not_failed', 'Só é possível reenviar entregas com falha ou travadas.');
    }
    const { rows } = await tx.query<DeliveryRow>(
      `UPDATE deliveries SET status = 'pending', claimed_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
      [id],
    );
    await addOrderEvent(tx, d.order_id, 'delivery_requeued', { ...meta, message: 'Entrega reenviada para a fila', data: { deliveryId: id } });
    return rows[0]!;
  });
}

async function lockOrderRow(db: Queryable, orderId: string): Promise<OrderRow> {
  const { rows } = await db.query<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  return rows[0]!;
}

async function maybeMarkOrderDelivered(db: Queryable, order: OrderRow, meta: EventMeta): Promise<void> {
  const { rows } = await db.query<{ open: number }>(
    `SELECT COUNT(*) FILTER (WHERE status <> 'delivered' AND status <> 'cancelled') AS open FROM deliveries WHERE order_id = $1`,
    [order.id],
  );
  if ((rows[0]?.open ?? 1) === 0 && order.status === 'approved') {
    await transitionOrder(db, order as { id: string; status: OrderStatus }, 'delivered', {
      ...meta,
      message: 'Todos os benefícios foram entregues',
    });
  }
}

/** Resumo da entrega exibido ao jogador e no painel, independente do status do pagamento. */
export async function deliverySummary(db: Queryable, orderId: string) {
  const { rows } = await db.query<{ status: DeliveryStatus; n: number }>(
    'SELECT status, COUNT(*) AS n FROM deliveries WHERE order_id = $1 GROUP BY status',
    [orderId],
  );
  const counts = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<DeliveryStatus, number>>;
  const total = rows.reduce((s, r) => s + r.n, 0);
  const delivered = counts.delivered ?? 0;
  let status: 'none' | 'waiting' | 'partial' | 'delivered' | 'failed' | 'cancelled' = 'none';
  if (total > 0) {
    if (delivered === total) status = 'delivered';
    else if ((counts.failed ?? 0) > 0) status = 'failed';
    else if ((counts.cancelled ?? 0) === total) status = 'cancelled';
    else if (delivered > 0) status = 'partial';
    else status = 'waiting';
  }
  return { status, total, delivered };
}
