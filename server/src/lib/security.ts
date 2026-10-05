import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Comparação em tempo constante para segredos (evita timing attacks). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

// Alfabeto sem caracteres ambíguos (0/O, 1/I/L) para códigos digitados no jogo.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

/** Normaliza IPv4 mapeado em IPv6 (::ffff:1.2.3.4) para comparação com listas de IPs permitidos. */
export function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function ipAllowed(ip: string, allowList: string[]): boolean {
  if (allowList.length === 0) return true;
  return allowList.includes(normalizeIp(ip));
}
