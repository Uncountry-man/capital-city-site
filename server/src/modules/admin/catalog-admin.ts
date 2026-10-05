import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireAdmin } from '../../auth/plugin.js';
import { withTransaction } from '../../db/pool.js';
import { diff, writeAudit, type AuditActor } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { slugify } from '../../lib/slug.js';
import { parse } from '../../lib/validate.js';
import { DELIVERY_TYPES, validateDeliveryParams } from '../catalog/delivery-types.js';
import type { CategoryRow, ProductRow } from '../catalog/repository.js';

export const CATEGORY_ICONS = ['crown', 'coins', 'car', 'home', 'box', 'gift', 'star', 'palette', 'tag', 'shield', 'zap', 'package'] as const;

const nullableUrl = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z
    .string()
    .max(500)
    .refine((v) => v.startsWith('/uploads/') || /^https:\/\//.test(v), 'Use uma imagem enviada pelo painel ou uma URL https.')
    .nullable(),
);
const optionalInt = (min: number, max: number) =>
  z.preprocess((v) => (v === '' || v === undefined ? null : v), z.coerce.number().int().min(min).max(max).nullable());
const nullableDate = z.preprocess((v) => (v === '' || v === undefined ? null : v), z.coerce.date().nullable());

export const CategoryInput = z.object({
  name: z.string().trim().min(2).max(60),
  slug: z.string().trim().max(80).optional(),
  description: z.string().trim().max(300).default(''),
  icon: z.enum(CATEGORY_ICONS).default('tag'),
  imageUrl: nullableUrl.default(null),
  sortOrder: z.coerce.number().int().min(-10000).max(10000).default(0),
  isActive: z.boolean().default(true),
});

export const ProductInput = z
  .object({
    categoryId: z.uuid(),
    name: z.string().trim().min(2).max(80),
    slug: z.string().trim().max(80).optional(),
    shortDescription: z.string().trim().max(160).default(''),
    description: z.string().trim().max(5000).default(''),
    conditions: z.string().trim().max(2000).default(''),
    imageUrl: nullableUrl.default(null),
    priceCents: z.coerce.number().int().min(100, 'Preço mínimo R$ 1,00').max(10_000_000),
    promoPriceCents: optionalInt(100, 10_000_000).default(null),
    promoEndsAt: nullableDate.default(null),
    stock: optionalInt(0, 1_000_000).default(null),
    maxPerOrder: z.coerce.number().int().min(1).max(100).default(1),
    benefits: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
    durationDays: optionalInt(1, 3650).default(null),
    deliveryType: z.enum(DELIVERY_TYPES),
    deliveryParams: z.record(z.string(), z.unknown()).default({}),
    isActive: z.boolean().default(true),
    isFeatured: z.boolean().default(false),
    sortOrder: z.coerce.number().int().min(-10000).max(10000).default(0),
  })
  .refine((p) => p.promoPriceCents === null || p.promoPriceCents < p.priceCents, {
    message: 'O preço promocional precisa ser menor que o preço normal.',
    path: ['promoPriceCents'],
  });

export function adminProductView(p: ProductRow & { category_name?: string; sold_count?: number }) {
  return {
    id: p.id,
    categoryId: p.category_id,
    categoryName: p.category_name ?? null,
    slug: p.slug,
    name: p.name,
    shortDescription: p.short_description,
    description: p.description,
    conditions: p.conditions,
    imageUrl: p.image_url,
    priceCents: p.price_cents,
    promoPriceCents: p.promo_price_cents,
    promoEndsAt: p.promo_ends_at,
    stock: p.stock,
    maxPerOrder: p.max_per_order,
    benefits: p.benefits,
    durationDays: p.duration_days,
    deliveryType: p.delivery_type,
    deliveryParams: p.delivery_params,
    isActive: p.is_active,
    isFeatured: p.is_featured,
    sortOrder: p.sort_order,
    soldCount: p.sold_count ?? 0,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

function categoryView(c: CategoryRow & { product_count?: number }) {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    description: c.description,
    icon: c.icon,
    imageUrl: c.image_url,
    sortOrder: c.sort_order,
    isActive: c.is_active,
    productCount: c.product_count ?? 0,
  };
}

function productColumns(input: z.infer<typeof ProductInput>, deliveryParams: Record<string, unknown>) {
  return {
    category_id: input.categoryId,
    slug: input.slug ? slugify(input.slug) : slugify(input.name),
    name: input.name,
    short_description: input.shortDescription,
    description: input.description,
    conditions: input.conditions,
    image_url: input.imageUrl,
    price_cents: input.priceCents,
    promo_price_cents: input.promoPriceCents,
    promo_ends_at: input.promoEndsAt,
    stock: input.stock,
    max_per_order: input.maxPerOrder,
    benefits: input.benefits,
    duration_days: input.durationDays,
    delivery_type: input.deliveryType,
    delivery_params: deliveryParams,
    is_active: input.isActive,
    is_featured: input.isFeatured,
    sort_order: input.sortOrder,
  };
}

const JSON_COLUMNS = new Set(['benefits', 'delivery_params']);
const toDb = (v: unknown, key: string) => (JSON_COLUMNS.has(key) ? JSON.stringify(v) : v);

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export function catalogAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const actor = (req: import('fastify').FastifyRequest): AuditActor => ({
    userId: req.user!.id,
    label: req.user!.email ?? req.user!.name,
    ip: req.ip,
  });
  const admin = { preHandler: requireAdmin };
  const uuid = z.uuid();

  // ------------------------------------------------------------------ categorias
  app.get('/api/admin/categories', admin, async () => {
    const { rows } = await ctx.db.query<CategoryRow & { product_count: number }>(
      `SELECT c.*, COUNT(p.id) AS product_count FROM categories c
         LEFT JOIN products p ON p.category_id = c.id AND p.deleted_at IS NULL
        GROUP BY c.id ORDER BY c.sort_order, c.name`,
    );
    return { categories: rows.map(categoryView) };
  });

  app.post('/api/admin/categories', admin, async (req, reply) => {
    const input = parse(CategoryInput, req.body);
    try {
      const category = await withTransaction(ctx.db, async (tx) => {
        const { rows } = await tx.query<CategoryRow>(
          `INSERT INTO categories (name, slug, description, icon, image_url, sort_order, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [input.name, slugify(input.slug || input.name), input.description, input.icon, input.imageUrl, input.sortOrder, input.isActive],
        );
        await writeAudit(tx, actor(req), 'category.created', 'category', rows[0]!.id, { name: input.name });
        return rows[0]!;
      });
      reply.code(201);
      return { category: categoryView(category) };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('slug_taken', 'Já existe uma categoria com esse endereço (slug).');
      throw err;
    }
  });

  app.put<{ Params: { id: string } }>('/api/admin/categories/:id', admin, async (req) => {
    const id = parse(uuid, req.params.id);
    const input = parse(CategoryInput, req.body);
    try {
      const category = await withTransaction(ctx.db, async (tx) => {
        const before = await tx.query<CategoryRow>('SELECT * FROM categories WHERE id = $1 FOR UPDATE', [id]);
        if (!before.rows[0]) throw notFound('Categoria não encontrada.');
        const { rows } = await tx.query<CategoryRow>(
          `UPDATE categories SET name = $2, slug = $3, description = $4, icon = $5, image_url = $6, sort_order = $7, is_active = $8, updated_at = now()
            WHERE id = $1 RETURNING *`,
          [id, input.name, slugify(input.slug || input.name), input.description, input.icon, input.imageUrl, input.sortOrder, input.isActive],
        );
        const changes = diff(before.rows[0] as unknown as Record<string, unknown>, rows[0] as unknown as Record<string, unknown>);
        delete changes.updated_at;
        await writeAudit(tx, actor(req), 'category.updated', 'category', id, { changes });
        return rows[0]!;
      });
      return { category: categoryView(category) };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('slug_taken', 'Já existe uma categoria com esse endereço (slug).');
      throw err;
    }
  });

  app.post('/api/admin/categories/reorder', admin, async (req) => {
    const body = parse(z.object({ ids: z.array(uuid).min(1).max(200) }), req.body);
    await withTransaction(ctx.db, async (tx) => {
      for (const [index, id] of body.ids.entries()) {
        await tx.query('UPDATE categories SET sort_order = $2, updated_at = now() WHERE id = $1', [id, index * 10]);
      }
      await writeAudit(tx, actor(req), 'category.reordered', 'category', null, { ids: body.ids });
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/categories/:id', admin, async (req) => {
    const id = parse(uuid, req.params.id);
    await withTransaction(ctx.db, async (tx) => {
      const used = await tx.query('SELECT 1 FROM products WHERE category_id = $1 LIMIT 1', [id]);
      if (used.rowCount) throw conflict('category_in_use', 'Esta categoria possui produtos. Mova-os ou desative a categoria.');
      const res = await tx.query<CategoryRow>('DELETE FROM categories WHERE id = $1 RETURNING *', [id]);
      if (!res.rows[0]) throw notFound('Categoria não encontrada.');
      await writeAudit(tx, actor(req), 'category.deleted', 'category', id, { name: res.rows[0].name });
    });
    return { ok: true };
  });

  // ------------------------------------------------------------------ produtos
  app.get('/api/admin/products', admin, async (req) => {
    const q = parse(
      z.object({
        categoryId: uuid.optional(),
        status: z.enum(['all', 'active', 'inactive']).default('all'),
        q: z.string().trim().max(80).optional(),
      }),
      req.query,
    );
    const params: unknown[] = [];
    const where = ['p.deleted_at IS NULL'];
    if (q.categoryId) {
      params.push(q.categoryId);
      where.push(`p.category_id = $${params.length}`);
    }
    if (q.status !== 'all') where.push(q.status === 'active' ? 'p.is_active' : 'NOT p.is_active');
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`p.name ILIKE $${params.length}`);
    }
    const { rows } = await ctx.db.query<ProductRow & { category_name: string; sold_count: number }>(
      `SELECT p.*, c.name AS category_name,
              COALESCE((SELECT SUM(i.quantity) FROM order_items i JOIN orders o ON o.id = i.order_id
                         WHERE i.product_id = p.id AND o.status IN ('paid', 'approved', 'delivered')), 0) AS sold_count
         FROM products p JOIN categories c ON c.id = p.category_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.sort_order, p.sort_order, p.name`,
      params,
    );
    return { products: rows.map(adminProductView) };
  });

  app.get<{ Params: { id: string } }>('/api/admin/products/:id', admin, async (req) => {
    const id = parse(uuid, req.params.id);
    const { rows } = await ctx.db.query<ProductRow>('SELECT * FROM products WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!rows[0]) throw notFound('Produto não encontrado.');
    return { product: adminProductView(rows[0]) };
  });

  app.post('/api/admin/products', admin, async (req, reply) => {
    const input = parse(ProductInput, req.body);
    const params = validateDeliveryParams(input.deliveryType, input.deliveryParams);
    const cols = productColumns(input, params);
    const keys = Object.keys(cols) as (keyof typeof cols)[];
    try {
      const product = await withTransaction(ctx.db, async (tx) => {
        const { rows } = await tx.query<ProductRow>(
          `INSERT INTO products (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
          keys.map((k) => toDb(cols[k], k)),
        );
        await writeAudit(tx, actor(req), 'product.created', 'product', rows[0]!.id, {
          name: input.name,
          priceCents: input.priceCents,
          promoPriceCents: input.promoPriceCents,
          deliveryType: input.deliveryType,
        });
        return rows[0]!;
      });
      reply.code(201);
      return { product: adminProductView(product) };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('slug_taken', 'Já existe um produto com esse endereço (slug).');
      throw err;
    }
  });

  app.put<{ Params: { id: string } }>('/api/admin/products/:id', admin, async (req) => {
    const id = parse(uuid, req.params.id);
    const input = parse(ProductInput, req.body);
    const params = validateDeliveryParams(input.deliveryType, input.deliveryParams);
    const cols = productColumns(input, params);
    const keys = Object.keys(cols) as (keyof typeof cols)[];
    try {
      const product = await withTransaction(ctx.db, async (tx) => {
        const before = await tx.query<ProductRow>('SELECT * FROM products WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
        if (!before.rows[0]) throw notFound('Produto não encontrado.');
        const { rows } = await tx.query<ProductRow>(
          `UPDATE products SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
          [id, ...keys.map((k) => toDb(cols[k], k))],
        );
        const changes = diff(
          before.rows[0] as unknown as Record<string, unknown>,
          Object.fromEntries(keys.map((k) => [k, (rows[0] as unknown as Record<string, unknown>)[k]])),
        );
        const priceChanged = 'price_cents' in changes || 'promo_price_cents' in changes;
        await writeAudit(tx, actor(req), priceChanged ? 'product.price_changed' : 'product.updated', 'product', id, {
          name: rows[0]!.name,
          changes,
        });
        return rows[0]!;
      });
      return { product: adminProductView(product) };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('slug_taken', 'Já existe um produto com esse endereço (slug).');
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/admin/products/:id/status', admin, async (req) => {
    const id = parse(uuid, req.params.id);
    const body = parse(z.object({ isActive: z.boolean().optional(), isFeatured: z.boolean().optional() }), req.body);
    const product = await withTransaction(ctx.db, async (tx) => {
      const { rows } = await tx.query<ProductRow>(
        `UPDATE products SET is_active = COALESCE($2, is_active), is_featured = COALESCE($3, is_featured), updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
        [id, body.isActive ?? null, body.isFeatured ?? null],
      );
      if (!rows[0]) throw notFound('Produto não encontrado.');
      const action = body.isActive === undefined ? 'product.featured_changed' : body.isActive ? 'product.activated' : 'product.deactivated';
      await writeAudit(tx, actor(req), action, 'product', id, { name: rows[0].name, ...body });
      return rows[0];
    });
    return { product: adminProductView(product) };
  });

  app.post('/api/admin/products/reorder', admin, async (req) => {
    const body = parse(z.object({ ids: z.array(uuid).min(1).max(500) }), req.body);
    await withTransaction(ctx.db, async (tx) => {
      for (const [index, id] of body.ids.entries()) {
        await tx.query('UPDATE products SET sort_order = $2, updated_at = now() WHERE id = $1', [id, index * 10]);
      }
      await writeAudit(tx, actor(req), 'product.reordered', 'product', null, { ids: body.ids });
    });
    return { ok: true };
  });

  /**
   * Exclusão segura: produtos que já aparecem em pedidos são apenas arquivados (soft delete),
   * preservando o histórico financeiro e de entregas.
   */
  app.delete<{ Params: { id: string } }>('/api/admin/products/:id', admin, async (req) => {
    const id = parse(uuid, req.params.id);
    const archived = await withTransaction(ctx.db, async (tx) => {
      const product = await tx.query<ProductRow>('SELECT * FROM products WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
      if (!product.rows[0]) throw notFound('Produto não encontrado.');
      const used = await tx.query('SELECT 1 FROM order_items WHERE product_id = $1 LIMIT 1', [id]);
      if (used.rowCount) {
        await tx.query(
          `UPDATE products SET deleted_at = now(), is_active = false, is_featured = false, slug = slug || '-arquivado-' || substr(id::text, 1, 8), updated_at = now() WHERE id = $1`,
          [id],
        );
      } else {
        await tx.query('DELETE FROM products WHERE id = $1', [id]);
      }
      await writeAudit(tx, actor(req), 'product.removed', 'product', id, { name: product.rows[0].name, archived: Boolean(used.rowCount) });
      return Boolean(used.rowCount);
    });
    return { ok: true, archived };
  });
}
