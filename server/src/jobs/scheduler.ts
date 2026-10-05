import type { AppContext } from '../context.js';
import { expireStaleOrders } from '../modules/payments/service.js';

/** Tarefas periódicas: expirar pedidos não pagos e limpar sessões/códigos vencidos. */
export function startJobs(ctx: AppContext): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const expired = await expireStaleOrders(ctx);
      if (expired) ctx.log.info({ expired }, 'pedidos expirados');
      await ctx.db.query(`DELETE FROM sessions WHERE expires_at < now()`);
      await ctx.db.query(`DELETE FROM link_codes WHERE expires_at < now() - interval '1 day'`);
    } catch (err) {
      ctx.log.error({ err: (err as Error).message }, 'falha nas tarefas periódicas');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
