import pg from 'pg';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
/** Qualquer objeto capaz de executar queries: o pool ou um client dentro de uma transação. */
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

// int8 (bigint/COUNT/SUM) chega como string por padrão; nossos valores cabem com folga em Number.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

export function createPool(databaseUrl: string, ssl: boolean): Db {
  return new pg.Pool({
    connectionString: databaseUrl,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}

/** Executa `fn` dentro de uma transação, com rollback automático em caso de erro. */
export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
