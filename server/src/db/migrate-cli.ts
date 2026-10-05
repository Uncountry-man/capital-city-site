import { loadConfig } from '../config.js';
import { createPool } from './pool.js';
import { runMigrations } from './migrate.js';

const config = loadConfig();
const db = createPool(config.databaseUrl, config.databaseSsl);
try {
  await runMigrations(db, (m) => console.log(m));
  console.log('Banco atualizado.');
} finally {
  await db.end();
}
