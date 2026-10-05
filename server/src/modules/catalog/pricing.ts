export interface PriceFields {
  price_cents: number;
  promo_price_cents: number | null;
  promo_ends_at: Date | null;
}

/** Preço efetivo calculado sempre no servidor: promoção só vale se for menor e estiver no prazo. */
export function effectivePriceCents(p: PriceFields, now = new Date()): number {
  if (
    p.promo_price_cents !== null &&
    p.promo_price_cents < p.price_cents &&
    (p.promo_ends_at === null || p.promo_ends_at > now)
  ) {
    return p.promo_price_cents;
  }
  return p.price_cents;
}
