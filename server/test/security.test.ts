import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  Client,
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

describe('autorização e IDOR', () => {
  it('rotas da loja exigem login', async () => {
    const anon = new Client(env.app);
    expect((await anon.request('POST', '/api/store/orders', { items: [] })).status).toBe(401);
    expect((await anon.request('GET', '/api/store/orders')).status).toBe(401);
    expect((await anon.request('POST', '/api/payments/create', { orderId: crypto.randomUUID() })).status).toBe(401);
  });

  it('jogador não acessa pedido, pagamento nem conta de outro jogador', async () => {
    const admin = await adminClient(env.app);
    const { product } = await createCatalog(admin);
    const a = await playerWithAccount(env.app, 'idorA', '7001');
    const b = await playerWithAccount(env.app, 'idorB', '7002');
    const { order, payment } = await orderAndPay(a.player, env.provider, product.id, a.gameAccountId);

    expect((await b.player.request('GET', `/api/store/orders/${order.id}`)).status).toBe(404);
    expect((await b.player.request('POST', `/api/store/orders/${order.id}/cancel`, {})).status).toBe(404);
    expect((await b.player.request('GET', `/api/payments/${payment.id}/status`)).status).toBe(404);
    expect((await b.player.request('POST', '/api/payments/create', { orderId: order.id })).status).toBe(404);
    const list = await b.player.request('GET', '/api/store/orders');
    expect(list.body.orders).toHaveLength(0);

    // Comprar usando a conta do jogo de outra pessoa
    const steal = await b.player.request('POST', '/api/store/orders', { items: [{ productId: product.id, quantity: 1 }], gameAccountId: a.gameAccountId });
    expect(steal.status).toBe(400);
    expect(steal.body.error.code).toBe('game_account_required');

    // Desvincular conta alheia
    expect((await b.player.request('DELETE', `/api/me/game-accounts/${a.gameAccountId}`)).status).toBe(404);
  });

  it('IDs inválidos são rejeitados sem erro interno (sem enumeração por IDs sequenciais)', async () => {
    const { player } = await playerWithAccount(env.app, 'enum1', '7003');
    expect((await player.request('GET', '/api/store/orders/1')).status).toBe(400);
    expect((await player.request('GET', "/api/store/orders/1' OR '1'='1")).status).toBe(400);
  });

  it('painel administrativo exige papel de administrador', async () => {
    const { player } = await playerWithAccount(env.app, 'notadmin', '7004');
    const anon = new Client(env.app);
    for (const [method, url] of [
      ['GET', '/api/admin/dashboard'],
      ['GET', '/api/admin/orders'],
      ['GET', '/api/admin/products'],
      ['POST', '/api/admin/products'],
      ['GET', '/api/admin/audit'],
      ['POST', '/api/admin/uploads'],
    ] as const) {
      expect((await anon.request(method, url, method === 'POST' ? {} : undefined)).status).toBe(401);
      expect((await player.request(method, url, method === 'POST' ? {} : undefined)).status).toBe(403);
    }
  });
});

describe('CSRF e sessão', () => {
  it('bloqueia requisições com cookie vindas de outra origem', async () => {
    const { player, gameAccountId } = await playerWithAccount(env.app, 'csrf1', '7101');
    const evil = await player.request('POST', '/api/store/orders', { items: [], gameAccountId }, { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    const noOrigin = await player.request('POST', '/api/me/game-accounts/link-code', {}, { origin: '' });
    expect(noOrigin.status).toBe(403);
  });

  it('launcher pode usar token Bearer (sem cookie) e o logout invalida a sessão', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/google',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ credential: 'google:launcher1:l@player.test:padding', mode: 'token' }),
    });
    const token = JSON.parse(res.body).token as string;
    expect(token).toBeTruthy();
    const me = await env.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
    expect(JSON.parse(me.body).user.email).toBe('l@player.test');
    await env.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { authorization: `Bearer ${token}` } });
    const after = await env.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
    expect(JSON.parse(after.body).user).toBeNull();
    // O token não é guardado em texto puro
    const stored = await env.db.query('SELECT token_hash FROM sessions');
    expect(stored.rows.every((r) => r.token_hash !== token)).toBe(true);
  });

  it('login de desenvolvimento não existe fora do modo dev', async () => {
    const anon = new Client(env.app);
    expect((await anon.request('POST', '/api/auth/dev-login', { email: 'x@y.z', name: 'x' })).status).toBe(404);
  });

  it('login Google em modo redirect exige o double-submit g_csrf_token', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/google/redirect',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'credential=google%3Aredir%3Ar%40p.test%3Apadding&g_csrf_token=abc',
    });
    expect(res.statusCode).toBe(401);
    const ok = await env.app.inject({
      method: 'POST',
      url: '/api/auth/google/redirect',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'g_csrf_token=abc' },
      payload: 'credential=google%3Aredir%3Ar%40p.test%3Apadding&g_csrf_token=abc',
    });
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe('/store/#/conta');
  });
});

describe('webhook', () => {
  it('rejeita webhook sem o segredo correto e não altera nada', async () => {
    const admin = await adminClient(env.app);
    const { product } = await createCatalog(admin);
    const { player, gameAccountId } = await playerWithAccount(env.app, 'hook1', '7201');
    const { order, payment, transactionId } = await orderAndPay(player, env.provider, product.id, gameAccountId);
    env.provider.markPaid(transactionId);
    expect((await webhook(env.app, paidWebhookBody(transactionId, payment.id, 19.9), 'wrong')).status).toBe(401);
    const noToken = await env.app.inject({ method: 'POST', url: '/api/webhooks/payment', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(noToken.statusCode).toBe(401);
    const row = await env.db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    expect(row.rows[0].status).toBe('pending');
  });

  it('webhook com IDs divergentes ou transação desconhecida é ignorado', async () => {
    const admin = await adminClient(env.app);
    const { product } = await createCatalog(admin);
    const { player, gameAccountId } = await playerWithAccount(env.app, 'hook2', '7202');
    const { order, transactionId } = await orderAndPay(player, env.provider, product.id, gameAccountId);
    env.provider.markPaid(transactionId);
    const wrongExternal = await webhook(env.app, paidWebhookBody(transactionId, crypto.randomUUID(), 19.9));
    expect(wrongExternal.body.reason).toBe('external_id_divergente');
    const unknown = await webhook(env.app, paidWebhookBody('nao-existe', crypto.randomUUID(), 19.9));
    expect(unknown.body.reason).toBe('transacao_desconhecida');
    const invalid = await webhook(env.app, { foo: 'bar' });
    expect(invalid.body.reason).toBe('payload_invalido');
    expect((await env.db.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status).toBe('pending');
  });

  it('não guarda dados pessoais do pagador no log de webhooks', async () => {
    await webhook(env.app, { requestBody: { transactionId: 'pii-test', status: 'PAID', creditParty: { name: 'Fulano', taxId: '123', email: 'a@b.c' } } });
    const row = await env.db.query(`SELECT payload FROM webhook_events WHERE dedupe_key = 'pii-test:PAID'`);
    expect(JSON.stringify(row.rows[0].payload)).not.toContain('123');
    expect(JSON.stringify(row.rows[0].payload)).not.toContain('Fulano');
  });
});

describe('API do jogo', () => {
  it('exige a chave do servidor do jogo', async () => {
    expect((await gameRequest(env.app, 'GET', '/api/game/deliveries', undefined, 'errada')).status).toBe(401);
    expect((await gameRequest(env.app, 'GET', '/api/game/deliveries', undefined, '')).status).toBe(401);
  });

  it('vincula conta via código digitado no jogo; código é de uso único', async () => {
    const player = new Client(env.app);
    await player.login('link1', 'link1@player.test');
    const { body } = await player.request('POST', '/api/me/game-accounts/link-code', {});
    const link = await gameRequest(env.app, 'POST', '/api/game/accounts/link', { code: body.code, serverAccountId: '7301', nickname: 'Fulano_Tal' });
    expect(link.body.linked).toBe(true);
    const reuse = await gameRequest(env.app, 'POST', '/api/game/accounts/link', { code: body.code, serverAccountId: '7302', nickname: 'Outro' });
    expect(reuse.status).toBe(400);
    const me = await player.request('GET', '/api/me');
    expect(me.body.gameAccounts.map((g: { nickname: string }) => g.nickname)).toEqual(['Fulano_Tal']);

    // Outro usuário não consegue "roubar" a conta já vinculada
    const other = new Client(env.app);
    await other.login('link2', 'link2@player.test');
    const code2 = (await other.request('POST', '/api/me/game-accounts/link-code', {})).body.code;
    const steal = await gameRequest(env.app, 'POST', '/api/game/accounts/link', { code: code2, serverAccountId: '7301', nickname: 'X' });
    expect(steal.status).toBe(409);
  });
});

describe('segredos fora do cliente', () => {
  it('produção recusa configuração sem segredos ou com gateway simulado', () => {
    const base = { NODE_ENV: 'production', DATABASE_URL: 'postgres://x', PUBLIC_BASE_URL: 'https://capitalcityrp.com' };
    expect(() => loadConfig({ ...base, PAYMENT_PROVIDER: 'mock' })).toThrow(/Configuração de produção incompleta/);
    expect(() => loadConfig({ ...base, DEV_LOGIN: 'true' })).toThrow();
  });

  it('nenhum arquivo servido ao navegador contém credenciais privadas', () => {
    const repo = path.resolve(import.meta.dirname, '..', '..');
    const publicDirs = ['store', 'admin', 'js', 'css'].map((d) => path.join(repo, d));
    const files: string[] = [path.join(repo, 'index.html')];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    for (const dir of publicDirs) {
      try {
        walk(dir);
      } catch {
        /* pasta opcional */
      }
    }
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/PAYMENT_SECRET|PAYMENT_WEBHOOK_SECRET|GAME_API_KEY|client_secret|clientSecret/i);
    }
  });

  it('arquivos do servidor e do git não são servidos como estáticos', async () => {
    for (const url of ['/server/package.json', '/server/.env', '/.git/config', '/server/src/config.ts']) {
      const res = await env.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
    }
  });
});

describe('limite de requisições', () => {
  it('limita criação de pedidos por cliente', async () => {
    const { player, gameAccountId } = await playerWithAccount(env.app, 'rl1', '7401');
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      statuses.push((await player.request('POST', '/api/store/orders', { items: [{ productId: crypto.randomUUID(), quantity: 1 }], gameAccountId })).status);
    }
    expect(statuses).toContain(429);
  });
});
