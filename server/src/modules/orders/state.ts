import type { Queryable } from '../../db/pool.js';
import { conflict } from '../../lib/errors.js';

export const ORDER_STATUSES = [
  'pending', // pedido criado, aguardando pagamento
  'processing', // pagamento recebido, mas em análise (ex.: valor divergente)
  'paid', // pagamento confirmado pelo gateway
  'approved', // pagamento validado e entregas criadas (aguardando o jogo)
  'cancelled',
  'expired',
  'refunded',
  'failed',
  'delivered', // todos os benefícios foram entregues no jogo
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type EventSource = 'system' | 'player' | 'webhook' | 'reconcile' | 'admin' | 'game';

/** Transições válidas. Qualquer outra é recusada, o que impede regressões de estado e processamento duplicado. */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['processing', 'paid', 'cancelled', 'expired', 'failed'],
  processing: ['paid', 'approved', 'refunded', 'failed', 'cancelled'],
  paid: ['approved', 'processing', 'refunded'],
  approved: ['delivered', 'refunded'],
  delivered: ['refunded'],
  // Pagamento que chegou depois do prazo/cancelamento continua sendo do jogador.
  expired: ['paid', 'processing'],
  cancelled: ['paid', 'processing'],
  failed: ['paid', 'processing'],
  refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

const TIMESTAMP_COLUMN: Partial<Record<OrderStatus, string>> = {
  paid: 'paid_at',
  approved: 'approved_at',
  delivered: 'delivered_at',
  cancelled: 'cancelled_at',
  refunded: 'refunded_at',
};

export interface EventMeta {
  source: EventSource;
  actorUserId?: string | null;
  message?: string;
  data?: Record<string, unknown>;
}

export async function addOrderEvent(
  db: Queryable,
  orderId: string,
  type: string,
  meta: EventMeta & { from?: OrderStatus | null; to?: OrderStatus | null },
): Promise<void> {
  await db.query(
    `INSERT INTO order_events (order_id, type, from_status, to_status, source, actor_user_id, message, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      orderId,
      type,
      meta.from ?? null,
      meta.to ?? null,
      meta.source,
      meta.actorUserId ?? null,
      meta.message ?? '',
      JSON.stringify(meta.data ?? {}),
    ],
  );
}

/**
 * Altera o status de um pedido que JÁ ESTÁ bloqueado (SELECT ... FOR UPDATE) na transação atual.
 * Registra o evento no histórico.
 */
export async function transitionOrder(
  db: Queryable,
  order: { id: string; status: OrderStatus },
  to: OrderStatus,
  meta: EventMeta,
): Promise<void> {
  if (!canTransition(order.status, to)) {
    throw conflict('invalid_transition', `Não é possível mudar o pedido de "${order.status}" para "${to}".`);
  }
  const column = TIMESTAMP_COLUMN[to];
  await db.query(
    `UPDATE orders SET status = $2, updated_at = now()${column ? `, ${column} = COALESCE(${column}, now())` : ''} WHERE id = $1`,
    [order.id, to],
  );
  await addOrderEvent(db, order.id, 'status_changed', { ...meta, from: order.status, to });
  order.status = to;
}
