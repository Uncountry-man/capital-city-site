import { z } from 'zod';

const csv = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY: bool,

  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),
  DATABASE_SSL: bool,

  // URL pública do site (ex.: https://capitalcityrp.com). Usada para montar o postbackUrl do webhook
  // e para validar a origem de requisições autenticadas por cookie (proteção CSRF).
  PUBLIC_BASE_URL: z.string().url(),
  // Origens extras autorizadas (ex.: domínio do launcher), separadas por vírgula.
  CORS_ORIGINS: z.string().optional(),

  // Login com Google (mesma conta usada no APK). O Client ID é público.
  GOOGLE_CLIENT_IDS: z.string().default(''),
  // E-mails Google que viram administradores automaticamente ao fazer login.
  ADMIN_EMAILS: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Login de desenvolvimento sem Google. Nunca é aceito com NODE_ENV=production.
  DEV_LOGIN: bool,

  // Gateway de pagamento (BSPay). Somente o Client ID é público; o segredo fica apenas aqui.
  PAYMENT_PROVIDER: z.enum(['bspay', 'mock']).default('bspay'),
  PAYMENT_API_BASE_URL: z.string().url().default('https://api.bspay.co'),
  PAYMENT_CLIENT_ID: z.string().default(''),
  PAYMENT_SECRET: z.string().default(''),
  PAYMENT_WEBHOOK_SECRET: z.string().default(''),
  PAYMENT_WEBHOOK_ALLOWED_IPS: z.string().optional(),
  PAYMENT_EXPIRATION_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),

  // Chave usada pelo servidor SA-MP para consumir a fila de entregas.
  GAME_API_KEY: z.string().default(''),
  GAME_API_ALLOWED_IPS: z.string().optional(),

  UPLOAD_DIR: z.string().default('uploads'),
  STATIC_ROOT: z.string().optional(),
  JOBS_ENABLED: z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => v === undefined || v === '' || v === 'true' || v === '1'),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  host: string;
  port: number;
  logLevel: string;
  trustProxy: boolean;
  databaseUrl: string;
  databaseSsl: boolean;
  publicBaseUrl: string;
  allowedOrigins: string[];
  googleClientIds: string[];
  adminEmails: string[];
  sessionTtlDays: number;
  devLogin: boolean;
  payment: {
    provider: 'bspay' | 'mock';
    apiBaseUrl: string;
    clientId: string;
    secret: string;
    webhookSecret: string;
    webhookAllowedIps: string[];
    expirationMinutes: number;
  };
  game: {
    apiKey: string;
    allowedIps: string[];
  };
  uploadDir: string;
  staticRoot?: string;
  jobsEnabled: boolean;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  const publicBaseUrl = e.PUBLIC_BASE_URL.replace(/\/+$/, '');

  const config: AppConfig = {
    env: e.NODE_ENV,
    isProduction,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    publicBaseUrl,
    allowedOrigins: [new URL(publicBaseUrl).origin, ...csv(e.CORS_ORIGINS).map((o) => new URL(o).origin)],
    googleClientIds: csv(e.GOOGLE_CLIENT_IDS),
    adminEmails: csv(e.ADMIN_EMAILS).map((m) => m.toLowerCase()),
    sessionTtlDays: e.SESSION_TTL_DAYS,
    devLogin: e.DEV_LOGIN && !isProduction,
    payment: {
      provider: e.PAYMENT_PROVIDER,
      apiBaseUrl: e.PAYMENT_API_BASE_URL.replace(/\/+$/, ''),
      clientId: e.PAYMENT_CLIENT_ID,
      secret: e.PAYMENT_SECRET,
      webhookSecret: e.PAYMENT_WEBHOOK_SECRET,
      webhookAllowedIps: csv(e.PAYMENT_WEBHOOK_ALLOWED_IPS),
      expirationMinutes: e.PAYMENT_EXPIRATION_MINUTES,
    },
    game: {
      apiKey: e.GAME_API_KEY,
      allowedIps: csv(e.GAME_API_ALLOWED_IPS),
    },
    uploadDir: e.UPLOAD_DIR,
    staticRoot: e.STATIC_ROOT,
    jobsEnabled: e.JOBS_ENABLED,
  };

  if (isProduction) {
    const missing: string[] = [];
    if (config.payment.provider !== 'bspay') missing.push('PAYMENT_PROVIDER=bspay (mock não é permitido em produção)');
    if (!config.payment.clientId) missing.push('PAYMENT_CLIENT_ID');
    if (!config.payment.secret) missing.push('PAYMENT_SECRET');
    if (config.payment.webhookSecret.length < 24) missing.push('PAYMENT_WEBHOOK_SECRET (mínimo 24 caracteres)');
    if (config.game.apiKey.length < 24) missing.push('GAME_API_KEY (mínimo 24 caracteres)');
    if (config.googleClientIds.length === 0) missing.push('GOOGLE_CLIENT_IDS');
    if (!publicBaseUrl.startsWith('https://')) missing.push('PUBLIC_BASE_URL com https://');
    if (missing.length) {
      throw new Error(`Configuração de produção incompleta: ${missing.join(', ')}`);
    }
  }

  return config;
}
