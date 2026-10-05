import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp, { type Metadata } from 'sharp';
import type { AppContext } from '../../context.js';
import { requireAdmin } from '../../auth/plugin.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest } from '../../lib/errors.js';
import { randomToken } from '../../lib/security.js';

export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

/**
 * Upload de imagens de produtos/categorias. O arquivo é decodificado e recodificado pelo sharp
 * (descarta metadados e qualquer conteúdo que não seja imagem) e salvo em WebP otimizado.
 */
export function uploadRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/admin/uploads', { preHandler: requireAdmin, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    if (!file) throw badRequest('file_required', 'Envie uma imagem.');
    const buffer = await file.toBuffer().catch(() => {
      throw badRequest('file_too_large', 'Imagem muito grande (máximo 6 MB).');
    });

    let image: Buffer;
    let meta: Metadata;
    try {
      meta = await sharp(buffer).metadata();
      if (!meta.format || !['jpeg', 'png', 'webp', 'gif', 'avif'].includes(meta.format)) throw new Error('formato');
      image = await sharp(buffer, { animated: false })
        .rotate()
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
    } catch {
      throw badRequest('invalid_image', 'Arquivo de imagem inválido. Use JPG, PNG ou WebP.');
    }

    const dir = path.resolve(ctx.config.uploadDir);
    await mkdir(dir, { recursive: true });
    const name = `${Date.now().toString(36)}-${randomToken(9)}.webp`;
    await writeFile(path.join(dir, name), image);
    const url = `/uploads/${name}`;
    await writeAudit(ctx.db, { userId: req.user!.id, label: req.user!.email ?? req.user!.name, ip: req.ip }, 'upload.created', 'upload', name, {
      originalFormat: meta.format,
      bytes: image.length,
    });
    reply.code(201);
    return { url };
  });
}
