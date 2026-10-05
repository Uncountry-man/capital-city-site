import { centsToDecimal, decimalToCents } from '../../lib/money.js';
import {
  PaymentProviderError,
  type CreatePixChargeInput,
  type CreatePixChargeResult,
  type PaymentProvider,
  type ProviderPaymentStatus,
  type ProviderTransaction,
  type WebhookNotification,
} from './provider.js';

/**
 * Integração com a API da BSPay (https://bspay.readme.io/reference).
 *
 * - POST /v2/oauth/token          Basic base64(client_id:client_secret) -> { access_token, expires_in }
 * - POST /v2/pix/qrcode           Bearer -> { transactionId, external_id, status, amount, qrcode, ... }
 * - POST /v2/consult-transaction  Bearer { pix_id } -> { requestBody: { transactionId, status, amount, ... } }
 * - Webhook (postbackUrl)         { requestBody: { transactionType, transactionId, external_id, amount, status, ... } }
 *
 * A documentação não descreve assinatura de webhook, por isso o webhook nunca é tratado como verdade:
 * ele apenas dispara uma nova consulta autenticada em /v2/consult-transaction.
 */
export interface BsPayOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** As respostas e webhooks da BSPay podem vir embrulhados em { requestBody: {...} }. */
const unwrap = (v: unknown): Json | null => (isObject(v) ? (isObject(v.requestBody) ? v.requestBody : v) : null);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : null);

export function mapBsPayStatus(status: string | null): ProviderPaymentStatus {
  switch ((status ?? '').toUpperCase()) {
    case 'PAID':
      return 'paid';
    case 'PENDING':
      return 'pending';
    default:
      // Status não documentados não disparam nenhuma transição automática; ficam registrados para análise.
      return 'unknown';
  }
}

export class BsPayProvider implements PaymentProvider {
  readonly name = 'bspay';
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: BsPayOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(path: string, init: { headers: Record<string, string>; body?: unknown }): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...init.headers },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new PaymentProviderError(`Falha de rede ao chamar o gateway (${path}): ${(err as Error).message}`);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      // Nunca incluímos headers (credenciais) na mensagem de erro.
      const message = isObject(data) && typeof data.message === 'string' ? data.message : `HTTP ${res.status}`;
      throw new PaymentProviderError(`Gateway respondeu erro em ${path}: ${message}`, res.status);
    }
    return data;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    if (!this.options.clientId || !this.options.clientSecret) {
      throw new PaymentProviderError('Credenciais do gateway não configuradas (PAYMENT_CLIENT_ID / PAYMENT_SECRET).');
    }
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString('base64');
    const data = await this.request('/v2/oauth/token', { headers: { Authorization: `Basic ${basic}` } });
    const token = isObject(data) ? str(data.access_token) : null;
    if (!token) throw new PaymentProviderError('Gateway não retornou access_token.');
    const expiresIn = isObject(data) && typeof data.expires_in === 'number' ? data.expires_in : 1800;
    // Renova 60s antes de expirar.
    this.token = { value: token, expiresAt: Date.now() + Math.max(expiresIn - 60, 30) * 1000 };
    return token;
  }

  private async authed(path: string, body: unknown): Promise<unknown> {
    const token = await this.accessToken();
    try {
      return await this.request(path, { headers: { Authorization: `Bearer ${token}` }, body });
    } catch (err) {
      if (err instanceof PaymentProviderError && err.httpStatus === 401) {
        this.token = null;
        const fresh = await this.accessToken();
        return this.request(path, { headers: { Authorization: `Bearer ${fresh}` }, body });
      }
      throw err;
    }
  }

  async createPixCharge(input: CreatePixChargeInput): Promise<CreatePixChargeResult> {
    const data = unwrap(
      await this.authed('/v2/pix/qrcode', {
        amount: centsToDecimal(input.amountCents),
        external_id: input.externalId,
        payerQuestion: input.description,
        payer: { name: input.payer.name, ...(input.payer.email ? { email: input.payer.email } : {}) },
        postbackUrl: input.postbackUrl,
      }),
    );
    const transactionId = data ? str(data.transactionId) : null;
    const qrcode = data ? str(data.qrcode) : null;
    if (!data || !transactionId || !qrcode) throw new PaymentProviderError('Resposta inesperada ao gerar o PIX.');
    return { transactionId, pixCopyPaste: qrcode, providerStatus: str(data.status) ?? 'PENDING' };
  }

  async getTransaction(transactionId: string): Promise<ProviderTransaction | null> {
    let raw: unknown;
    try {
      // A documentação mostra o campo como "pix_id" no texto e "pix_Id" no exemplo; enviamos ambos.
      raw = await this.authed('/v2/consult-transaction', { pix_id: transactionId, pix_Id: transactionId });
    } catch (err) {
      if (err instanceof PaymentProviderError && (err.httpStatus === 400 || err.httpStatus === 404)) return null;
      throw err;
    }
    const data = unwrap(raw);
    const id = data ? str(data.transactionId) : null;
    if (!data || !id) return null;
    const providerStatus = str(data.status) ?? '';
    return {
      transactionId: id,
      externalId: str(data.external_id),
      amountCents: decimalToCents(data.amount),
      status: mapBsPayStatus(providerStatus),
      providerStatus,
    };
  }

  parseWebhook(body: unknown): WebhookNotification | null {
    const data = unwrap(body);
    const transactionId = data ? str(data.transactionId) : null;
    if (!data || !transactionId || transactionId.length > 200) return null;
    return { transactionId, externalId: str(data.external_id), providerStatus: str(data.status) ?? '' };
  }
}
