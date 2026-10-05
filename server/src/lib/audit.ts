import type { Queryable } from '../db/pool.js';

export interface AuditActor {
  userId: string | null;
  label: string;
  ip?: string | null;
}

export async function writeAudit(
  db: Queryable,
  actor: AuditActor,
  action: string,
  entityType: string,
  entityId: string | null,
  data: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (actor_user_id, actor_label, action, entity_type, entity_id, data, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor.userId, actor.label, action, entityType, entityId, JSON.stringify(data), actor.ip ?? null],
  );
}

/** Retorna apenas os campos alterados entre dois objetos (para registrar "antes/depois" na auditoria). */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) changes[key] = { from: a ?? null, to: b ?? null };
  }
  return changes;
}
