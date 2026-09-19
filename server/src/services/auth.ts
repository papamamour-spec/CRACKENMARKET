import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { DB } from "../db/index.js";
import { config } from "../config.js";

export type Role = "investor" | "sgi" | "institutional" | "analyst" | "admin";
export const ROLES: Role[] = ["investor", "sgi", "institutional", "analyst", "admin"];

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
