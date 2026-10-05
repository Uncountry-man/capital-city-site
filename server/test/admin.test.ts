import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, createCatalog, gameRequest, orderAndPay, paidWebhookBody, playerWithAccount, setup, webhook, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setup();
});
afterAll(async () => {
  await env.close();
});

describe('painel administrativo', () => {
  it('valida parâmetros de entrega com formulário estruturado (sem JSON livre)', async () => {
    const admin = await adminClient(env.app);
    const { category } = await createCatalog(admin);
    const bad = await admin.request('POST', '/api/admin/products', {
      categoryId: category.id,
      name: 'Carro',
      priceCents: 5000,
      deliveryType: 'vehicle',
      deliveryParams: { model_id: 99 },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('Modelo (ID SA-MP)');

    const bundle = await admin.request('POST', '/api/admin/products', {
      categoryId: category.id,
      name: 'Pacote Inicial',
      priceCents: 9990,
      deliveryType: 'bundle',
      deliveryParams: { items: [{ type: 'coins', params: { amount: '50000' } }, { type: 'vehicle', params: { model_id: 411, color1: '' } }] },
    });
    expect(bundle.status).toBe(201);
    expect(bundle.body.product.deliveryParams).toEqual({
      items: [
        { type: 'coins', params: { amount: 50000 } },
        { type: 'vehicle', params: { model_id: 411 } },
      ],
    });

    const promo = await admin.request('POST', '/api/admin/products', {
      categoryId: category.id,
      name: 'Promo inválida',
      priceCents: 1000,
      promoPriceCents: 2000,
      deliveryType: 'coins',
      deliveryParams: { amount: 1 },
    });
    expect(promo.status).toBe(400);
  });

  it('registra auditoria de criação, alteração de preço, desativação e remoção', async () => {
    const admin = await adminClient(env.app);
    const { product } = await createCatalog(admin);
    const full = (await admin.request('GET', `/api/admin/products/${product.id}`)).body.product;
    const upd = await admin.request('PUT', `/api/admin/products/${product.id}`, { ...full, priceCents: 4990, promoPriceCents: null });
    expect(upd.status).toBe(200);
    await admin.request('POST', `/api/admin/products/${product.id}/status`, { isActive: false });
    const del = await admin.request('DELETE', `/api/admin/products/${product.id}`);
    expect(del.body.archived).toBe(false);

    const audit = await admin.request('GET', `/api/admin/audit?entityType=product&entityId=${product.id}`);
    const actions = audit.body.logs.map((l: { action: string }) => l.action);
    expect(actions).toEqual(['product.removed', 'product.deactivated', 'product.price_changed', 'product.created']);
    const priceLog = audit.body.logs.find((l: { action: string }) => l.action === 'product.price_changed');
    expect(priceLog.data.changes.price_cents).toEqual({ from: 2990, to: 4990 });
    expect(priceLog.actor_label).toBe('admin@capital.test');
  });

  it('produto já vendido é arquivado (não apagado) para manter o histórico', async () => {
    const admin = await adminClient(env.app);
    const { product } = await createCatalog(admin);
    const { player, gameAccountId } = await playerWithAccount(env.app, 'arch1', '8001');
    await orderAndPay(player, env.provider, product.id, gameAccountId);
    const del = await admin.request('DELETE', `/api/admin/products/${product.id}`);
    expect(del.body.archived).toBe(true);
    const row = await env.db.query('SELECT deleted_at, is_active FROM products WHERE id = $1', [product.id]);
    expect(row.rows[0].deleted_at).not.toBeNull();
    expect(row.rows[0].is_active).toBe(false);
  });

  it('dashboard, listagem com filtros, detalhe, entrega manual e reembolso', async () => {
    const admin = await adminClient(env.app);
    const { product } = await createCatalog(admin, { stock: null });
    const { player, gameAccountId } = await playerWithAccount(env.app, 'sales1', '8002');
    const { order, payment, transactionId } = await orderAndPay(player, env.provider, product.id, gameAccountId, 2);
    env.provider.markPaid(transactionId);
    await webhook(env.app, paidWebhookBody(transactionId, payment.id, 39.8));

    const dash = await admin.request('GET', '/api/admin/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body.revenue.total).toBeGreaterThanOrEqual(3980);
    expect(dash.body.sales.today).toBeGreaterThanOrEqual(1);
    expect(dash.body.topProducts.length).toBeGreaterThan(0);
    expect(dash.body.averageTicketCents).toBeGreaterThan(0);

    const list = await admin.request('GET', `/api/admin/orders?status=approved&q=Nick_sales1&productId=${product.id}`);
    expect(list.body.total).toBe(1);
    expect(list.body.orders[0].id).toBe(order.id);
    const byTx = await admin.request('GET', `/api/admin/orders?q=${transactionId}`);
    expect(byTx.body.total).toBe(1);

    const detail = await admin.request('GET', `/api/admin/orders/${order.id}`);
    expect(detail.body.order.payments[0].transactionId).toBe(transactionId);
    expect(detail.body.order.payments[0].providerStatus).toBe('PAID');
    expect(detail.body.order.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(['created', 'payment_created', 'status_changed']),
    );
    expect(detail.body.order.deliveries).toHaveLength(2);

    // Entrega manual de uma unidade
    const d1 = detail.body.order.deliveries[0].id;
    const manual = await admin.request('POST', `/api/admin/deliveries/${d1}/deliver`, { reason: 'Entregue via comando no jogo' });
    expect(manual.body.order.delivery.delivered).toBe(1);

    // Reembolso cancela a entrega restante; o jogo não recebe mais o benefício
    const refund = await admin.request('POST', `/api/admin/orders/${order.id}/refund`, { reason: 'Estorno solicitado pelo jogador' });
    expect(refund.body.order.status).toBe('refunded');
    const pending = await gameRequest(env.app, 'GET', '/api/game/deliveries?serverAccountId=8002');
    expect(pending.body.deliveries).toHaveLength(0);
    const actions = (await admin.request('GET', '/api/admin/audit')).body.logs.map((l: { action: string }) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['order.refunded', 'delivery.manual']));

    // Reembolso não pode ser registrado duas vezes
    const again = await admin.request('POST', `/api/admin/orders/${order.id}/refund`, { reason: 'de novo' });
    expect(again.status).toBe(409);
  });

  it('pedido em análise (valor divergente) pode ser aprovado manualmente', async () => {
    const admin = await adminClient(env.app);
    const { product } = await createCatalog(admin);
    const { player, gameAccountId } = await playerWithAccount(env.app, 'review1', '8003');
    const { order, payment, transactionId } = await orderAndPay(player, env.provider, product.id, gameAccountId);
    env.provider.markPaid(transactionId, 2000);
    await webhook(env.app, paidWebhookBody(transactionId, payment.id, 20));
    const approve = await admin.request('POST', `/api/admin/orders/${order.id}/approve`, { reason: 'Conferido no extrato' });
    expect(approve.body.order.status).toBe('approved');
    expect(approve.body.order.deliveries).toHaveLength(1);
  });

  it('upload converte a imagem para WebP e recusa arquivos que não são imagem', async () => {
    const admin = await adminClient(env.app);
    const png = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#0ea5e9' } }).png().toBuffer();
    const boundary = '----cc';
    const form = (name: string, type: string, data: Buffer) =>
      Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
    const up = await env.app.inject({
      method: 'POST',
      url: '/api/admin/uploads',
      remoteAddress: admin.ip,
      headers: { origin: 'http://store.test', cookie: admin.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: form('a.png', 'image/png', png),
    });
    expect(up.statusCode).toBe(201);
    const url = JSON.parse(up.body).url as string;
    expect(url).toMatch(/^\/uploads\/.+\.webp$/);
    const img = await env.app.inject({ method: 'GET', url });
    expect(img.statusCode).toBe(200);
    const meta = await sharp(img.rawPayload).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(1200);

    const evil = await env.app.inject({
      method: 'POST',
      url: '/api/admin/uploads',
      remoteAddress: admin.ip,
      headers: { origin: 'http://store.test', cookie: admin.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: form('x.png', 'image/png', Buffer.from('<script>alert(1)</script>')),
    });
    expect(evil.statusCode).toBe(400);
  });
});
