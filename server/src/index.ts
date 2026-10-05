import { buildApp } from './app.js';
import { createGoogleVerifier } from './auth/google.js';
import { loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { startJobs } from './jobs/scheduler.js';
import { createPaymentProvider } from './modules/payments/factory.js';

const config = loadConfig();
const db = createPool(config.databaseUrl, config.databaseSsl);
const verifyGoogleToken = createGoogleVerifier(config.googleClientIds);
const paymentProvider = createPaymentProvider(config);
const app = await buildApp({ config, db, verifyGoogleToken, paymentProvider });

await runMigrations(db, (m) => app.log.info(m));
const stopJobs = config.jobsEnabled
  ? startJobs({ config, db, verifyGoogleToken, paymentProvider, log: app.log })
  : () => undefined;

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'encerrando');
  stopJobs();
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
