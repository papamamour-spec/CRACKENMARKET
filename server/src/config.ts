import path from "node:path";
import fs from "node:fs";

const env = process.env;

export type ProviderMode = "auto" | "live" | "simulation";

export const config = {
  port: Number(env.PORT ?? 4000),
  jwtSecret: env.JWT_SECRET ?? "dev-secret-crackenmarket",
  providerMode: (env.DATA_PROVIDER ?? "auto") as ProviderMode,
  livePollIntervalMs: Number(env.LIVE_POLL_INTERVAL_MS ?? 15000),
  simTickIntervalMs: Number(env.SIM_TICK_INTERVAL_MS ?? 2000),
  dbPath: env.DB_PATH ?? path.resolve(process.cwd(), "data/crackenmarket.db"),
  corsOrigin: env.CORS_ORIGIN ?? "*",
  /** Nombre de jours d'historique synthétique générés au premier démarrage */
  historyDays: Number(env.HISTORY_DAYS ?? 730),
  /** Heures de cotation BRVM (UTC = heure d'Abidjan) */
  marketOpen: { hour: 9, minute: 30 },
  marketClose: { hour: 14, minute: 30 },
};

export function ensureDataDir(): void {
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
