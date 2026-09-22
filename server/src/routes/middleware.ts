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
    const apiKey = req.headers["x-api-key"];
    if (typeof apiKey === "string" && apiKey) {
      const payload = auth.verifyApiKey(apiKey);
      if (!payload) return res.status(401).json({ error: "Clé API invalide" });
      req.auth = payload;
      return next();
    }
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : (req.query.token as string | undefined);
    if (!token) return res.status(401).json({ error: "Authentification requise" });
    try {
      const payload = auth.verify(token);
      if (payload.pre2fa) return res.status(401).json({ error: "Code de double authentification requis" });
      req.auth = payload;
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
