import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expireStaleOrders } from '../src/modules/payments/service.js';
import {
  adminClient,
  createCatalog,
  gameRequest,
  orderAndPay,
  paidWebhookBody,
  playerWithAccount,
  setup,
  webhook,
  type TestEnv,
} from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setup();
});
afterAll(async () => {
  await env.close();
});

describe('fluxo completo de compra', () => {
  it('pedido -> PIX -> webhook -> confirmação -> entrega pendente -> entrega no jogo', async () => {
    const admin = await adminClient(env.app);
    const { product } = await createCatalog(admin);
    const { player, gameAccountId } = await playerWithAccount(env.app, 'flow1', '5001');

    // 1. Criação do pedido (cliente tenta mandar preço/total: deve ser ignorado)
    const created = await player.request('POST', '/api/store/orders', {
      items: [{ productId: product.id, quantity: 2, priceCents: 1, unitPriceCents: 1 }],
      gameAccountId,
      totalCents: 1,
      subtotalCents: 1,
    });
    expect(created.status).toBe(201);
    const order = created.body.order;
    // 2. Preço vem do banco (promoção 19,90 x 2), nunca do cliente
    expect(order.totalCents).toBe(3980);
    expect(order.items[0].unitPriceCents).toBe(1990);
    expect(order.status).toBe('pending');

    // estoque reservado
    const stock1 = await env.db.query('SELECT stock FROM products WHERE id = $1', [product.id]);
    expect(stock1.rows[0].stock).toBe(3);

    // 3. Criação do pagamento: valor enviado ao gateway = total calculado no servidor
    const pay = await player.request('POST', '/api/payments/create', { orderId: order.id });
    expect(pay.status).toBe(201);
    expect(pay.body.payment.status).toBe('pending');
    expect(pay.body.payment.pixCopyPaste).toBeTruthy();
    expect(pay.body.payment.pixQrSvg).toContain('<svg');
    const [transactionId, charge] = [...env.provider.charges.entries()].find(([, c]) => c.input.externalId === pay.body.payment.id)!;
    expect(charge.input.amountCents).toBe(3980);
    expect(charge.input.postbackUrl).toContain('/api/webhooks/payment?token=');

    // Gerar de novo devolve a mesma cobrança (idempotente)
    const again = await player.request('POST', '/api/payments/create', { orderId: order.id });
    expect(again.body.payment.id).toBe(pay.body.payment.id);
    expect(env.provider.calls.create).toBe(1);

    // Webhook dizendo "PAID" antes do pagamento real: consulta no gateway mostra PENDING -> nada é liberado
    const early = await webhook(env.app, paidWebhookBody(transactionId, pay.body.payment.id, 39.8));
    expect(early.status).toBe(200);
    let view = await player.request('GET', `/api/store/orders/${order.id}`);
    expect(view.body.order.status).toBe('pending');
    expect((await env.db.query('SELECT COUNT(*)::int AS n FROM deliveries')).rows[0].n).toBe(0);

    // 4/5. Jogador paga; webhook chega; backend confirma no gateway
    env.provider.markPaid(transactionId);
    // Simula status diferente no corpo para gerar nova chave de deduplicação
    const body = paidWebhookBody(transactionId, pay.body.payment.id, 39.8);
    body.requestBody.status = 'paid';
    const hook = await webhook(env.app, body);
    expect(hook.status).toBe(200);
    expect(hook.body.reason).toBe('confirmed');

    view = await player.request('GET', `/api/store/orders/${order.id}`);
    expect(view.body.order.status).toBe('approved');
    expect(view.body.order.payment.status).toBe('paid');
    // Pagamento confirmado e entrega são estados independentes
    expect(view.body.order.delivery).toEqual({ status: 'waiting', total: 2, delivered: 0 });

    // 6. Idempotência: o mesmo webhook (replay) e reprocessamentos não duplicam nada
    const replay = await webhook(env.app, body);
    expect(replay.body.status).toBe('duplicate');
    await webhook(env.app, paidWebhookBody(transactionId, pay.body.payment.id, 39.8));
    const tx = await env.db.query(`SELECT type, COUNT(*)::int AS n FROM transactions WHERE order_id = $1 GROUP BY type`, [order.id]);
    const counts = Object.fromEntries(tx.rows.map((r) => [r.type, r.n]));
    // 7. Registro da venda
    expect(counts).toEqual({ charge_created: 1, payment_confirmed: 1 });

    // 8. Entregas criadas (uma por unidade), consumidas pelo servidor SA-MP
    const pending = await gameRequest(env.app, 'GET', '/api/game/deliveries?serverAccountId=5001');
    expect(pending.status).toBe(200);
    expect(pending.body.deliveries).toHaveLength(2);
    const first = pending.body.deliveries[0];
    expect(first.type).toBe('vip');
    expect(first.payload.params).toEqual({ tier: 'ouro' });
    expect(first.payload.duration_days).toBe(30);

    const claim = await gameRequest(env.app, 'POST', `/api/game/deliveries/${first.id}/claim`);
    expect(claim.body.claimed).toBe(true);
    const claimAgain = await gameRequest(env.app, 'POST', `/api/game/deliveries/${first.id}/claim`);
    expect(claimAgain.status).toBe(409);
    const done = await gameRequest(env.app, 'POST', `/api/game/deliveries/${first.id}/complete`, {});
    expect(done.body.alreadyDelivered).toBe(false);
    const doneAgain = await gameRequest(env.app, 'POST', `/api/game/deliveries/${first.id}/complete`, {});
    expect(doneAgain.body.alreadyDelivered).toBe(true);

    view = await player.request('GET', `/api/store/orders/${order.id}`);
    expect(view.body.order.delivery).toEqual({ status: 'partial', total: 2, delivered: 1 });

    const second = pending.body.deliveries[1];
    await gameRequest(env.app, 'POST', `/api/game/deliveries/${second.id}/claim`);
    await gameRequest(env.app, 'POST', `/api/game/deliveries/${second.id}/complete`, {});
    view = await player.request('GET', `/api/store/orders/${order.id}`);
    expect(view.body.order.status).toBe('delivered');
    expect(view.body.order.delivery.status).toBe('delivered');
  });

  it('webhooks simultâneos não liberam o benefício duas vezes', async () => {
    const admin = await adminClient(env.app);
    const { product } = await createCatalog(admin, { stock: null });
    const { player, gameAccountId } = await playerWithAccount(env.app, 'race1', '5002');
    const { order, payment, transactionId } = await orderAndPay(player, env.provider, product.id, gameAccountId, 3);
    env.provider.markPaid(transactionId);
    const bodies = ['PAID', 'Paid', 'paid ', 'PAID'].map((status) => {
      const b = paidWebhookBody(transactionId, payment.id, 59.7);
      b.requestBody.status = status;
      return b;
    });
    const results = await Promise.all([...bodies.map((b) => webhook(env.app, b)), player.request('GET', `/api/store/orders/${order.id}`)]);
    for (const r of results.slice(0, 4)) expect(r.status).toBe(200);
    const deliveries = await env.db.query('SELECT COUNT(*)::int AS n FROM deliveries WHERE order_id = $1', [order.id]);
    expect(deliveries.rows[0].n).toBe(3);
    const confirmed = await env.db.query(`SELECT COUNT(*)::int AS n FROM transactions WHERE order_id = $1 AND type = 'payment_confirmed'`, [order.id]);
    expect(confirmed.rows[0].n).toBe(1);
  });

  it('valor pago diferente do pedido não libera o benefício (fica em análise)', async () => {
    const admin = await adminClient(env.app);
    const { product } = await createCatalog(admin);
    const { player, gameAccountId } = await playerWithAccount(env.app, 'mismatch1', '5003');
    const { order, payment, transactionId } = await orderAndPay(player, env.provider, product.id, gameAccountId);
    env.provider.markPaid(transactionId, 100); // pagou R$ 1,00 em vez de R$ 19,90
    const hook = await webhook(env.app, paidWebhookBody(transactionId, payment.id, 1));
    expect(hook.body.reason).toBe('amount_mismatch');
    const view = await player.request('GET', `/api/store/orders/${order.id}`);
    expect(view.body.order.status).toBe('processing');
    expect(view.body.order.delivery.status).toBe('none');
  });

  it('polling do jogador reconcilia o pagamento quando o webhook se perde', async () => {
    const admin = await adminClient(env.app);
    const { product } = await createCatalog(admin);
    const { player, gameAccountId } = await playerWithAccount(env.app, 'poll1', '5004');
    const { order, payment, transactionId } = await orderAndPay(player, env.provider, product.id, gameAccountId);
    env.provider.markPaid(transactionId);
    const status = await player.request('GET', `/api/payments/${payment.id}/status`);
    expect(status.body.payment.status).toBe('paid');
    expect(status.body.orderStatus).toBe('approved');
    expect(status.body.delivery.status).toBe('waiting');
    const view = await player.request('GET', `/api/store/orders/${order.id}`);
    expect(view.body.order.status).toBe('approved');
  });

  it('pedido não pago expira, libera o estoque e pagamento tardio ainda é honrado', async () => {
    const admin = await adminClient(env.app);
    const { product } = await createCatalog(admin, { stock: 2 });
    const { player, gameAccountId } = await playerWithAccount(env.app, 'expire1', '5005');
    const { order, payment, transactionId } = await orderAndPay(player, env.provider, product.id, gameAccountId, 2);
    expect((await env.db.query('SELECT stock FROM products WHERE id = $1', [product.id])).rows[0].stock).toBe(0);

    await env.db.query(`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`, [order.id]);
    expect(await expireStaleOrders(env.ctx)).toBe(1);
    let view = await player.request('GET', `/api/store/orders/${order.id}`);
    expect(view.body.order.status).toBe('expired');
    expect(view.body.order.payment.status).toBe('expired');
    expect((await env.db.query('SELECT stock FROM products WHERE id = $1', [product.id])).rows[0].stock).toBe(2);

    // Não é possível gerar PIX para pedido expirado
    const pay = await player.request('POST', '/api/payments/create', { orderId: order.id });
    expect(pay.status).toBe(409);

    env.provider.markPaid(transactionId);
    const hook = await webhook(env.app, paidWebhookBody(transactionId, payment.id, 39.8));
    expect(hook.body.reason).toBe('confirmed');
    view = await player.request('GET', `/api/store/orders/${order.id}`);
    expect(view.body.order.status).toBe('approved');
    const late = await env.db.query(`SELECT COUNT(*)::int AS n FROM transactions WHERE order_id = $1 AND type = 'late_payment'`, [order.id]);
    expect(late.rows[0].n).toBe(1);
  });

  it('cancelamento pelo jogador devolve o estoque', async () => {
    const admin = await adminClient(env.app);
    const { product } = await createCatalog(admin, { stock: 1 });
    const { player, gameAccountId } = await playerWithAccount(env.app, 'cancel1', '5006');
    const { order } = await orderAndPay(player, env.provider, product.id, gameAccountId);
    const out = await player.request('POST', `/api/store/orders/${order.id}`, undefined);
    expect(out.status).toBe(404);
    const cancel = await player.request('POST', `/api/store/orders/${order.id}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect(cancel.body.order.status).toBe('cancelled');
    expect((await env.db.query('SELECT stock FROM products WHERE id = $1', [product.id])).rows[0].stock).toBe(1);
  });

  it('respeita estoque, quantidade máxima e disponibilidade', async () => {
    const admin = await adminClient(env.app);
    const { product } = await createCatalog(admin, { stock: 1, maxPerOrder: 5 });
    const { player, gameAccountId } = await playerWithAccount(env.app, 'stock1', '5007');
    const tooMany = await player.request('POST', '/api/store/orders', { items: [{ productId: product.id, quantity: 2 }], gameAccountId });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe('out_of_stock');

    const { product: limited } = await createCatalog(admin, { stock: null, maxPerOrder: 1 });
    const over = await player.request('POST', '/api/store/orders', { items: [{ productId: limited.id, quantity: 2 }], gameAccountId });
    expect(over.body.error.code).toBe('quantity_not_allowed');

    await admin.request('POST', `/api/admin/products/${limited.id}/status`, { isActive: false });
    const inactive = await player.request('POST', '/api/store/orders', { items: [{ productId: limited.id, quantity: 1 }], gameAccountId });
    expect(inactive.body.error.code).toBe('product_unavailable');
    const pub = await player.request('GET', `/api/store/products/${limited.id}`);
    expect(pub.status).toBe(404);
  });

  it('idempotencyKey evita pedidos duplicados por clique duplo', async () => {
    const admin = await adminClient(env.app);
    const { product } = await createCatalog(admin, { stock: null });
    const { player, gameAccountId } = await playerWithAccount(env.app, 'idem1', '5008');
    const body = { items: [{ productId: product.id, quantity: 1 }], gameAccountId, idempotencyKey: 'click-123456' };
    const [a, b] = await Promise.all([player.request('POST', '/api/store/orders', body), player.request('POST', '/api/store/orders', body)]);
    const ids = new Set([a, b].filter((r) => r.status === 201).map((r) => r.body.order.id));
    expect(ids.size).toBe(1);
    const n = await env.db.query(`SELECT COUNT(*)::int AS n FROM orders WHERE idempotency_key = 'click-123456'`);
    expect(n.rows[0].n).toBe(1);
  });
});
