import Database from "better-sqlite3";
import { config, ensureDataDir } from "../config.js";

export type DB = Database.Database;

let db: DB | null = null;

export function getDb(): DB {
  if (db) return db;
  ensureDataDir();
  db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
}

export function openMemoryDb(): DB {
  const mem = new Database(":memory:");
  migrate(mem);
  return mem;
}

function migrate(d: DB): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'investor',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS investor_profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      risk_tolerance INTEGER NOT NULL DEFAULT 3,   -- 1 (prudent) .. 5 (agressif)
      horizon_months INTEGER NOT NULL DEFAULT 24,
      objective TEXT NOT NULL DEFAULT 'growth',    -- income | growth | balanced | speculative
      experience TEXT NOT NULL DEFAULT 'beginner', -- beginner | intermediate | expert
      monthly_capacity REAL NOT NULL DEFAULT 0,
      preferred_sectors TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS candles (
      symbol TEXT NOT NULL,
      ts INTEGER NOT NULL,          -- début de période (ms epoch, UTC)
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume INTEGER NOT NULL,
      PRIMARY KEY (symbol, ts)
    );

    CREATE TABLE IF NOT EXISTS ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      ts INTEGER NOT NULL,
      price REAL NOT NULL,
      volume INTEGER NOT NULL,
      source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ticks_symbol_ts ON ticks(symbol, ts);

    CREATE TABLE IF NOT EXISTS portfolios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      cash REAL NOT NULL DEFAULT 0,
      initial_cash REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS positions (
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      avg_price REAL NOT NULL,
      PRIMARY KEY (portfolio_id, symbol)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,          -- buy | sell
      type TEXT NOT NULL,          -- market | limit
      quantity INTEGER NOT NULL,
      limit_price REAL,
      status TEXT NOT NULL,        -- filled | open | cancelled | rejected
      filled_price REAL,
      filled_at INTEGER,
      created_at INTEGER NOT NULL,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_orders_portfolio ON orders(portfolio_id, created_at);

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      portfolio_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      price REAL NOT NULL,
      realized_pnl REAL NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id, ts);

    CREATE TABLE IF NOT EXISTS watchlist (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, symbol)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      condition TEXT NOT NULL,     -- above | below | pct_move
      value REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      triggered_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS behavior_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,          -- view | order | alert | advice_followed | advice_ignored
      symbol TEXT,
      payload TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_behavior_user ON behavior_events(user_id, ts);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      day INTEGER NOT NULL,          -- début de journée UTC (ms)
      total_value REAL NOT NULL,
      cash REAL NOT NULL,
      invested REAL NOT NULL,
      PRIMARY KEY (portfolio_id, day)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followed_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (follower_id, followed_id)
    );

    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      kind TEXT NOT NULL,            -- bullish | bearish | neutral
      message TEXT NOT NULL,
      price REAL NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);

    CREATE TABLE IF NOT EXISTS points_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      points INTEGER NOT NULL,
      reason TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
  `);

  // Colonnes ajoutées après la première version (migrations additives, idempotentes)
  addColumn(d, "users", "referral_code", "TEXT");
  addColumn(d, "users", "referred_by", "INTEGER");
  addColumn(d, "users", "points", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "users", "totp_secret", "TEXT");
  addColumn(d, "users", "totp_enabled", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "users", "public_profile", "INTEGER NOT NULL DEFAULT 1");
  addColumn(d, "orders", "stop_price", "REAL");
  addColumn(d, "orders", "validity", "TEXT NOT NULL DEFAULT 'gtc'");
  addColumn(d, "orders", "oco_group", "TEXT");
  addColumn(d, "orders", "take_profit", "REAL");
  addColumn(d, "orders", "stop_loss", "REAL");
  addColumn(d, "orders", "triggered_at", "INTEGER");
  addColumn(d, "users", "sgi_code", "TEXT"); // pour le rôle « sgi » : établissement rattaché
  d.exec(`
    CREATE TABLE IF NOT EXISTS sgi_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sgi_code TEXT NOT NULL,
      status TEXT NOT NULL,            -- pending | verified | rejected
      account_number TEXT,             -- numéro de compte-titres attribué par la SGI
      holder_name TEXT NOT NULL,
      id_type TEXT NOT NULL,
      id_number TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      country TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, sgi_code)
    );

    CREATE TABLE IF NOT EXISTS sgi_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sgi_code TEXT NOT NULL,
      account_number TEXT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      type TEXT NOT NULL,              -- market | limit
      quantity INTEGER NOT NULL,
      limit_price REAL,
      validity TEXT NOT NULL,          -- day | gtc | week
      status TEXT NOT NULL,            -- pending | transmitted | acknowledged | executed | partial | rejected | cancelled
      executed_qty INTEGER NOT NULL DEFAULT 0,
      executed_price REAL,
      sgi_reference TEXT,
      estimated_amount REAL NOT NULL,
      estimated_fees REAL NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sgi_orders_user ON sgi_orders(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sgi_orders_sgi ON sgi_orders(sgi_code, status);

    CREATE TABLE IF NOT EXISTS sgi_order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES sgi_orders(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      actor TEXT NOT NULL,             -- client | sgi | system
      message TEXT,
      ts INTEGER NOT NULL
    );
  `);
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral ON users(referral_code)");
}

function addColumn(d: DB, table: string, column: string, definition: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
