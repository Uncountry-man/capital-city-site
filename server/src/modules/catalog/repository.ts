import type { Queryable } from '../../db/pool.js';
import { effectivePriceCents } from './pricing.js';

export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  image_url: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ProductRow {
  id: string;
  category_id: string;
  slug: string;
  name: string;
  short_description: string;
  description: string;
  conditions: string;
  image_url: string | null;
  price_cents: number;
  promo_price_cents: number | null;
  promo_ends_at: Date | null;
  stock: number | null;
  max_per_order: number;
  benefits: string[];
  duration_days: number | null;
  delivery_type: string;
  delivery_params: Record<string, unknown>;
  is_active: boolean;
  is_featured: boolean;
  sort_order: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type PublicProductRow = ProductRow & { category_slug: string; category_name: string };

/** Formato público de um produto: nunca expõe parâmetros internos de entrega. */
export function toPublicProduct(p: PublicProductRow) {
  const finalPrice = effectivePriceCents(p);
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    shortDescription: p.short_description,
    description: p.description,
    conditions: p.conditions,
    imageUrl: p.image_url,
    priceCents: p.price_cents,
    finalPriceCents: finalPrice,
    onSale: finalPrice < p.price_cents,
    promoEndsAt: finalPrice < p.price_cents ? p.promo_ends_at : null,
    available: p.is_active && (p.stock === null || p.stock > 0),
    stockLeft: p.stock,
    maxPerOrder: p.max_per_order,
    benefits: p.benefits,
    durationDays: p.duration_days,
    deliveryType: p.delivery_type,
    isFeatured: p.is_featured,
    category: { id: p.category_id, slug: p.category_slug, name: p.category_name },
  };
}

export function toPublicCategory(c: CategoryRow & { product_count?: number }) {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    description: c.description,
    icon: c.icon,
    imageUrl: c.image_url,
    productCount: c.product_count ?? 0,
  };
}

export async function listActiveCategories(db: Queryable) {
  const { rows } = await db.query<CategoryRow & { product_count: number }>(
    `SELECT c.*, COUNT(p.id) AS product_count
       FROM categories c
       LEFT JOIN products p ON p.category_id = c.id AND p.is_active AND p.deleted_at IS NULL
      WHERE c.is_active
      GROUP BY c.id
      ORDER BY c.sort_order, c.name`,
  );
  return rows;
}

const PUBLIC_PRODUCT_SELECT = `
  SELECT p.*, c.slug AS category_slug, c.name AS category_name
    FROM products p JOIN categories c ON c.id = p.category_id
   WHERE p.deleted_at IS NULL AND p.is_active AND c.is_active`;

export async function listActiveProducts(db: Queryable, filter: { categorySlug?: string; featured?: boolean }) {
  const params: unknown[] = [];
  let sql = PUBLIC_PRODUCT_SELECT;
  if (filter.categorySlug) {
    params.push(filter.categorySlug);
    sql += ` AND c.slug = $${params.length}`;
  }
  if (filter.featured) sql += ' AND p.is_featured';
  sql += ' ORDER BY p.is_featured DESC, c.sort_order, p.sort_order, p.name LIMIT 500';
  const { rows } = await db.query<PublicProductRow>(sql, params);
  return rows;
}

export async function findActiveProduct(db: Queryable, idOrSlug: string) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const { rows } = await db.query<PublicProductRow>(
    `${PUBLIC_PRODUCT_SELECT} AND ${isUuid ? 'p.id = $1' : 'p.slug = $1'}`,
    [idOrSlug],
  );
  return rows[0] ?? null;
}
