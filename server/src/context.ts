import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config.js';
import type { Db } from './db/pool.js';
import type { GoogleVerifier } from './auth/google.js';
import type { PaymentProvider } from './modules/payments/provider.js';

/** Dependências compartilhadas por todas as rotas e serviços (injeção simples, facilita testes). */
export interface AppContext {
  config: AppConfig;
  db: Db;
  verifyGoogleToken: GoogleVerifier;
  paymentProvider: PaymentProvider;
  log: FastifyBaseLogger;
}
