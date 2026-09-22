import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createHash, randomBytes } from "node:crypto";
import { generateSecret, otpauthUrl, verifyTotp } from "./totp.js";
import type { DB } from "../db/index.js";
import { config } from "../config.js";

export type Role = "investor" | "sgi" | "institutional" | "analyst" | "admin";
export const ROLES: Role[] = ["investor", "sgi", "institutional", "analyst", "admin"];
export const ADMIN_PASSWORD_MIN_LENGTH = 8;

export interface User {
  id: number;
  email: string;
  fullName: string;
  role: Role;
  createdAt: number;
  referralCode?: string;
  points?: number;
  totpEnabled?: boolean;
  publicProfile?: boolean;
}

export interface AuthPayload {
  sub: number;
  role: Role;
  /** jeton temporaire émis entre mot de passe et code 2FA */
  pre2fa?: boolean;
}

export const POINTS = {
  signup: 100,
  referrer: 500,
  referred: 200,
  firstOrder: 100,
  twoFactor: 150,
} as const;

export class AuthService {
  constructor(private readonly db: DB) {}

  register(email: string, password: string, fullName: string, role: Role = "investor", referralCode?: string): User {
    const existing = this.db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase());
    if (existing) throw new Error("Un compte existe déjà avec cet e-mail");
    let referrer: { id: number } | undefined;
    if (referralCode) {
      referrer = this.db.prepare("SELECT id FROM users WHERE referral_code = ?").get(referralCode.trim().toUpperCase()) as { id: number } | undefined;
      if (!referrer) throw new Error("Code de parrainage inconnu");
    }
    const hash = bcrypt.hashSync(password, 10);
    const now = Date.now();
    const info = this.db
      .prepare("INSERT INTO users(email, password_hash, full_name, role, created_at, referral_code, referred_by) VALUES (?,?,?,?,?,?,?)")
      .run(email.toLowerCase(), hash, fullName, role, now, this.newReferralCode(), referrer?.id ?? null);
    const id = Number(info.lastInsertRowid);
    this.addPoints(id, POINTS.signup, "Création du compte");
    if (referrer) {
      this.addPoints(id, POINTS.referred, "Inscription avec un code de parrainage");
      this.addPoints(referrer.id, POINTS.referrer, "Parrainage d'un nouvel investisseur");
    }
    this.db
      .prepare("INSERT INTO investor_profiles(user_id, updated_at) VALUES (?, ?)")
      .run(id, now);
    // Portefeuille virtuel de démarrage : 5 000 000 FCFA
    this.db
      .prepare("INSERT INTO portfolios(user_id, name, cash, initial_cash, created_at) VALUES (?,?,?,?,?)")
      .run(id, "Portefeuille principal", 5_000_000, 5_000_000, now);
    return this.getUser(id)!;
  }

  /**
   * Garantit l'existence du compte administrateur déclaré par ADMIN_EMAIL / ADMIN_PASSWORD.
   * - compte absent : il est créé avec le rôle « admin » ;
   * - compte présent : son rôle est porté à « admin » et son mot de passe aligné sur la
   *   variable, ce qui permet de récupérer l'accès en changeant simplement la variable.
   * Ne fait rien si l'une des deux variables manque. Retourne le compte ou undefined.
   */
  ensureAdmin(email: string | undefined, password: string | undefined, fullName = "Administrateur"): User | undefined {
    if (!email || !password) return undefined;
    if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
      console.warn(`[auth] ADMIN_PASSWORD trop court (${ADMIN_PASSWORD_MIN_LENGTH} caractères minimum) : compte administrateur ignoré.`);
      return undefined;
    }
    const normalized = email.toLowerCase();
    const existing = this.db
      .prepare("SELECT id, password_hash, role FROM users WHERE email = ?")
      .get(normalized) as { id: number; password_hash: string; role: Role } | undefined;
    if (!existing) {
      const user = this.register(normalized, password, fullName, "admin");
      console.log(`[auth] compte administrateur créé : ${user.email}`);
      return user;
    }
    if (existing.role !== "admin") {
      this.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
      console.log(`[auth] compte ${normalized} promu administrateur`);
    }
    if (!bcrypt.compareSync(password, existing.password_hash)) {
      this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(password, 10), existing.id);
      console.log(`[auth] mot de passe administrateur de ${normalized} mis à jour depuis ADMIN_PASSWORD`);
    }
    return this.getUser(existing.id);
  }

  login(email: string, password: string): User {
    const row = this.db
      .prepare("SELECT id, email, password_hash, full_name, role, created_at FROM users WHERE email = ?")
      .get(email.toLowerCase()) as { id: number; email: string; password_hash: string; full_name: string; role: Role; created_at: number } | undefined;
    if (!row || !bcrypt.compareSync(password, row.password_hash)) throw new Error("Identifiants invalides");
    return this.getUser(row.id)!;
  }

  getUser(id: number): User | undefined {
    const row = this.db
      .prepare("SELECT id, email, full_name, role, created_at, referral_code, points, totp_enabled, public_profile FROM users WHERE id = ?")
      .get(id) as
      | { id: number; email: string; full_name: string; role: Role; created_at: number; referral_code: string | null; points: number; totp_enabled: number; public_profile: number }
      | undefined;
    if (!row) return undefined;
    if (!row.referral_code) {
      row.referral_code = this.newReferralCode();
      this.db.prepare("UPDATE users SET referral_code = ? WHERE id = ?").run(row.referral_code, id);
    }
    return {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      createdAt: row.created_at,
      referralCode: row.referral_code,
      points: row.points,
      totpEnabled: row.totp_enabled === 1,
      publicProfile: row.public_profile === 1,
    };
  }

  // ---------- Parrainage & points ----------

  private newReferralCode(): string {
    for (;;) {
      const code = "CM-" + randomBytes(3).toString("hex").toUpperCase();
      const clash = this.db.prepare("SELECT 1 FROM users WHERE referral_code = ?").get(code);
      if (!clash) return code;
    }
  }

  addPoints(userId: number, points: number, reason: string): void {
    this.db.prepare("INSERT INTO points_ledger(user_id, points, reason, ts) VALUES (?,?,?,?)").run(userId, points, reason, Date.now());
    this.db.prepare("UPDATE users SET points = points + ? WHERE id = ?").run(points, userId);
  }

  /** Attribue des points une seule fois par motif. */
  addPointsOnce(userId: number, points: number, reason: string): boolean {
    const dup = this.db.prepare("SELECT 1 FROM points_ledger WHERE user_id = ? AND reason = ?").get(userId, reason);
    if (dup) return false;
    this.addPoints(userId, points, reason);
    return true;
  }

  referrals(userId: number) {
    const referred = this.db
      .prepare("SELECT full_name AS fullName, created_at AS createdAt FROM users WHERE referred_by = ? ORDER BY created_at DESC")
      .all(userId) as { fullName: string; createdAt: number }[];
    const ledger = this.db.prepare("SELECT points, reason, ts FROM points_ledger WHERE user_id = ? ORDER BY ts DESC LIMIT 50").all(userId) as { points: number; reason: string; ts: number }[];
    return { referred: referred.map((r) => ({ fullName: maskName(r.fullName), createdAt: r.createdAt })), ledger };
  }

  setPublicProfile(userId: number, isPublic: boolean): void {
    this.db.prepare("UPDATE users SET public_profile = ? WHERE id = ?").run(isPublic ? 1 : 0, userId);
  }

  // ---------- Double authentification ----------

  totpEnabled(userId: number): boolean {
    const row = this.db.prepare("SELECT totp_enabled FROM users WHERE id = ?").get(userId) as { totp_enabled: number } | undefined;
    return row?.totp_enabled === 1;
  }

  /** Génère un secret provisoire (activé seulement après vérification d'un premier code). */
  setupTotp(userId: number): { secret: string; otpauth: string } {
    const user = this.getUser(userId);
    if (!user) throw new Error("Utilisateur introuvable");
    if (user.totpEnabled) throw new Error("La double authentification est déjà active");
    const secret = generateSecret();
    this.db.prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(secret, userId);
    return { secret, otpauth: otpauthUrl(secret, user.email) };
  }

  enableTotp(userId: number, code: string): void {
    const row = this.db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(userId) as { totp_secret: string | null } | undefined;
    if (!row?.totp_secret) throw new Error("Lancez d'abord la configuration");
    if (!verifyTotp(row.totp_secret, code)) throw new Error("Code invalide");
    this.db.prepare("UPDATE users SET totp_enabled = 1 WHERE id = ?").run(userId);
    this.addPointsOnce(userId, POINTS.twoFactor, "Activation de la double authentification");
  }

  disableTotp(userId: number, code: string): void {
    const row = this.db.prepare("SELECT totp_secret, totp_enabled FROM users WHERE id = ?").get(userId) as { totp_secret: string | null; totp_enabled: number } | undefined;
    if (!row?.totp_enabled || !row.totp_secret) throw new Error("La double authentification n'est pas active");
    if (!verifyTotp(row.totp_secret, code)) throw new Error("Code invalide");
    this.db.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?").run(userId);
  }

  verifyTotpFor(userId: number, code: string): boolean {
    const row = this.db.prepare("SELECT totp_secret FROM users WHERE id = ? AND totp_enabled = 1").get(userId) as { totp_secret: string } | undefined;
    return !!row && verifyTotp(row.totp_secret, code);
  }

  // ---------- Clés API (SGI, institutionnels, développeurs) ----------

  createApiKey(userId: number, label: string): { id: number; key: string; prefix: string } {
    const key = "cm_" + randomBytes(24).toString("hex");
    const prefix = key.slice(0, 10);
    const info = this.db
      .prepare("INSERT INTO api_keys(user_id, label, prefix, key_hash, created_at) VALUES (?,?,?,?,?)")
      .run(userId, label, prefix, hashKey(key), Date.now());
    return { id: Number(info.lastInsertRowid), key, prefix };
  }

  listApiKeys(userId: number) {
    return this.db
      .prepare("SELECT id, label, prefix, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_keys WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as { id: number; label: string; prefix: string; createdAt: number; lastUsedAt: number | null }[];
  }

  revokeApiKey(userId: number, id: number): void {
    this.db.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?").run(id, userId);
  }

  /** Authentifie une clé API ; renvoie la charge utile équivalente à un jeton. */
  verifyApiKey(key: string): AuthPayload | null {
    const row = this.db.prepare("SELECT id, user_id FROM api_keys WHERE key_hash = ?").get(hashKey(key)) as { id: number; user_id: number } | undefined;
    if (!row) return null;
    const user = this.getUser(row.user_id);
    if (!user) return null;
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);
    return { sub: user.id, role: user.role };
  }

  sign(user: User, opts: { pre2fa?: boolean } = {}): string {
    const payload: AuthPayload = opts.pre2fa ? { sub: user.id, role: user.role, pre2fa: true } : { sub: user.id, role: user.role };
    return jwt.sign(payload, config.jwtSecret, { expiresIn: opts.pre2fa ? "5m" : "7d" });
  }

  verify(token: string): AuthPayload {
    return jwt.verify(token, config.jwtSecret) as unknown as AuthPayload;
  }
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** « Aminata Diallo » → « Aminata D. » */
export function maskName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ?? "";
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}
