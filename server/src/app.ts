import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from './config.js';
import type { AppContext } from './context.js';
import type { Db } from './db/pool.js';
import type { GoogleVerifier } from './auth/google.js';
import { registerAuth } from './auth/plugin.js';
import { AppError } from './lib/errors.js';
import { accountRoutes } from './modules/accounts/routes.js';
import { catalogAdminRoutes } from './modules/admin/catalog-admin.js';
import { salesAdminRoutes } from './modules/admin/sales-admin.js';
import { MAX_UPLOAD_BYTES, uploadRoutes } from './modules/admin/uploads.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { gameRoutes } from './modules/deliveries/game-routes.js';
import { orderRoutes } from './modules/orders/routes.js';
import type { PaymentProvider } from './modules/payments/provider.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Pastas do repositório que NÃO podem ser servidas como arquivos estáticos.
const BLOCKED_STATIC = /^\/(server|skills|rules|node_modules|\.)/;

// CSP estrita para a loja e o painel (o site institucional mantém seu comportamento atual).
const STORE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.cdnfonts.com https://accounts.google.com/gsi/style",
  "font-src 'self' data: https://fonts.gstatic.com https://fonts.cdnfonts.com",
  "img-src 'self' data: https:",
  "connect-src 'self' https://accounts.google.com/gsi/",
  'frame-src https://accounts.google.com/gsi/',
  "form-action 'self' https://accounts.google.com",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join('; ');

export interface BuildOptions {
  config: AppConfig;
  db: Db;
  verifyGoogleToken: GoogleVerifier;
  paymentProvider: PaymentProvider;
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const { config } = opts;
  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    logger: opts.logger === false
      ? false
      : {
          level: config.logLevel,
          // Nunca registrar credenciais, cookies ou segredos (o token do webhook vai na query string).
          redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-game-api-key"]'],
          serializers: {
            req: (req) => ({ method: req.method, url: req.url.split('?')[0], ip: req.ip }),
          },
        },
  });

  const ctx: AppContext = {
    config,
    db: opts.db,
    verifyGoogleToken: opts.verifyGoogleToken,
    paymentProvider: opts.paymentProvider,
    log: app.log,
  };

  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    allowList: (req) => !req.url.startsWith('/api/'),
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: { code: 'rate_limited', message: `Muitas requisições. Tente novamente em ${context.after}.` },
    }),
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const url = req.url;
    if (url.startsWith('/store') || url.startsWith('/admin') || url.startsWith('/api/')) {
      reply.header('Content-Security-Policy', STORE_CSP);
    }
    if (url.startsWith('/admin') || url.startsWith('/api/admin')) {
      reply.header('X-Robots-Tag', 'noindex, nofollow');
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = err.statusCode ?? 500;
    if (status === 429) return reply.code(429).send(err);
    if (status < 500) {
      const messages: Record<number, string> = {
        400: 'Requisição inválida.',
        404: 'Não encontrado.',
        413: 'Conteúdo muito grande.',
        415: 'Formato não suportado.',
      };
      return reply.code(status).send({ error: { code: err.code ?? 'bad_request', message: messages[status] ?? 'Requisição inválida.' } });
    }
    req.log.error({ err }, 'erro inesperado');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Erro interno. Tente novamente.' } });
  });

  registerAuth(app, ctx);

  app.get('/api/health', async () => {
    await ctx.db.query('SELECT 1');
    return { ok: true };
  });

  catalogRoutes(app, ctx);
  orderRoutes(app, ctx);
  accountRoutes(app, ctx);
  gameRoutes(app, ctx);
  catalogAdminRoutes(app, ctx);
  salesAdminRoutes(app, ctx);
  uploadRoutes(app, ctx);

  // Arquivos estáticos: site atual + loja (/store) + painel (/admin) servidos pela mesma origem da API,
  // o que mantém o cookie de sessão first-party (funciona em WebView e Safari).
  await app.register(fastifyStatic, {
    root: config.staticRoot ? path.resolve(config.staticRoot) : REPO_ROOT,
    allowedPath: (pathName) => !BLOCKED_STATIC.test(pathName),
    dotfiles: 'deny',
    index: ['index.html'],
    redirect: true,
    maxAge: config.isProduction ? '1h' : 0,
  });
  mkdirSync(path.resolve(config.uploadDir), { recursive: true });
  await app.register(fastifyStatic, {
    root: path.resolve(config.uploadDir),
    prefix: '/uploads/',
    decorateReply: false,
    dotfiles: 'deny',
    immutable: true,
    maxAge: '365d',
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Rota não encontrada.' } });
    }
    return reply.code(404).type('text/plain; charset=utf-8').send('Página não encontrada.');
  });

  return app;
}
