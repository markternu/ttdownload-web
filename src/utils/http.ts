import type { NextFunction, Request, Response } from 'express';

export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST'): HttpError => new HttpError(400, code, message);
export const notFound = (message: string, code = 'NOT_FOUND'): HttpError => new HttpError(404, code, message);
export const conflict = (message: string, code = 'CONFLICT'): HttpError => new HttpError(409, code, message);
export const unauthorized = (message: string, code = 'UNAUTHORIZED'): HttpError => new HttpError(401, code, message);
