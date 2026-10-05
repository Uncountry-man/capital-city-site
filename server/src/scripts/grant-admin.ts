// Uso: npm run admin:grant -- email@gmail.com
// O usuário precisa ter feito login no site ao menos uma vez.
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { writeAudit } from '../lib/audit.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Informe o e-mail: npm run admin:grant -- email@gmail.com');
  process.exit(1);
}
const config = loadConfig();
const db = createPool(config.databaseUrl, config.databaseSsl);
try {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE users SET role = 'admin', updated_at = now() WHERE lower(email) = $1 RETURNING id`,
    [email],
  );
  if (!rows[0]) {
    console.error('Usuário não encontrado. Faça login no site com esse e-mail primeiro.');
    process.exitCode = 1;
  } else {
    await writeAudit(db, { userId: null, label: 'cli' }, 'user.admin_granted', 'user', rows[0].id, { email });
    console.log(`${email} agora é administrador.`);
  }
} finally {
  await db.end();
}
