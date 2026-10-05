import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import {
  findActiveProduct,
  listActiveCategories,
  listActiveProducts,
  toPublicCategory,
  toPublicProduct,
} from './repository.js';

const CACHE = 'public, max-age=30, stale-while-revalidate=120';

export function catalogRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/store/categories', async (_req, reply) => {
    const rows = await listActiveCategories(ctx.db);
    reply.header('Cache-Control', CACHE);
    return { categories: rows.map(toPublicCategory) };
  });

  app.get('/api/store/products', async (req, reply) => {
    const q = parse(
      z.object({
        category: z.string().max(80).optional(),
        featured: z.enum(['1', 'true']).optional(),
      }),
      req.query,
    );
    const rows = await listActiveProducts(ctx.db, { categorySlug: q.category, featured: Boolean(q.featured) });
    reply.header('Cache-Control', CACHE);
    return { products: rows.map(toPublicProduct) };
  });

  app.get<{ Params: { id: string } }>('/api/store/products/:id', async (req, reply) => {
    const id = parse(z.string().min(1).max(100), req.params.id);
    const row = await findActiveProduct(ctx.db, id);
    if (!row) throw notFound('Produto não encontrado.');
    reply.header('Cache-Control', CACHE);
    return { product: toPublicProduct(row) };
  });
}
