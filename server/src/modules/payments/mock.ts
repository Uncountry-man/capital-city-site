import { randomUUID } from 'node:crypto';
import type {
  CreatePixChargeInput,
  CreatePixChargeResult,
  PaymentProvider,
  ProviderTransaction,
  WebhookNotification,
} from './provider.js';

/**
 * Gateway simulado, usado apenas nos testes automatizados e em desenvolvimento local.
 * A configuração de produção recusa PAYMENT_PROVIDER=mock.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly charges = new Map<string, { input: CreatePixChargeInput; status: 'PENDING' | 'PAID'; amountCents: number }>();
  calls = { create: 0, get: 0 };

  async createPixCharge(input: CreatePixChargeInput): Promise<CreatePixChargeResult> {
    this.calls.create++;
    const transactionId = `mock_${randomUUID().replace(/-/g, '')}`;
    this.charges.set(transactionId, { input, status: 'PENDING', amountCents: input.amountCents });
    return {
      transactionId,
      pixCopyPaste: `00020126MOCKPIX${transactionId}5204000053039865802BR6304ABCD`,
      providerStatus: 'PENDING',
    };
  }

  /** Simula o jogador pagando (opcionalmente com valor diferente, para testar divergências). */
  markPaid(transactionId: string, amountCents?: number): void {
    const charge = this.charges.get(transactionId);
    if (!charge) throw new Error('cobrança inexistente');
    charge.status = 'PAID';
    if (amountCents !== undefined) charge.amountCents = amountCents;
  }

  async getTransaction(transactionId: string): Promise<ProviderTransaction | null> {
    this.calls.get++;
    const charge = this.charges.get(transactionId);
    if (!charge) return null;
    return {
      transactionId,
      externalId: charge.input.externalId,
      amountCents: charge.amountCents,
      status: charge.status === 'PAID' ? 'paid' : 'pending',
      providerStatus: charge.status,
    };
  }

  parseWebhook(body: unknown): WebhookNotification | null {
    const b = body as { requestBody?: { transactionId?: string; external_id?: string; status?: string } } | null;
    const data = b?.requestBody;
    if (!data?.transactionId) return null;
    return { transactionId: data.transactionId, externalId: data.external_id ?? null, providerStatus: data.status ?? '' };
  }
}
