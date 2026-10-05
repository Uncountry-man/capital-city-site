/** Erro de domínio com status HTTP e código estável (o frontend usa o código, nunca a mensagem interna). */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
export const unauthorized = (message = 'Faça login para continuar.') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Acesso negado.') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Não encontrado.') => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const unavailable = (code: string, message: string) => new AppError(503, code, message);
