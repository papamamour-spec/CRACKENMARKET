import type { NextFunction, Request, Response } from "express";
import type { AuthService, AuthPayload } from "../services/auth.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

export function requireAuth(auth: AuthService) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : (req.query.token as string | undefined);
    if (!token) return res.status(401).json({ error: "Authentification requise" });
    try {
      req.auth = auth.verify(token);
      next();
    } catch {
      return res.status(401).json({ error: "Jeton invalide ou expiré" });
    }
  };
}

export function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown> | unknown) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

export function errorHandler(err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction): void {
  const status = err.status ?? 400;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message ?? "Erreur serveur" });
}
