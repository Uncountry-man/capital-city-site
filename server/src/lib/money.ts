/** Converte centavos para o valor decimal enviado ao gateway (ex.: 1590 -> 15.9). */
export const centsToDecimal = (cents: number) => Math.round(cents) / 100;

/** Converte valor decimal recebido do gateway para centavos sem erro de ponto flutuante. */
export function decimalToCents(value: unknown): number | null {
  const n = typeof value === 'string' ? Number.parseFloat(value.replace(',', '.')) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
