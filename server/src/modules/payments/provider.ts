/**
 * Contrato comum para gateways de pagamento. A loja depende apenas desta interface,
 * o que permite adicionar outros gateways (ou outros métodos além de PIX) sem mexer no fluxo de pedidos.
 */
export type ProviderPaymentStatus = 'pending' | 'paid' | 'unknown';

export interface CreatePixChargeInput {
  externalId: string;
  amountCents: number;
  description: string;
  payer: { name: string; email: string | null };
  postbackUrl: string;
}

export interface CreatePixChargeResult {
  transactionId: string;
  pixCopyPaste: string;
  providerStatus: string;
}

export interface ProviderTransaction {
  transactionId: string;
  externalId: string | null;
  amountCents: number | null;
  status: ProviderPaymentStatus;
  providerStatus: string;
}

export interface WebhookNotification {
  transactionId: string;
  externalId: string | null;
  providerStatus: string;
}

export interface PaymentProvider {
  readonly name: string;
  createPixCharge(input: CreatePixChargeInput): Promise<CreatePixChargeResult>;
  /** Consulta a situação real da transação diretamente no gateway (fonte de verdade). */
  getTransaction(transactionId: string): Promise<ProviderTransaction | null>;
  /** Extrai os identificadores do corpo do webhook. Nada aqui é confiável até ser confirmado por getTransaction. */
  parseWebhook(body: unknown): WebhookNotification | null;
}

export class PaymentProviderError extends Error {
  constructor(message: string, public readonly httpStatus?: number) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}
