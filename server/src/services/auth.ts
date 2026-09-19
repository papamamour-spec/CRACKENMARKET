import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
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
}

export interface AuthPayload {
  sub: number;
  role: Role;
}

export class AuthService {
  constructor(private readonly db: DB) {}

  register(email: string, password: string, fullName: string, role: Role = "investor"): User {
    const existing = this.db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase());
    if (existing) throw new Error("Un compte existe déjà avec cet e-mail");
    const hash = bcrypt.hashSync(password, 10);
    const now = Date.now();
    const info = this.db
      .prepare("INSERT INTO users(email, password_hash, full_name, role, created_at) VALUES (?,?,?,?,?)")
      .run(email.toLowerCase(), hash, fullName, role, now);
    const id = Number(info.lastInsertRowid);
    this.db
      .prepare("INSERT INTO investor_profiles(user_id, updated_at) VALUES (?, ?)")
      .run(id, now);
    // Portefeuille virtuel de démarrage : 5 000 000 FCFA
    this.db
      .prepare("INSERT INTO portfolios(user_id, name, cash, initial_cash, created_at) VALUES (?,?,?,?,?)")
      .run(id, "Portefeuille principal", 5_000_000, 5_000_000, now);
    return { id, email: email.toLowerCase(), fullName, role, createdAt: now };
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
    return { id: row.id, email: row.email, fullName: row.full_name, role: row.role, createdAt: row.created_at };
  }

  getUser(id: number): User | undefined {
    const row = this.db.prepare("SELECT id, email, full_name, role, created_at FROM users WHERE id = ?").get(id) as
      | { id: number; email: string; full_name: string; role: Role; created_at: number }
      | undefined;
    return row ? { id: row.id, email: row.email, fullName: row.full_name, role: row.role, createdAt: row.created_at } : undefined;
  }

  sign(user: User): string {
    const payload: AuthPayload = { sub: user.id, role: user.role };
    return jwt.sign(payload, config.jwtSecret, { expiresIn: "7d" });
  }

  verify(token: string): AuthPayload {
    return jwt.verify(token, config.jwtSecret) as unknown as AuthPayload;
  }
}
