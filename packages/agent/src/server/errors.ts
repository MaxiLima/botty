import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodError, ZodType, z } from 'zod';

/** Error carrying an HTTP status; rendered as `{ error, detail? }` by the error middleware. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(detail ?? code);
    this.name = 'HttpError';
  }
}

export function notFound(detail: string): HttpError {
  return new HttpError(404, 'not_found', detail);
}

export function badRequest(detail: string): HttpError {
  return new HttpError(400, 'validation_error', detail);
}

export function zodDetail(error: ZodError): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

/** Validate a request body against a shared zod schema; 400 with issue detail on failure. */
export function parseBody<S extends ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw badRequest(zodDetail(result.error));
  return result.data;
}

/** Optional positive-integer query param (`?limit=50`); 400 on garbage. */
export function queryInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${name} must be a positive integer`);
  return n;
}

/** Optional non-empty string query param. */
export function queryStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Required route param — always present when the route pattern matched. */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (value === undefined) throw badRequest(`missing route param: ${name}`);
  return value;
}

/** Express 4 does not catch async rejections — every async handler goes through this. */
export function wrap(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
