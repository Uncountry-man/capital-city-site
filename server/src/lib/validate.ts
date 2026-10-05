import type { z } from 'zod';
import { badRequest } from './errors.js';

/** Valida a entrada com Zod e converte falhas em erro 400 padronizado. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest('validation_error', 'Dados inválidos.', issues);
  }
  return result.data;
}
