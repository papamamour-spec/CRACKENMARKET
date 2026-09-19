import path from "node:path";
import fs from "node:fs";

const env = process.env;

export type ProviderMode = "auto" | "live" | "simulation";

/** Séances (jours ouvrés) par an, utilisées pour convertir des années en profondeur d'historique */
export const TRADING_DAYS_PER_YEAR = 261;
export const HISTORY_YEARS_DEFAULT = 5;

export const config = {
  port: Number(env.PORT ?? 4000),
  jwtSecret: env.JWT_SECRET ?? "dev-secret-crackenmarket",
  providerMode: (env.DATA_PROVIDER ?? "auto") as ProviderMode,
  livePollIntervalMs: Number(env.LIVE_POLL_INTERVAL_MS ?? 15000),
  simTickIntervalMs: Number(env.SIM_TICK_INTERVAL_MS ?? 2000),
  dbPath: env.DB_PATH ?? path.resolve(process.cwd(), "data/crackenmarket.db"),
  corsOrigin: env.CORS_ORIGIN ?? "*",
  /** Compte administrateur créé (ou promu) au démarrage si les deux variables sont définies */
  adminEmail: env.ADMIN_EMAIL,
  adminPassword: env.ADMIN_PASSWORD,
  /**
   * Profondeur d'historique quotidien conservée par valeur, en séances (jours ouvrés).
   * Défaut : 5 ans (≈ 261 séances par an). Une base plus courte est étendue au démarrage.
   */
  historyDays: Number(env.HISTORY_DAYS ?? HISTORY_YEARS_DEFAULT * TRADING_DAYS_PER_YEAR),
  /** Heures de cotation BRVM (UTC = heure d'Abidjan) */
  marketOpen: { hour: 9, minute: 30 },
  marketClose: { hour: 14, minute: 30 },
};

export function ensureDataDir(): void {
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
