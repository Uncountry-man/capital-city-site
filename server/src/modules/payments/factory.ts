import type { AppConfig } from '../../config.js';
import { BsPayProvider } from './bspay.js';
import { MockPaymentProvider } from './mock.js';
import type { PaymentProvider } from './provider.js';

export function createPaymentProvider(config: AppConfig): PaymentProvider {
  if (config.payment.provider === 'mock') return new MockPaymentProvider();
  return new BsPayProvider({
    baseUrl: config.payment.apiBaseUrl,
    clientId: config.payment.clientId,
    clientSecret: config.payment.secret,
  });
}
