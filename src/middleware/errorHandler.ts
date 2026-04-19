import { Request, Response, NextFunction } from 'express';
import logger from '../lib/logger';

const log = logger.child({ module: 'error-handler' });

/**
 * Global Express error-handler (HARDEN-01).
 *
 * Express identifies error middleware by the 4-argument signature
 * (err, req, res, next). The `next` param is required by Express even
 * if unused here — omitting it breaks Express's error-middleware
 * detection.
 *
 * Response shape is `{ error: string }`, matching the 186 manual
 * try/catch error responses across the 16 existing route files —
 * wire-compatible with all existing clients.
 *
 * Status precedence (D-01): err.statusCode > err.status > 500.
 * Message exposure (D-04, http-errors convention):
 *   - err.expose === true → client sees err.message (semantic 4xx).
 *   - otherwise           → client sees 'Internal server error' (5xx).
 *     Symmetric in dev and prod — never leak stack to the client.
 * The full error (with stack) is always logged to pino at level=error.
 *
 * If a route partially wrote the response (res.headersSent === true),
 * we cannot safely JSON-write; delegate to Express default handler
 * which closes the connection (D-04).
 */
export default function errorHandler(
  err: Error & { statusCode?: number; status?: number; expose?: boolean },
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const statusCode = err.statusCode ?? err.status ?? 500;

  // Structured log — always, regardless of headers-sent.
  // reqId is set by pino-http (Plan 01, D-26). Untyped read via `as any`
  // because stock Express Request doesn't declare `id`.
  log.error(
    {
      event: 'unhandled_error',
      reqId: (req as { id?: string }).id,
      method: req.method,
      path: req.path,
      statusCode,
      err,
    },
    'Unhandled error',
  );

  if (res.headersSent) {
    // Response already started; let Express default handler close it.
    return next(err);
  }

  const message = err.expose === true ? err.message : 'Internal server error';
  res.status(statusCode).json({ error: message });
}
