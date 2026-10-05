import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import type { GoogleProfile } from '../src/auth/google.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool, type Db } from '../src/db/pool.js';
import { unauthorized } from '../src/lib/errors.js';
import { MockPaymentProvider } from '../src/modules/payments/mock.js';

export const ORIGIN = 'http://store.test';
export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789abcdef';
export const GAME_KEY = 'test-game-key-0123456789abcdef0123';

export interface TestEnv {
  app: FastifyInstance;
  db: Db;
  config: AppConfig;
  provider: MockPaymentProvider;
  ctx: AppContext;
  close: () => Promise<void>;
}

/** Sobe a aplicação real contra um banco PostgreSQL de teste recriado do zero. */
export async function setup(): Promise<TestEnv> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://cc:cc@localhost:5432/cc_test',
    PUBLIC_BASE_URL: ORIGIN,
    PAYMENT_PROVIDER: 'mock',
    PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GAME_API_KEY: GAME_KEY,
    GOOGLE_CLIENT_IDS: 'test-client-id',
    ADMIN_EMAILS: 'admin@capital.test',
    UPLOAD_DIR: '/tmp/cc-test-uploads',
    LOG_LEVEL: 'silent',
    JOBS_ENABLED: 'false',
  });
  const db = createPool(config.databaseUrl, false);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(db);
  const provider = new MockPaymentProvider();
  // Tokens Google simulados no formato "google:<sub>:<email>".
  const verifyGoogleToken = async (token: string): Promise<GoogleProfile> => {
    const [kind, sub, email] = token.split(':');
    if (kind !== 'google' || !sub || !email) throw unauthorized('token inválido');
    return { sub, email, emailVerified: true, name: email.split('@')[0]!, picture: null };
  };
  const app = await buildApp({ config, db, verifyGoogleToken, paymentProvider: provider, logger: false });
  await app.ready();
  const ctx: AppContext = { config, db, verifyGoogleToken, paymentProvider: provider, log: app.log };
  return {
    app,
    db,
    config,
    provider,
    ctx,
    close: async () => {
      await app.close();
      await db.end();
    },
  };
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Cliente que imita o navegador: guarda o cookie de sessão e envia o header Origin. */
export class Client {
  cookie = '';
  // IP próprio por cliente, para que os limites de requisição por IP se comportem como em produção.
  readonly ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
  constructor(private readonly app: FastifyInstance) {}

  login(sub: string, email: string) {
    return this.request('POST', '/api/auth/google', { credential: `google:${sub}:${email}:padding-for-length` });
  }

  async request(method: InjectOptions['method'], url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method,
      url,
      remoteAddress: this.ip,
      headers: {
        origin: ORIGIN,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.cookies.find((c) => c.name === 'cc_session');
    if (set) this.cookie = set.value ? `cc_session=${set.value}` : '';
    return { status: res.statusCode, body: res.body ? safeJson(res.body) : null };
  }
}

export async function gameRequest(app: FastifyInstance, method: InjectOptions['method'], url: string, body?: unknown, key = GAME_KEY) {
  const res = await app.inject({
    method,
    url,
    headers: { 'x-game-api-key': key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.body ? safeJson(res.body) : null };
}

export async function webhook(app: FastifyInstance, body: unknown, token = WEBHOOK_SECRET) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/webhooks/payment?token=${encodeURIComponent(token)}`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, body: safeJson(res.body) };
}

/** Corpo de webhook no formato documentado pela BSPay. */
export const paidWebhookBody = (transactionId: string, externalId: string, amount: number) => ({
  requestBody: {
    transactionType: 'RECEIVEPIX',
    transactionId,
    external_id: externalId,
    amount,
    paymentType: 'PIX',
    status: 'PAID',
    dateApproval: '2026-10-05 16:07:10',
  },
});

export async function adminClient(app: FastifyInstance) {
  const admin = new Client(app);
  const res = await admin.login('admin-sub', 'admin@capital.test');
  if (res.body?.user?.role !== 'admin') throw new Error('admin não promovido');
  return admin;
}

export async function createCatalog(admin: Client, overrides: Record<string, unknown> = {}) {
  const cat = await admin.request('POST', '/api/admin/categories', { name: `VIP ${Math.random().toString(36).slice(2, 7)}`, icon: 'crown' });
  const product = await admin.request('POST', '/api/admin/products', {
    categoryId: cat.body.category.id,
    name: `VIP Ouro ${Math.random().toString(36).slice(2, 7)}`,
    priceCents: 2990,
    promoPriceCents: 1990,
    maxPerOrder: 3,
    stock: 5,
    benefits: ['Tag VIP'],
    durationDays: 30,
    deliveryType: 'vip',
    deliveryParams: { tier: 'ouro' },
    ...overrides,
  });
  if (product.status !== 201) throw new Error(`falha ao criar produto: ${JSON.stringify(product.body)}`);
  return { category: cat.body.category, product: product.body.product };
}

/** Jogador logado e com conta do jogo vinculada (via sincronização do servidor com o Google ID). */
export async function playerWithAccount(app: FastifyInstance, sub: string, serverAccountId: string) {
  const player = new Client(app);
  await player.login(sub, `${sub}@player.test`);
  await gameRequest(app, 'POST', '/api/game/accounts/sync', { serverAccountId, nickname: `Nick_${sub}`, googleSub: sub });
  const me = await player.request('GET', '/api/me');
  return { player, gameAccountId: me.body.gameAccounts[0].id as string };
}

/** Cria pedido + cobrança PIX e devolve os IDs úteis para os testes. */
export async function orderAndPay(player: Client, provider: MockPaymentProvider, productId: string, gameAccountId: string, quantity = 1) {
  const order = await player.request('POST', '/api/store/orders', { items: [{ productId, quantity }], gameAccountId });
  if (order.status !== 201) throw new Error(`pedido falhou: ${JSON.stringify(order.body)}`);
  const pay = await player.request('POST', '/api/payments/create', { orderId: order.body.order.id });
  if (pay.status !== 201) throw new Error(`pagamento falhou: ${JSON.stringify(pay.body)}`);
  const transactionId = [...provider.charges.entries()].find(([, c]) => c.input.externalId === pay.body.payment.id)![0];
  return { order: order.body.order, payment: pay.body.payment, transactionId };
}
