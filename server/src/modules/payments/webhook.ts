import type { AppContext } from '../../context.js';
import { AppError, forbidden, unauthorized } from '../../lib/errors.js';
import { ipAllowed, safeEqual } from '../../lib/security.js';
import { applyProviderResult, type PaymentRow } from './service.js';

export type WebhookResult = { status: 'processed' | 'ignored' | 'duplicate'; reason?: string };

/** Remove dados pessoais do pagador antes de guardar o payload bruto do webhook. */
function sanitizePayload(body: unknown): unknown {
  return JSON.parse(
    JSON.stringify(body ?? null, (key, value) =>
      ['creditParty', 'debitParty', 'payer', 'taxId', 'document', 'email', 'payerName'].includes(key) ? '[removido]' : value,
    ),
  );
}

/**
 * Processa a notificação do gateway:
 * 1. autentica pelo segredo da URL (e opcionalmente IP);
 * 2. registra o evento com chave de deduplicação (bloqueia replay);
 * 3. localiza o pagamento interno pelos IDs;
 * 4. consulta a transação no gateway (fonte de verdade) e só então atualiza pedido/entregas.
 */
export async function handlePaymentWebhook(
  ctx: AppContext,
  input: { token: string | undefined; ip: string; body: unknown },
): Promise<WebhookResult> {
  const secret = ctx.config.payment.webhookSecret;
  if (!secret || !input.token || !safeEqual(input.token, secret)) throw unauthorized('Webhook não autorizado.');
  if (!ipAllowed(input.ip, ctx.config.payment.webhookAllowedIps)) throw forbidden('IP não autorizado.');

  const provider = ctx.paymentProvider;
  const note = provider.parseWebhook(input.body);
  if (!note) return { status: 'ignored', reason: 'payload_invalido' };

  const dedupeKey = `${note.transactionId}:${note.providerStatus.toUpperCase()}`;
  const { rows: events } = await ctx.db.query<{ id: number; status: string; inserted: boolean }>(
    `INSERT INTO webhook_events (provider, dedupe_key, payload) VALUES ($1, $2, $3)
     ON CONFLICT (provider, dedupe_key) DO UPDATE SET attempts = webhook_events.attempts + 1
     RETURNING id, status, (xmax = 0) AS inserted`,
    [provider.name, dedupeKey, JSON.stringify(sanitizePayload(input.body))],
  );
  const event = events[0]!;
  if (!event.inserted && (event.status === 'processed' || event.status === 'ignored')) {
    return { status: 'duplicate' };
  }

  // "received" mantém o evento reprocessável: um aviso precoce/forjado não pode bloquear o aviso verdadeiro.
  const finish = (status: 'processed' | 'ignored' | 'received' | 'error', error?: string) =>
    ctx.db.query(`UPDATE webhook_events SET status = $2, error = $3, processed_at = now() WHERE id = $1`, [
      event.id,
      status,
      error ?? null,
    ]);

  try {
    const { rows } = await ctx.db.query<PaymentRow>(
      'SELECT * FROM payments WHERE provider = $1 AND provider_transaction_id = $2',
      [provider.name, note.transactionId],
    );
    const payment = rows[0];
    if (!payment) {
      await finish('received', 'transação desconhecida');
      return { status: 'ignored', reason: 'transacao_desconhecida' };
    }
    if (note.externalId && note.externalId !== payment.id) {
      await finish('received', 'external_id não corresponde ao pagamento');
      return { status: 'ignored', reason: 'external_id_divergente' };
    }

    const remote = await provider.getTransaction(note.transactionId);
    if (!remote) throw new Error('transação não encontrada na consulta ao gateway');
    const outcome = await applyProviderResult(ctx, payment.id, remote, 'webhook');
    if (outcome === 'not_paid' || outcome === 'mismatch') {
      await finish('received', outcome);
      return { status: 'ignored', reason: outcome };
    }
    await finish('processed', outcome === 'amount_mismatch' ? outcome : undefined);
    return { status: 'processed', reason: outcome };
  } catch (err) {
    const message = (err as Error).message ?? 'erro';
    await finish('error', message.slice(0, 500));
    ctx.log.error({ err: message, eventId: event.id }, 'erro ao processar webhook de pagamento');
    // 5xx faz o gateway reenviar; o evento com status "error" pode ser reprocessado.
    throw new AppError(500, 'webhook_processing_error', 'Erro ao processar o webhook.');
  }
}
