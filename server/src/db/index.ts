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
    CREATE TABLE IF NOT EXISTS news_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      summary TEXT,
      published_at INTEGER NOT NULL,
      symbols TEXT NOT NULL DEFAULT '[]',
      sentiment REAL NOT NULL DEFAULT 0,
      market_wide INTEGER NOT NULL DEFAULT 0,
      fetched_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_news_published ON news_items(published_at);

    CREATE TABLE IF NOT EXISTS advisory_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requester_type TEXT NOT NULL,     -- client | sgi
      sgi_code TEXT,
      client_label TEXT,                -- pour une SGI : client ou portefeuille concerné
      capital REAL NOT NULL,
      objective TEXT NOT NULL,
      horizon_months INTEGER NOT NULL,
      risk_tolerance INTEGER NOT NULL,
      preferred_sectors TEXT NOT NULL DEFAULT '[]',
      constraints TEXT,
      holdings TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,             -- generated | validated | declined
      report TEXT NOT NULL,             -- JSON
      analyst_id INTEGER,
      analyst_note TEXT,
      reviewed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_advisory_user ON advisory_requests(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_advisory_status ON advisory_requests(status, created_at);
  `);
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
  addColumn(d, "news_items", "weight", "REAL NOT NULL DEFAULT 1");
  d.exec(`
    CREATE TABLE IF NOT EXISTS forecast_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      horizon TEXT NOT NULL,             -- 1W | 1M | 3M
      made_at INTEGER NOT NULL,          -- date de la bougie de référence
      made_day TEXT NOT NULL,            -- AAAA-MM-JJ (une prévision par jour, valeur et horizon)
      price REAL NOT NULL,
      expected_pct REAL NOT NULL,
      prob_up REAL NOT NULL,
      p5 REAL NOT NULL,
      p95 REAL NOT NULL,
      ridge_pct REAL NOT NULL,
      ar_pct REAL NOT NULL,
      news_adj_pct REAL NOT NULL,
      params_version INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'live',  -- live | backfill
      realized_pct REAL,
      hit INTEGER,
      abs_err REAL,
      covered INTEGER,
      resolved_at INTEGER,
      UNIQUE (symbol, horizon, made_day)
    );
    CREATE INDEX IF NOT EXISTS idx_forecast_log_open ON forecast_log(resolved_at, made_at);
    CREATE TABLE IF NOT EXISTS held_portfolios (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      label TEXT,
      cash REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS held_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      avg_price REAL,
      acquired_at INTEGER,
      note TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, symbol)
    );
    CREATE TABLE IF NOT EXISTS bonds (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      issuer TEXT NOT NULL,
      issuer_type TEXT NOT NULL,        -- souverain | supranational | entreprise
      country TEXT NOT NULL,
      coupon_pct REAL NOT NULL,
      issue_date TEXT NOT NULL,
      maturity_date TEXT NOT NULL,
      nominal REAL NOT NULL DEFAULT 10000,
      frequency INTEGER NOT NULL DEFAULT 1,
      amortization TEXT NOT NULL DEFAULT 'constant',
      grace_years INTEGER NOT NULL DEFAULT 0,
      tax_exempt INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      manual_price REAL,
      manual_price_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS company_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      period TEXT,
      url TEXT NOT NULL UNIQUE,
      published_at INTEGER,
      source TEXT NOT NULL,
      summary TEXT,
      fetched_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_company_documents_symbol ON company_documents(symbol, published_at);
    CREATE TABLE IF NOT EXISTS company_profiles (
      symbol TEXT PRIMARY KEY,
      free_float_pct REAL,
      main_holder_pct REAL,
      main_holder_name TEXT,
      state_pct REAL,
      shares_outstanding REAL,
      payout_ratio_pct REAL,
      dividend_years INTEGER,
      suspended INTEGER NOT NULL DEFAULT 0,
      suspended_reason TEXT,
      note TEXT,
      updated_by INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS radar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      symbol TEXT,
      title TEXT NOT NULL,
      detail TEXT,
      url TEXT,
      source TEXT NOT NULL,
      date INTEGER NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_radar_date ON radar_events(date);
    CREATE TABLE IF NOT EXISTS model_params (
      symbol TEXT NOT NULL,
      horizon TEXT NOT NULL,
      params TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (symbol, horizon)
    );
    CREATE TABLE IF NOT EXISTS corporate_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      kind TEXT NOT NULL,            -- split | reverse_split | bonus
      ex_date INTEGER NOT NULL,      -- début de journée UTC (ms)
      ratio REAL,
      status TEXT NOT NULL DEFAULT 'confirmé', -- confirmé | suspecté
      source TEXT NOT NULL,
      note TEXT,
      updated_by INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE (symbol, kind, ex_date)
    );
    CREATE TABLE IF NOT EXISTS dividends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      fiscal_year INTEGER NOT NULL,
      gross REAL,
      net REAL,
      ex_date INTEGER,
      payment_date INTEGER,
      agm_date INTEGER,
      status TEXT NOT NULL DEFAULT 'proposé', -- proposé | approuvé | payé
      source TEXT NOT NULL,
      url TEXT,
      note TEXT,
      updated_by INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE (symbol, fiscal_year)
    );
    CREATE TABLE IF NOT EXISTS daily_stats (
      symbol TEXT NOT NULL,
      ts INTEGER NOT NULL,           -- séance (début de journée UTC, ms)
      ref_price REAL,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      change_pct REAL,
      volume INTEGER,
      value REAL,
      trades INTEGER,
      bid REAL,
      bid_qty INTEGER,
      ask REAL,
      ask_qty INTEGER,
      reserved TEXT,                 -- up | down | null
      suspended INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (symbol, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_stats_ts ON daily_stats(ts);
    CREATE TABLE IF NOT EXISTS fundamentals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      period TEXT NOT NULL,            -- « 2025 », « S1 2025 », « T3 2025 »
      period_end INTEGER NOT NULL,     -- fin de période (ms UTC)
      published_at INTEGER,
      revenue REAL,
      net_income REAL,
      equity REAL,
      shares REAL,
      eps REAL,
      dps REAL,
      revenue_growth_pct REAL,
      net_income_growth_pct REAL,
      source TEXT NOT NULL,
      url TEXT,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'auto', -- auto | analyste
      updated_by INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE (symbol, period)
    );
    CREATE TABLE IF NOT EXISTS document_bodies (
      url TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      published_at INTEGER,
      text TEXT NOT NULL,             -- texte extrait (PDF ou HTML), tronqué à 60 000 caractères
      fetched_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_document_bodies_symbol ON document_bodies(symbol, fetched_at);
    CREATE TABLE IF NOT EXISTS llm_extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT,                        -- NULL pour un texte collé
      symbol TEXT,
      model TEXT NOT NULL,
      ts INTEGER NOT NULL,
      status TEXT NOT NULL,            -- ok | vide | refus | erreur
      result TEXT,                     -- JSON structuré renvoyé par le modèle
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      periods_saved INTEGER NOT NULL DEFAULT 0,
      events_saved INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_llm_extractions_ts ON llm_extractions(ts);
    CREATE INDEX IF NOT EXISTS idx_llm_extractions_url ON llm_extractions(url);
    CREATE TABLE IF NOT EXISTS evaluation_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      config TEXT NOT NULL,
      report TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recommended_portfolios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,               -- conseil | cible | manuel
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      start_ts INTEGER NOT NULL,        -- séance de départ (début de journée UTC)
      capital REAL NOT NULL,
      lines TEXT NOT NULL,              -- JSON [{symbol, weightPct, price, quantity, amount}]
      cash REAL NOT NULL,
      entry_cost REAL NOT NULL,
      source_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_recommended_user ON recommended_portfolios(user_id, created_at);
    CREATE TABLE IF NOT EXISTS model_portfolios (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      params TEXT NOT NULL,             -- JSON ModelParams
      current TEXT,                     -- JSON ModelVersion publiée
      proposal TEXT,                    -- JSON ModelVersion proposée par le moteur
      published_at INTEGER,
      proposed_at INTEGER,
      version INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'auto', -- auto | validated
      note TEXT,
      tracking_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS data_quality_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      score INTEGER NOT NULL,
      errors INTEGER NOT NULL,
      warnings INTEGER NOT NULL,
      infos INTEGER NOT NULL,
      report TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_reports (
      date INTEGER PRIMARY KEY,         -- début de journée UTC
      ts INTEGER NOT NULL,
      report TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      version INTEGER NOT NULL,
      published_at INTEGER NOT NULL,
      by_user INTEGER,
      note TEXT,
      snapshot TEXT NOT NULL,
      tracking_id INTEGER
    );
  `);
  addColumn(d, "held_positions", "asset_type", "TEXT NOT NULL DEFAULT 'equity'");
  addColumn(d, "forecast_log", "panel_pct", "REAL");
  addColumn(d, "candles", "source", "TEXT NOT NULL DEFAULT 'synthetic'"); // synthetic | live | official | sika
  addColumn(d, "daily_stats", "per", "REAL");
  addColumn(d, "daily_stats", "yield_pct", "REAL");
  addColumn(d, "daily_stats", "last_dividend", "REAL");
  addColumn(d, "daily_stats", "last_dividend_date", "INTEGER");
  addColumn(d, "daily_stats", "ytd_pct", "REAL");
  addColumn(d, "bonds", "source", "TEXT NOT NULL DEFAULT 'seed'");
  addColumn(d, "bonds", "dates_estimated", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "bonds", "quoted_pct", "REAL");
  addColumn(d, "bonds", "prev_pct", "REAL");
  addColumn(d, "bonds", "quoted_at", "INTEGER");
  addColumn(d, "bonds", "quote_source", "TEXT");
  addColumn(d, "bonds", "volume", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "bonds", "suspended", "INTEGER NOT NULL DEFAULT 0");
}

function addColumn(d: DB, table: string, column: string, definition: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
